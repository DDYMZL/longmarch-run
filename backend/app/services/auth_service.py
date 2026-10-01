"""微信登录服务（迁移自前端 services/auth.js）。

正式流程：wx.login -> code -> 后端调用微信 code2Session -> openid -> 建/查用户 -> 签发 JWT。
未配置 WX_APPID/WX_SECRET 时使用 mock openid（由 code 稳定派生），便于本地开发调试。
"""
import hashlib
from typing import Optional, Tuple

import httpx
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token
from app.models.models import User

WX_CODE2SESSION = "https://api.weixin.qq.com/sns/jscode2session"
DEFAULT_NICKNAME = "长征小战士"


def _mock_openid(code: str) -> str:
    """开发模式：由 code 派生稳定 mock openid。"""
    raw = (code or "dev").encode("utf-8")
    return "mock_" + hashlib.md5(raw).hexdigest()[:24]


def _code2session(code: str) -> Optional[str]:
    """调用微信接口用 code 换 openid；未配置凭证或失败时返回 None。"""
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
        return resp.json().get("openid")
    except Exception:
        return None


def wx_login(
    db: Session, code: str, nickname: str = "", avatar: str = ""
) -> Tuple[str, User]:
    """登录：换取 openid -> 建/查用户 -> 更新资料 -> 返回 (token, user)。"""
    openid = _code2session(code) or _mock_openid(code)

    user = db.query(User).filter(User.openid == openid).first()
    if user is None:
        user = User(
            openid=openid,
            nickname=nickname or DEFAULT_NICKNAME,
            avatar=avatar or None,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    else:
        changed = False
        if nickname and user.nickname != nickname:
            user.nickname = nickname
            changed = True
        if avatar and user.avatar != avatar:
            user.avatar = avatar
            changed = True
        if changed:
            db.commit()
            db.refresh(user)

    token = create_access_token(user.id, user.openid)
    return token, user
