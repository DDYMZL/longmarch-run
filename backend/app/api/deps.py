"""API 依赖：数据库会话、当前登录用户、管理员身份与菜单权限。"""
from typing import List, Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.database import get_db  # 在此重新导出，作为 API 层统一入口
from app.core.security import decode_token
from app.models.models import User
from app.services import access_service, activity_service, auth_service, invite_service


_bearer = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    """从 Bearer Token 解析当前登录用户，失败抛 401。"""
    if credentials is None or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录或令牌缺失"
        )
    payload = decode_token(credentials.credentials)
    if not payload or not payload.get("sub"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="令牌无效或已过期"
        )
    try:
        user_id = int(payload["sub"])
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="令牌无效"
        )
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在"
        )
    _ensure_active(user)
    return user


def _ensure_active(user: User) -> None:
    """停用账号即时断权：403 + X-Account-Status 头，前端据此清会话进入停用提示。"""
    if user.status != invite_service.STATUS_ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=auth_service.ACCOUNT_DISABLED_MESSAGE,
            headers={"X-Account-Status": "disabled"},
        )


def _activity_guard(need_participate: bool):
    """活动时间准入：先完成用户鉴权（401/停用 403 优先），再按活动状态拒绝。

    拒绝时 403 + X-Activity-Status 头（unpublished/not_started/ended），
    小程序据此跳转活动状态页；直接调接口同样被拦截。
    """

    def _check(
        user: User = Depends(get_current_user), db: Session = Depends(get_db)
    ) -> User:
        blocked = activity_service.check(db, need_participate)
        if blocked is not None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=blocked["message"],
                headers={"X-Activity-Status": blocked["status"]},
            )
        return user

    return _check


# 产生新业务数据（步数、答题、积分、勋章、点亮）的接口
require_activity_participation = _activity_guard(need_participate=True)
# 读取成绩/排行等活动数据的接口（结束后按 allow_view_after_end 放行）
require_activity_view = _activity_guard(need_participate=False)


class AdminPrincipal:
    """管理端身份主体。

    is_super：账号登录超管（typ=super，含历史无 typ 令牌），拥有全部菜单；
    微信关联管理员：user_id/roles/menus 每次请求查库获得，撤销即时生效。
    """

    def __init__(
        self,
        is_super: bool,
        username: str,
        user_id: Optional[int] = None,
        roles: Optional[List[str]] = None,
        menus: Optional[List[str]] = None,
    ):
        self.is_super = is_super
        self.username = username
        self.user_id = user_id
        self.roles = roles or []
        self.menus = menus or []

    def has_menu(self, code: str) -> bool:
        return self.is_super or code in self.menus


def get_current_admin(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
    db: Session = Depends(get_db),
) -> AdminPrincipal:
    """解析管理员身份。

    typ=super（或无 typ 的历史令牌）：账号登录超管，直接放行；
    typ=user：加载用户并查库校验启用角色，无授权返回 403（撤销/禁用即时生效）。
    """
    if credentials is None or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录或令牌缺失"
        )
    payload = decode_token(credentials.credentials)
    if not payload or payload.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="管理员令牌无效或已过期"
        )
    if payload.get("typ") != "user":
        # 超管令牌（typ=super）与改造前的历史令牌（无 typ）均视为超管
        return AdminPrincipal(is_super=True, username=str(payload.get("sub") or "admin"))
    try:
        user_id = int(payload["sub"])
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="管理员令牌无效"
        )
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="管理员账号不存在"
        )
    _ensure_active(user)
    principal_data = access_service.build_principal(db, user)
    if principal_data is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="后台访问权限已被撤销或禁用"
        )
    return AdminPrincipal(**principal_data)


def require_menu(code: str):
    """菜单权限依赖工厂：当前管理员无该菜单码时返回 403。"""

    def _check(admin: AdminPrincipal = Depends(get_current_admin)) -> AdminPrincipal:
        if not admin.has_menu(code):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="无该功能的访问权限"
            )
        return admin

    return _check
