"""微信登录与邀请码入驻服务。

登录：wx.login -> code -> 后端 code2Session -> openid -> 查已入驻用户 -> 签发 JWT（不建号）。
入驻：仅持 PC 后台生成的有效邀请码可建号（onboard），见 invite_service。
仅未配置 WX_APPID/WX_SECRET 时使用 mock openid（由 code 稳定派生），便于本地开发调试；
已配置凭证时微信换取失败一律拒绝登录，不回退 mock，避免产生"假登录"用户。
"""
import hashlib
from datetime import datetime
from typing import Optional, Tuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token
from app.core.wx import code2session
from app.models.models import User
from app.services import audit_service, identity_service, invite_service

LOGIN_ACTIVE = "active"
LOGIN_UNREGISTERED = "unregistered"
LOGIN_DISABLED = "disabled"
ACCOUNT_DISABLED_MESSAGE = "账号已停用，请联系活动管理员"


class WxLoginError(Exception):
    """微信 code 换取 openid 失败（code 无效/过期/微信服务异常）。"""


class AccountDisabledError(Exception):
    """账号已被后台停用。"""


def _mock_openid(code: str) -> str:
    """开发模式：由 code 派生稳定 mock openid。"""
    raw = (code or "dev").encode("utf-8")
    return "mock_" + hashlib.md5(raw).hexdigest()[:24]


def _resolve_openid(code: str) -> Tuple[str, dict]:
    """返回 (openid, 微信会话信息)；mock 模式会话信息为空字典。"""
    session_info = code2session(code)
    if session_info:
        return session_info["openid"], session_info
    if settings.WX_APPID and settings.WX_SECRET and not settings.WX_LOGIN_ALLOW_MOCK:
        raise WxLoginError("微信登录失败，请重试")
    return _mock_openid(code), {}


def _sign_in(db: Session, user: User, session_info: dict, avatar: str) -> str:
    """已入驻用户签发令牌：头像仅在传入时更新，真实微信响应时同步身份关联行。"""
    if avatar and user.avatar != avatar:
        user.avatar = avatar
        db.commit()
        db.refresh(user)
    if session_info:
        identity_service.ensure_wx_mini_identity(
            db, user, session_info["openid"], session_info.get("unionid")
        )
    return create_access_token(user.id, user.openid)


def _find_user(db: Session, openid: str) -> Optional[User]:
    return db.query(User).filter(User.openid == openid).first()


def wx_login(
    db: Session, code: str, avatar: str = ""
) -> Tuple[str, Optional[str], Optional[User]]:
    """登录：换取 openid -> 查已入驻用户，返回 (status, token, user)。

    不再自动建号：未入驻返回 unregistered、已停用返回 disabled，二者均不签发令牌。
    已入驻用户登录不校验原邀请码（过期/停用/用满不影响）。
    微信换取失败抛 WxLoginError（即「未识别」）。
    """
    openid, session_info = _resolve_openid(code)
    user = _find_user(db, openid)
    if user is None:
        return LOGIN_UNREGISTERED, None, None
    if user.status != invite_service.STATUS_ACTIVE:
        return LOGIN_DISABLED, None, None
    return LOGIN_ACTIVE, _sign_in(db, user, session_info, avatar), user


def _resume(db: Session, user: User, session_info: dict, avatar: str) -> Tuple[str, User, bool]:
    if user.status != invite_service.STATUS_ACTIVE:
        raise AccountDisabledError(ACCOUNT_DISABLED_MESSAGE)
    return _sign_in(db, user, session_info, avatar), user, False


def onboard(
    db: Session, code: str, invite_code: str, nickname: str, org_id: int, avatar: str = ""
) -> Tuple[str, User, bool]:
    """持邀请码入驻：校验邀请码与组织范围 -> 原子核销 -> 建号，同一事务提交。

    返回 (token, user, created)。幂等：该微信身份已入驻时直接签发令牌、不再核销
    （含中途退出后重新扫码、重复提交、并发提交）；并发撞 openid 唯一约束时回滚
    （核销随之撤销）并复用已建用户，保证一人一号、一次入驻只计一次。
    """
    openid, session_info = _resolve_openid(code)
    existing = _find_user(db, openid)
    if existing is not None:
        return _resume(db, existing, session_info, avatar)

    final_nickname = (nickname or "").strip()
    if not final_nickname:
        raise ValueError("请填写姓名")
    now = datetime.utcnow()
    try:
        invite = invite_service.get_usable(db, invite_code, now)
        invite_service.ensure_org_in_scope(db, invite, org_id)
        invite_id, invite_name = invite.id, invite.name
        if not invite_service.consume(db, invite_id, now):
            db.rollback()
            invite_service.get_usable(db, invite_code, datetime.utcnow())
            raise invite_service.InviteError("邀请码使用次数已满")
    except invite_service.InviteError:
        # 同一身份的并发请求可能已先入驻并核销，此时按已入驻复用而非报错
        db.rollback()
        existing = _find_user(db, openid)
        if existing is not None:
            return _resume(db, existing, session_info, avatar)
        raise

    user = User(
        openid=openid,
        nickname=final_nickname,
        original_nickname=final_nickname,
        avatar=avatar or None,
        org_id=org_id,
        status=invite_service.STATUS_ACTIVE,
        invite_code_id=invite_id,
        onboarded_at=now,
    )
    db.add(user)
    try:
        db.flush()
        audit_service.record(
            db, "user", user.id, "user.onboard", user.id,
            {"invite_id": invite_id, "invite_name": invite_name, "org_id": org_id},
        )
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = _find_user(db, openid)
        if existing is None:
            raise
        return _resume(db, existing, session_info, avatar)
    db.refresh(user)
    if session_info:
        identity_service.ensure_wx_mini_identity(
            db, user, session_info["openid"], session_info.get("unionid")
        )
    return create_access_token(user.id, user.openid), user, True


def update_nickname(db: Session, user: User, nickname: str) -> User:
    """修改昵称：每个用户仅允许一次，已修改过抛 ValueError。

    与当前昵称相同的修改视为无操作，不消耗唯一机会。
    """
    new_name = (nickname or "").strip()
    if not new_name:
        raise ValueError("昵称不能为空")
    if user.nickname_changed_at is not None:
        raise ValueError("昵称仅可修改一次，无法再次修改")
    if new_name == user.nickname:
        return user
    # 兼容未回填曾用名的存量用户：修改前先把当前昵称记为曾用名
    if not user.original_nickname:
        user.original_nickname = user.nickname
    user.nickname = new_name
    user.nickname_changed_at = datetime.utcnow()
    db.commit()
    db.refresh(user)
    return user


def set_initial_nickname(db: Session, user: User, nickname: str) -> User:
    """首次引导（组织选择）设置昵称：不消耗「每人仅一次」的改名机会。

    已使用过改名机会时拒绝覆盖，避免绕开唯一机会限制。
    """
    new_name = (nickname or "").strip()
    if not new_name:
        raise ValueError("昵称不能为空")
    if user.nickname_changed_at is not None:
        raise ValueError("昵称已修改过，无法覆盖")
    if new_name == user.nickname:
        return user
    user.nickname = new_name
    db.commit()
    db.refresh(user)
    return user
