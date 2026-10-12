"""入驻邀请码服务：后台生成/维护，小程序入驻校验与原子核销。

邀请码只决定「首次入驻」资格：已入驻用户登录不再校验原邀请码（过期/停用/用满不影响）。
核销使用带全部有效性条件的单条 UPDATE，按影响行数判定成功，并发下不会超发。
邀请码属于入驻凭证，不写入日志与审计明细（审计只记 id 与名称）。
"""
import re
import secrets
import string
from datetime import datetime
from typing import List, Optional, Tuple

from sqlalchemy import or_, update
from sqlalchemy.orm import Session

from app.models.models import InviteCode, Organization, User
from app.services import audit_service, org_service

CODE_ALPHABET = string.ascii_letters + string.digits
CODE_LENGTH = 16
SCENE_PREFIX = "i="
_CODE_PATTERN = re.compile(r"^[A-Za-z0-9]{1,32}$")

STATUS_ACTIVE = "active"
STATUS_DISABLED = "disabled"
USER_STATUSES = (STATUS_ACTIVE, STATUS_DISABLED)


class InviteError(ValueError):
    """邀请码不可用于入驻（无效/停用/过期/用满/组织越界）。"""


def generate_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def scene_of(code: str) -> str:
    return SCENE_PREFIX + code


def _check_usable(invite: Optional[InviteCode], now: datetime) -> InviteCode:
    if invite is None:
        raise InviteError("邀请码无效")
    if not invite.is_enabled:
        raise InviteError("邀请码已停用")
    if invite.expires_at is not None and invite.expires_at <= now:
        raise InviteError("邀请码已过期")
    if invite.max_uses is not None and invite.used_count >= invite.max_uses:
        raise InviteError("邀请码使用次数已满")
    return invite


def get_usable(db: Session, code: str, now: Optional[datetime] = None) -> InviteCode:
    """按码取可用邀请码（不核销）；格式非法与不存在同样返回「邀请码无效」。"""
    code = (code or "").strip()
    invite = (
        db.query(InviteCode).filter(InviteCode.code == code).first()
        if _CODE_PATTERN.match(code)
        else None
    )
    return _check_usable(invite, now or datetime.utcnow())


def _ensure_in_scope(db: Session, scope_org_id: Optional[int], org_id: int) -> None:
    """组织须存在；限定范围时另要求组织位于范围根的子树内（含自身）。"""
    path_ids = {node["id"] for node in org_service.get_path(db, org_id)}
    if not path_ids:
        raise InviteError("所选组织不存在")
    if scope_org_id is not None and scope_org_id not in path_ids:
        raise InviteError("所选组织不在邀请码允许的范围内")


def ensure_org_in_scope(db: Session, invite: InviteCode, org_id: int) -> None:
    _ensure_in_scope(db, invite.org_id, org_id)


def consume(db: Session, invite_id: int, now: datetime) -> bool:
    """原子核销一次（不提交）：有效性条件全部写在 WHERE 中，影响 1 行即成功。"""
    result = db.execute(
        update(InviteCode)
        .where(
            InviteCode.id == invite_id,
            InviteCode.is_enabled.is_(True),
            or_(InviteCode.max_uses.is_(None), InviteCode.used_count < InviteCode.max_uses),
            or_(InviteCode.expires_at.is_(None), InviteCode.expires_at > now),
        )
        .values(used_count=InviteCode.used_count + 1)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1


def user_scope_org(db: Session, user: User) -> Optional[Organization]:
    """用户可选组织范围的根（专属邀请码入驻用户）；历史用户与通用码用户返回 None。"""
    if user.invite_code_id is None:
        return None
    org_id = (
        db.query(InviteCode.org_id).filter(InviteCode.id == user.invite_code_id).scalar()
    )
    return org_service.get_org(db, org_id) if org_id is not None else None


def check_user_org_scope(db: Session, user: User, org_id: int) -> None:
    """已入驻用户改选组织时沿用其入驻邀请码的组织范围（历史用户不受限）。"""
    scope = user_scope_org(db, user)
    if scope is not None:
        _ensure_in_scope(db, scope.id, org_id)


# ---------------- 管理端维护 ----------------
def _org_names(db: Session, org_ids: set) -> dict:
    if not org_ids:
        return {}
    return dict(
        db.query(Organization.id, Organization.name).filter(Organization.id.in_(org_ids)).all()
    )


def _status_of(invite: InviteCode, now: datetime) -> str:
    try:
        _check_usable(invite, now)
    except InviteError:
        if not invite.is_enabled:
            return "disabled"
        if invite.expires_at is not None and invite.expires_at <= now:
            return "expired"
        return "exhausted"
    return "active"


def to_out(invite: InviteCode, org_name: Optional[str], now: Optional[datetime] = None) -> dict:
    return {
        "id": invite.id,
        "code": invite.code,
        "name": invite.name,
        "remark": invite.remark,
        "org_id": invite.org_id,
        "org_name": org_name,
        "max_uses": invite.max_uses,
        "used_count": invite.used_count,
        "expires_at": invite.expires_at,
        "is_enabled": invite.is_enabled,
        "status": _status_of(invite, now or datetime.utcnow()),
        "created_by": invite.created_by,
        "created_at": invite.created_at,
    }


def list_invites(
    db: Session, page: int, page_size: int, keyword: str = ""
) -> Tuple[int, List[dict]]:
    query = db.query(InviteCode)
    if keyword:
        query = query.filter(InviteCode.name.icontains(keyword, autoescape=True))
    total = query.count()
    rows = (
        query.order_by(InviteCode.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    names = _org_names(db, {row.org_id for row in rows if row.org_id is not None})
    now = datetime.utcnow()
    return total, [to_out(row, names.get(row.org_id), now) for row in rows]


def _validate_fields(db: Session, org_id: Optional[int], max_uses: Optional[int]) -> None:
    if org_id is not None and org_service.get_org(db, org_id) is None:
        raise ValueError("组织不存在")
    if max_uses is not None and max_uses < 1:
        raise ValueError("使用次数上限须大于 0")


def _invite_or_error(db: Session, invite_id: int) -> InviteCode:
    invite = db.query(InviteCode).filter(InviteCode.id == invite_id).first()
    if invite is None:
        raise ValueError("邀请码不存在")
    return invite


def create_invite(
    db: Session, fields: dict, actor_type: str, actor_id: Optional[int], actor_name: str
) -> dict:
    _validate_fields(db, fields.get("org_id"), fields.get("max_uses"))
    invite = InviteCode(code=generate_code(), created_by=actor_name, **fields)
    db.add(invite)
    db.flush()
    audit_service.record(
        db, actor_type, actor_id, "invite.create", None,
        {"invite_id": invite.id, "name": invite.name},
    )
    db.commit()
    db.refresh(invite)
    return to_out(invite, _org_names(db, {invite.org_id}).get(invite.org_id))


def update_invite(
    db: Session, invite_id: int, fields: dict, actor_type: str, actor_id: Optional[int]
) -> dict:
    """部分更新（名称/备注/组织/上限/有效期/启停）；上限不得低于已使用次数。"""
    invite = _invite_or_error(db, invite_id)
    org_id = fields.get("org_id", invite.org_id)
    max_uses = fields.get("max_uses", invite.max_uses)
    _validate_fields(db, org_id, max_uses)
    if max_uses is not None and max_uses < invite.used_count:
        raise ValueError(f"使用次数上限不能低于已使用次数（{invite.used_count}）")
    for key, value in fields.items():
        setattr(invite, key, value)
    invite.updated_at = datetime.utcnow()
    audit_service.record(
        db, actor_type, actor_id, "invite.update", None,
        {"invite_id": invite.id, "name": invite.name, "fields": sorted(fields)},
    )
    db.commit()
    db.refresh(invite)
    return to_out(invite, _org_names(db, {invite.org_id}).get(invite.org_id))


def get_invite(db: Session, invite_id: int) -> InviteCode:
    return _invite_or_error(db, invite_id)


def set_user_status(
    db: Session, user_id: int, status: str, actor_type: str, actor_id: Optional[int]
) -> User:
    """启用/停用用户（停用即时生效：受保护接口每请求查库校验）。"""
    if status not in USER_STATUSES:
        raise ValueError("无效的用户状态")
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise ValueError("用户不存在")
    if user.status != status:
        user.status = status
        audit_service.record(
            db, actor_type, actor_id,
            "user.enable" if status == STATUS_ACTIVE else "user.disable",
            user_id, None,
        )
        db.commit()
        db.refresh(user)
    return user
