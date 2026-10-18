"""鉴权路由：微信登录、邀请码校验与入驻、当前用户、昵称修改、头像上传。"""
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core import rate_limit
from app.core import ws as ws_manager
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import (
    InviteVerifyOut,
    InviteVerifyRequest,
    LoginRequest,
    LoginResponse,
    NicknameUpdateRequest,
    OnboardRequest,
    OnboardResponse,
    UserOut,
)
from app.services import auth_service, event_service, invite_service, org_service, upload_service

router = APIRouter(tags=["auth"])


def _after_sign_in(user: User, event: str) -> None:
    ws_manager.broadcast(ws_manager.build_event(event, user.id))


def _record_first_login(db: Session, user: User) -> None:
    """新用户首次登录埋点（FIRST_LOGIN，一次性去重）。

    分析型事件：仅供邀请漏斗统计（点13），不进入实时动态流、不 WS 广播；
    埋点失败不得影响登录主流程。事件时间用 user.created_at（#21），使漏斗按注册时刻
    归因而非首次触发登录的时刻；并发下由 025 迁移的 FIRST_LOGIN 部分唯一索引兜底，
    命中唯一约束（IntegrityError）视为已记录，回滚后静默忽略。
    """
    try:
        if not event_service.has_event(db, user.id, event_service.FIRST_LOGIN):
            event_service.record(
                db, user.id, event_service.FIRST_LOGIN,
                {"nickname": user.nickname}, event_time=user.created_at,
            )
    except IntegrityError:  # 并发重复：部分唯一索引拦截，视为已记录
        db.rollback()
    except Exception:  # pragma: no cover - 埋点降级保护，绝不影响登录
        db.rollback()


@router.post("/auth/login", response_model=LoginResponse, summary="微信登录（仅已入驻用户签发令牌）")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    """用 wx.login 的 code 识别微信身份；不自动建号。

    已入驻（active）返回 token/user；未入驻返回
    status=unregistered、已停用返回 status=disabled，均不签发令牌。
    微信换取失败返回 502（未识别）。
    """
    try:
        status, token, user = auth_service.wx_login(db, payload.code, payload.avatar or "")
    except auth_service.WxLoginError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    if user is None:
        return LoginResponse(status=status)
    _after_sign_in(user, "auth.login")
    _record_first_login(db, user)
    return LoginResponse(status=status, token=token, user=UserOut.model_validate(user))


@router.post("/auth/invite/verify", response_model=InviteVerifyOut, summary="校验入驻邀请码（不核销）")
def verify_invite(payload: InviteVerifyRequest, request: Request, db: Session = Depends(get_db)):
    """邀请码不可用返回 400（无效/停用/过期/用满）；不返回邀请码本身与使用次数。"""
    rate_limit.require_rate(rate_limit.invite_limiter, request, "操作过于频繁，请稍后再试")
    try:
        invite = invite_service.get_usable(db, payload.invite_code)
    except invite_service.InviteError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    org = org_service.get_org(db, invite.org_id) if invite.org_id is not None else None
    # 邀请漏斗埋点（点13）：匿名扫码校验事件，仅供运营统计（按邀请码分组），埋点失败不影响校验。
    try:
        event_service.record(
            db, None, event_service.INVITE_SCAN,
            {"invite_id": invite.id, "invite_name": invite.name, "org_id": invite.org_id},
        )
    except Exception:  # pragma: no cover - 埋点降级保护，绝不影响邀请校验
        db.rollback()
    return InviteVerifyOut(
        name=invite.name,
        org_id=org.id if org else None,
        org_name=org.name if org else None,
    )


@router.post("/auth/onboard", response_model=OnboardResponse, summary="持邀请码入驻（建号并签发令牌）")
def onboard(payload: OnboardRequest, request: Request, db: Session = Depends(get_db)):
    """校验邀请码与组织范围、原子核销并建号；已入驻身份重复提交直接返回令牌（幂等）。

    邀请码不可用或组织越界返回 400；账号已停用 403；微信换取失败 502。
    """
    rate_limit.require_rate(rate_limit.invite_limiter, request, "操作过于频繁，请稍后再试")
    try:
        token, user, created = auth_service.onboard(
            db, payload.code, payload.invite_code, payload.nickname,
            payload.org_id, payload.avatar or "",
        )
    except auth_service.WxLoginError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except auth_service.AccountDisabledError as exc:
        raise HTTPException(
            status_code=403, detail=str(exc), headers={"X-Account-Status": "disabled"}
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    _after_sign_in(user, "auth.onboard" if created else "auth.login")
    _record_first_login(db, user)
    return OnboardResponse(token=token, user=UserOut.model_validate(user), created=created)


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


@router.post("/auth/avatar", response_model=UserOut, summary="上传并更新个人头像")
async def upload_avatar(
    request: Request,
    file: UploadFile = File(...),
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """接收 multipart 字段 file，落盘后写库并广播；不重签 token，返回最新 UserOut。

    仅支持 jpg/jpeg/png/webp，大小上限见 settings.AVATAR_MAX_BYTES；不合法返回 400。
    分块读取（#5）：累计超限立即中断，不整块 await file.read() 入内存，防内存放大 DoS。
    """
    try:
        content = await upload_service.read_within_limit(file)
        upload_service.save_avatar(
            db, current, content, file.filename, str(request.base_url)
        )
    except upload_service.UploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    ws_manager.broadcast(ws_manager.build_event("auth.avatar", current.id))
    return UserOut.model_validate(current)


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
