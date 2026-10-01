"""鉴权路由：微信登录、当前用户、昵称修改。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core import ws as ws_manager
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import (
    LoginRequest,
    LoginResponse,
    NicknameUpdateRequest,
    UserOut,
)
from app.services import auth_service, points_service

router = APIRouter(tags=["auth"])


@router.post("/auth/login", response_model=LoginResponse, summary="微信登录")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    """用 wx.login 的 code 换取用户与 JWT，并顺带发放每日登录积分（同日去重）。"""
    token, user = auth_service.wx_login(
        db, payload.code, payload.nickname or "", payload.avatar or ""
    )
    points_service.grant_daily_login(db, user.id)
    ws_manager.broadcast(ws_manager.build_event("auth.login", user.id))
    return LoginResponse(token=token, user=UserOut.model_validate(user))


@router.get("/auth/me", response_model=UserOut, summary="当前登录用户信息")
def me(current: User = Depends(get_current_user)):
    return UserOut.model_validate(current)


@router.put("/auth/nickname", response_model=UserOut, summary="修改昵称（每人仅一次）")
def update_nickname(
    payload: NicknameUpdateRequest,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """修改个人昵称；已使用过唯一一次机会时返回 400。"""
    try:
        user = auth_service.update_nickname(db, current, payload.nickname)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    ws_manager.broadcast(ws_manager.build_event("auth.nickname", user.id))
    return UserOut.model_validate(user)


@router.put(
    "/auth/nickname/initial",
    response_model=UserOut,
    summary="首次引导设置昵称（不消耗改名机会）",
)
def set_initial_nickname(
    payload: NicknameUpdateRequest,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """新用户首次进入（组织选择）时设置昵称，不占用「每人仅一次」的改名机会。"""
    try:
        user = auth_service.set_initial_nickname(db, current, payload.nickname)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    ws_manager.broadcast(ws_manager.build_event("auth.nickname", user.id))
    return UserOut.model_validate(user)
