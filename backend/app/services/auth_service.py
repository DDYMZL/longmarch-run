"""微信登录服务（迁移自前端 services/auth.js）。

正式流程：wx.login -> code -> 后端调用微信 code2Session -> openid -> 建/查用户 -> 签发 JWT。
未配置 WX_APPID/WX_SECRET 时使用 mock openid（由 code 稳定派生），便于本地开发调试。
"""
import hashlib
from datetime import datetime
from typing import Optional, Tuple

import httpx
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token
from app.models.models import User
from app.services import identity_service

WX_CODE2SESSION = "https://api.weixin.qq.com/sns/jscode2session"
DEFAULT_NICKNAME = "长征小战士"


def _mock_openid(code: str) -> str:
    """开发模式：由 code 派生稳定 mock openid。"""
    raw = (code or "dev").encode("utf-8")
    return "mock_" + hashlib.md5(raw).hexdigest()[:24]


def _code2session(code: str) -> Optional[dict]:
    """调用微信接口用 code 换 openid/unionid；未配置凭证或失败时返回 None。

    session_key 不落库、不写日志，取到即弃（当前无 WeRun 解密需求）。
    """
    if not settings.WX_APPID or not settings.WX_SECRET:
        return None
    try:
        resp = httpx.get(
            WX_CODE2SESSION,
            params={
                "appid": settings.WX_APPID,
                "secret": settings.WX_SECRET,
                "js_code": code,
                "grant_type": "authorization_code",
            },
            timeout=5.0,
        )
        data = resp.json()
        if not data.get("openid"):
            return None
        return {"openid": data["openid"], "unionid": data.get("unionid")}
    except Exception:
        return None


def wx_login(
    db: Session, code: str, nickname: str = "", avatar: str = ""
) -> Tuple[str, User]:
    """登录：换取 openid -> 建/查用户 -> 返回 (token, user)。

    昵称仅在首次创建时写入（并记作曾用名 original_nickname），后续登录
    不再覆盖昵称——改名只能在应用内通过 update_nickname 完成且仅一次。
    头像允许随每次微信登录更新。
    真实微信响应时同步写入身份关联行（user_identities，provider=wx_mini）。
    """
    session_info = _code2session(code)
    openid = (session_info or {}).get("openid") or _mock_openid(code)

    user = db.query(User).filter(User.openid == openid).first()
    if user is None:
        final_nickname = (nickname or "").strip() or DEFAULT_NICKNAME
        user = User(
            openid=openid,
            nickname=final_nickname,
            original_nickname=final_nickname,
            avatar=avatar or None,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    else:
        changed = False
        if avatar and user.avatar != avatar:
            user.avatar = avatar
            changed = True
        if changed:
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
