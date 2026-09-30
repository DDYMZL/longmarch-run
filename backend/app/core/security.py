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


def decode_token(token: str) -> Optional[dict]:
    """解析令牌，失败（过期/篡改）返回 None。"""
    try:
        return jwt.decode(
            token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM]
        )
    except jwt.PyJWTError:
        return None
