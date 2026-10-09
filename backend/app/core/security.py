"""安全相关：JWT 令牌的签发与校验。"""
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt

from app.core.config import settings


def create_access_token(user_id: int, openid: str) -> str:
    """签发访问令牌，sub 存放用户主键 id。"""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "openid": openid,
        "iat": now,
        "exp": now + timedelta(minutes=settings.JWT_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def create_admin_token(username: str) -> str:
    """签发超管令牌（账号登录），typ=super 区分微信关联管理员，sub 存用户名。"""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": username,
        "role": "admin",
        "typ": "super",
        "iat": now,
        "exp": now + timedelta(minutes=settings.JWT_ADMIN_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def create_admin_token_for_user(user_id: int) -> str:
    """签发微信关联管理员令牌，typ=user、sub 存用户主键。

    权限不写入令牌：get_current_admin 每次请求查库校验，撤销即时生效；
    12 小时有效期仅作兜底。
    """
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "role": "admin",
        "typ": "user",
        "iat": now,
        "exp": now + timedelta(minutes=settings.JWT_ADMIN_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    """解析令牌，失败（过期/篡改）返回 None。"""
    try:
        return jwt.decode(
            token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM]
        )
    except jwt.PyJWTError:
        return None
