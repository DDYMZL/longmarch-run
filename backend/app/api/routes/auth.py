"""鉴权路由：微信登录、当前用户。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import LoginRequest, LoginResponse, UserOut
from app.services import auth_service, points_service

router = APIRouter(tags=["auth"])


@router.post("/auth/login", response_model=LoginResponse, summary="微信登录")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    """用 wx.login 的 code 换取用户与 JWT，并顺带发放每日登录积分（同日去重）。"""
    token, user = auth_service.wx_login(
        db, payload.code, payload.nickname or "", payload.avatar or ""
    )
    points_service.grant_daily_login(db, user.id)
    return LoginResponse(token=token, user=UserOut.model_validate(user))


@router.get("/auth/me", response_model=UserOut, summary="当前登录用户信息")
def me(current: User = Depends(get_current_user)):
    return UserOut.model_validate(current)
