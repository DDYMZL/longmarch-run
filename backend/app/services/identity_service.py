"""身份关联与扫码登录服务（docs/identity-binding-design.md）。

职责：PC 扫码登录会话（创建/轮询/确认/取消）、身份绑定事务、身份列表与
解绑、登录时 wx_mini 身份同步。安全要点：
- 绑定凭证与扫码凭证只存 SHA-256 摘要，明文不落库；
- qrId（轮询凭证）与 scene（扫码凭证）分离，互不可推导；
- 「一个 unionid 只属一个用户」在事务内校验，冲突身份禁止自动合并。
"""
import hashlib
import json
import secrets
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.models import BindRequest, QrLoginSession, UserIdentity
from app.services import audit_service

PROVIDER_WX_MINI = "wx_mini"

STATUS_PENDING = "pending"
STATUS_SCANNED = "scanned"
STATUS_CONFIRMED = "confirmed"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"
STATUS_USED = "used"

FAIL_NO_ACCESS = "无后台访问权限，请联系管理员授权"


def _sha256(raw: str) -> str:
    return hashlib.sha256((raw or "").encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.utcnow()


# ---------------- PC 扫码登录会话 ----------------
def create_login_session(db: Session) -> Tuple[QrLoginSession, str]:
    """创建扫码登录会话，返回（会话, 明文 scene 凭证）。scene 格式 L{token}（≤32 字符）。"""
    scene_token = "L" + secrets.token_urlsafe(16)
    session = QrLoginSession(
        id=secrets.token_urlsafe(18),
        scene_token_hash=_sha256(scene_token),
        status=STATUS_PENDING,
        expires_at=_now() + timedelta(seconds=settings.QR_LOGIN_TTL_SECONDS),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session, scene_token


def get_login_session(db: Session, scene: str) -> Optional[QrLoginSession]:
    """按明文 scene 凭证查找会话；不存在或已过期返回 None（过期置 expired）。"""
    session = (
        db.query(QrLoginSession)
        .filter(QrLoginSession.scene_token_hash == _sha256(scene))
        .first()
    )
    if session is None:
        return None
    if session.status == STATUS_PENDING and session.expires_at < _now():
        session.status = "expired"
        db.commit()
        return None
    return session


def poll_login_session(db: Session, qr_id: str) -> Optional[QrLoginSession]:
    """轮询会话状态；未确认且已过期的会话惰性置 expired。"""
    session = db.query(QrLoginSession).filter(QrLoginSession.id == qr_id).first()
    if session is None:
        return None
    if session.status == STATUS_PENDING and session.expires_at < _now():
        session.status = "expired"
        db.commit()
    return session


def mark_scanned(db: Session, session: QrLoginSession) -> None:
    """小程序打开确认页时置 scanned（仅 pending 可转）。"""
    if session.status == STATUS_PENDING:
        session.status = STATUS_SCANNED
        db.commit()


def cancel_login(db: Session, session: QrLoginSession) -> None:
    """用户在确认页取消登录。"""
    if session.status in (STATUS_PENDING, STATUS_SCANNED):
        session.status = STATUS_CANCELLED
        db.commit()


def confirm_login(db: Session, session: QrLoginSession, user) -> str:
    """确认 PC 登录：校验会话状态与用户后台授权。

    凭证/状态非法抛 ValueError（路由转 400）；无后台权限返回失败原因
    （路由转 403，会话置 failed 供 PC 端展示）。
    """
    if session.status not in (STATUS_PENDING, STATUS_SCANNED):
        raise ValueError("扫码凭证已使用或已失效")
    from app.services import access_service

    if not access_service.get_enabled_roles(db, user.id):
        session.status = STATUS_FAILED
        session.fail_reason = FAIL_NO_ACCESS
        db.commit()
        return FAIL_NO_ACCESS
    session.status = STATUS_CONFIRMED
    session.user_id = user.id
    session.confirmed_at = _now()
    audit_service.record(db, "user", user.id, "admin.login.qr", user.id, None)
    db.commit()
    return ""


def issue_admin_token(db: Session, qr_id: str) -> Optional[Tuple[QrLoginSession, object]]:
    """原子地消费「单次签发」标记并返回（会话, 用户）；已被签发过返回 None。

    用 UPDATE ... WHERE token_issued = false 保证并发轮询下只签发一次。
    """
    updated = (
        db.query(QrLoginSession)
        .filter(QrLoginSession.id == qr_id, QrLoginSession.token_issued.is_(False))
        .update({"token_issued": True}, synchronize_session=False)
    )
    db.commit()
    if not updated:
        return None
    session = db.query(QrLoginSession).filter(QrLoginSession.id == qr_id).first()
    if session is None or session.user_id is None:
        return None
    from app.models.models import User

    user = db.query(User).filter(User.id == session.user_id).first()
    return (session, user)


# ---------------- 身份绑定（渠道 wx_web 阶段2，表与确认流程本期就绪） ----------------
def get_bind_request(db: Session, scene: str) -> Optional[BindRequest]:
    """按明文 scene 凭证（格式 B{token}）查找绑定请求；不存在或已过期返回 None。"""
    if not (scene or "").startswith("B"):
        return None
    request = (
        db.query(BindRequest)
        .filter(BindRequest.token_hash == _sha256(scene[1:]))
        .first()
    )
    if request is None:
        return None
    if request.status == STATUS_PENDING and request.expires_at < _now():
        request.status = "expired"
        db.commit()
        return None
    return request


def cancel_bind(db: Session, request: BindRequest) -> None:
    """取消绑定请求。"""
    if request.status == STATUS_PENDING:
        request.status = STATUS_CANCELLED
        db.commit()


def confirm_bind(db: Session, request: BindRequest, user) -> None:
    """绑定确认事务：凭证校验 → 身份唯一性检查 → 写身份行 → 消费凭证 → 审计。

    校验失败抛 ValueError（重复绑定 / 身份已属他人 / unionid 冲突均拒绝，
    禁止自动覆盖或合并）。
    """
    if request.status != STATUS_PENDING:
        raise ValueError("绑定凭证已使用或已取消")
    # 同一微信身份已绑其他系统用户 → 拒绝
    other = (
        db.query(UserIdentity)
        .filter(
            UserIdentity.provider == request.provider,
            UserIdentity.app_id == request.app_id,
            UserIdentity.openid == request.openid,
            UserIdentity.user_id != user.id,
        )
        .first()
    )
    if other is not None:
        raise ValueError("该微信身份已绑定其他账号，禁止合并")
    # 同一用户同渠道已绑定 → 拒绝重复绑定
    existing = (
        db.query(UserIdentity)
        .filter(
            UserIdentity.user_id == user.id,
            UserIdentity.provider == request.provider,
            UserIdentity.app_id == request.app_id,
        )
        .first()
    )
    if existing is not None:
        raise ValueError("该渠道身份已绑定当前账号，无需重复绑定")
    # unionid 一人规则：同 unionid 已属他人 → 拒绝
    if request.unionid:
        holders = (
            db.query(UserIdentity)
            .filter(UserIdentity.unionid == request.unionid)
            .all()
        )
        if any(holder.user_id != user.id for holder in holders):
            raise ValueError("UnionID 已关联其他账号，禁止自动合并")

    now = _now()
    db.add(
        UserIdentity(
            user_id=user.id,
            provider=request.provider,
            app_id=request.app_id,
            openid=request.openid,
            unionid=request.unionid,
            verified_at=now,
        )
    )
    request.status = STATUS_USED
    request.user_id = user.id
    request.used_at = now
    request.confirmed_at = now
    audit_service.record(
        db,
        "user",
        user.id,
        "identity.bind.confirm",
        user.id,
        {"provider": request.provider, "app_id": request.app_id},
    )
    db.commit()


# ---------------- 身份列表与解绑 ----------------
def list_identities(db: Session, user_id: int) -> List[UserIdentity]:
    """当前用户已绑定身份（按 id 升序）。"""
    return (
        db.query(UserIdentity)
        .filter(UserIdentity.user_id == user_id)
        .order_by(UserIdentity.id)
        .all()
    )


def unbind(db: Session, user, identity_id: int) -> None:
    """解绑身份；wx_mini 为登录凭证不可解绑；非本人身份视为不存在。"""
    identity = db.query(UserIdentity).filter(UserIdentity.id == identity_id).first()
    if identity is None or identity.user_id != user.id:
        raise ValueError("身份不存在")
    if identity.provider == PROVIDER_WX_MINI:
        raise ValueError("微信登录凭证不可解绑")
    detail = {"provider": identity.provider, "app_id": identity.app_id}
    db.delete(identity)
    audit_service.record(db, "user", user.id, "identity.unbind", user.id, detail)
    db.commit()


# ---------------- 登录时身份同步 ----------------
def ensure_wx_mini_identity(db: Session, user, openid: str, unionid: Optional[str]) -> None:
    """登录成功后同步 wx_mini 身份行（幂等）。

    仅真实微信响应（非 mock）调用；unionid 已属他人时不合并、不写入。
    """
    existing = (
        db.query(UserIdentity)
        .filter(
            UserIdentity.user_id == user.id,
            UserIdentity.provider == PROVIDER_WX_MINI,
        )
        .first()
    )
    now = _now()
    if existing is not None:
        if unionid and not existing.unionid:
            conflict = (
                db.query(UserIdentity)
                .filter(UserIdentity.unionid == unionid, UserIdentity.user_id != user.id)
                .first()
            )
            if conflict is None:
                existing.unionid = unionid
        existing.verified_at = now
        existing.updated_at = now
        db.commit()
        return
    safe_unionid = unionid
    if unionid:
        conflict = (
            db.query(UserIdentity)
            .filter(UserIdentity.unionid == unionid, UserIdentity.user_id != user.id)
            .first()
        )
        if conflict is not None:
            safe_unionid = None
    db.add(
        UserIdentity(
            user_id=user.id,
            provider=PROVIDER_WX_MINI,
            app_id=settings.WX_APPID,
            openid=openid,
            unionid=safe_unionid,
            verified_at=now,
        )
    )
    try:
        db.commit()
    except IntegrityError:
        # 并发登录竞态：身份行已由同用户另一请求写入，回滚即可
        db.rollback()
