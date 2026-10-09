"""身份关联路由：扫码确认（登录/绑定）、身份列表与解绑。

小程序侧契约（camelCase）；除本文件外小程序用户路由见 routes/auth.py。
场景凭证格式：L{token} 登录确认 / B{token} 绑定确认（仅后端可生成）。
"""
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import (
    IdentityOut,
    MessageOut,
    QrConfirmRequest,
    QrInfoOut,
    QrInfoRequest,
    QrInfoTarget,
)
from app.services import identity_service

router = APIRouter(tags=["identity"])


@router.post("/auth/qr/info", response_model=QrInfoOut, summary="查询扫码场景详情")
def qr_info(
    payload: QrInfoRequest,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """小程序打开确认页时查询场景：登录确认置 scanned；凭证不存在/过期返回 404。"""
    scene = payload.scene
    if scene.startswith("L"):
        session = identity_service.get_login_session(db, scene)
        if session is None:
            raise HTTPException(status_code=404, detail="扫码凭证不存在或已过期")
        identity_service.mark_scanned(db, session)
        return QrInfoOut(type="login", status=session.status, expires_at=session.expires_at)
    if scene.startswith("B"):
        request = identity_service.get_bind_request(db, scene)
        if request is None:
            raise HTTPException(status_code=404, detail="绑定凭证不存在或已过期")
        return QrInfoOut(
            type="bind",
            status=request.status,
            target=QrInfoTarget(provider=request.provider, app_id=request.app_id),
            expires_at=request.expires_at,
        )
    raise HTTPException(status_code=400, detail="无效的扫码场景")


@router.post("/auth/qr/confirm", response_model=MessageOut, summary="确认或取消扫码请求")
def qr_confirm(
    payload: QrConfirmRequest,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """登录确认：无后台权限返回 403（会话置 failed，PC 端可展示原因）；
    绑定确认：凭证/身份唯一性校验失败返回 400。取消仅对 pending/scanned 生效。"""
    scene = payload.scene
    try:
        if scene.startswith("L"):
            session = identity_service.get_login_session(db, scene)
            if session is None:
                raise HTTPException(status_code=404, detail="扫码凭证不存在或已过期")
            if payload.action == "cancel":
                identity_service.cancel_login(db, session)
                return MessageOut(message="已取消")
            reason = identity_service.confirm_login(db, session, current)
            if reason:
                raise HTTPException(status_code=403, detail=reason)
            return MessageOut(message="登录已确认")
        if scene.startswith("B"):
            request = identity_service.get_bind_request(db, scene)
            if request is None:
                raise HTTPException(status_code=404, detail="绑定凭证不存在或已过期")
            if payload.action == "cancel":
                identity_service.cancel_bind(db, request)
                return MessageOut(message="已取消")
            identity_service.confirm_bind(db, request, current)
            return MessageOut(message="绑定成功")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    raise HTTPException(status_code=400, detail="无效的扫码场景")


@router.get(
    "/auth/identities",
    response_model=List[IdentityOut],
    summary="当前用户已绑定身份列表",
)
def identities(
    current: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    rows = identity_service.list_identities(db, current.id)
    return [IdentityOut.model_validate(row) for row in rows]


@router.delete(
    "/auth/identities/{identity_id}",
    response_model=MessageOut,
    summary="解绑身份（微信登录凭证不可解绑）",
)
def unbind(
    identity_id: int,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        identity_service.unbind(db, current, identity_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return MessageOut(message="已解绑")
