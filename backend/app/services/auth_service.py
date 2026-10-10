"""微信登录服务（迁移自前端 services/auth.js）。

正式流程：wx.login -> code -> 后端调用微信 code2Session -> openid -> 建/查用户 -> 签发 JWT。
仅未配置 WX_APPID/WX_SECRET 时使用 mock openid（由 code 稳定派生），便于本地开发调试；
已配置凭证时微信换取失败一律拒绝登录，不回退 mock，避免产生"假登录"用户。
"""
import hashlib
from datetime import datetime
from typing import Tuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token
from app.core.wx import code2session
from app.models.models import User
from app.services import identity_service

DEFAULT_NICKNAME = "长征小战士"


class WxLoginError(Exception):
    """微信 code 换取 openid 失败（code 无效/过期/微信服务异常）。"""


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


def _get_or_create_user(db: Session, openid: str, nickname: str, avatar: str) -> User:
    """按 openid 查/建用户；并发首登撞唯一约束时回滚并复用已创建的用户。"""
    user = db.query(User).filter(User.openid == openid).first()
    if user is not None:
        return user
    final_nickname = (nickname or "").strip() or DEFAULT_NICKNAME
    user = User(
        openid=openid,
        nickname=final_nickname,
        original_nickname=final_nickname,
        avatar=avatar or None,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return db.query(User).filter(User.openid == openid).one()
    db.refresh(user)
    return user


def wx_login(
    db: Session, code: str, nickname: str = "", avatar: str = ""
) -> Tuple[str, User]:
    """登录：换取 openid -> 建/查用户 -> 返回 (token, user)。

    昵称仅在首次创建时写入（并记作曾用名 original_nickname），后续登录
    不再覆盖昵称——改名只能在应用内通过 update_nickname 完成且仅一次。
    头像仅在传入时更新（静默登录不传，不会清空）；组织与业务数据不受登录影响。
    真实微信响应时同步写入身份关联行（user_identities，provider=wx_mini）。
    微信换取失败抛 WxLoginError。
    """
    openid, session_info = _resolve_openid(code)

    user = _get_or_create_user(db, openid, nickname, avatar)
    if avatar and user.avatar != avatar:
        user.avatar = avatar
        db.commit()
        db.refresh(user)

    if session_info:
        identity_service.ensure_wx_mini_identity(
            db, user, session_info["openid"], session_info.get("unionid")
        )

    token = create_access_token(user.id, user.openid)
    return token, user


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
