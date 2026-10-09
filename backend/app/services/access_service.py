"""后台访问授权服务（RBAC：查询 + 人员授权/角色管理 + 审计）。

授权模型：用户至少拥有 1 个启用角色即可访问后台；菜单取启用角色的并集。
超级管理员（账号登录）不走角色体系，拥有全部菜单。
"""
import secrets
from collections import defaultdict
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.models import (
    AdminMenu,
    AdminRole,
    AdminRoleMenu,
    AdminUserRole,
    AuditLog,
    Organization,
    User,
)
from app.services import audit_service

ALL_MENU_CODES = [
    "dashboard",
    "screen",
    "rankings",
    "route_nodes",
    "questions",
    "quotes",
    "orgs",
    "access",
    "audit",
]

ACTOR_SUPER = "super"
ACTOR_USER = "user"


def get_enabled_roles(db: Session, user_id: int) -> List[AdminRole]:
    """用户的启用角色列表（禁用角色不计入）。"""
    return (
        db.query(AdminRole)
        .join(AdminUserRole, AdminUserRole.role_id == AdminRole.id)
        .filter(AdminUserRole.user_id == user_id, AdminUserRole.enabled.is_(True))
        .all()
    )


def get_menu_codes(db: Session, role_ids: List[int]) -> List[str]:
    """角色集合的菜单码并集（按菜单排序）。"""
    if not role_ids:
        return []
    rows = (
        db.query(AdminMenu.code)
        .join(AdminRoleMenu, AdminRoleMenu.menu_id == AdminMenu.id)
        .filter(AdminRoleMenu.role_id.in_(role_ids))
        .order_by(AdminMenu.sort_order)
        .all()
    )
    return [row[0] for row in rows]


def get_menu_items(db: Session, codes: List[str]) -> List[dict]:
    """按菜单码取 [{code, name}]，保持传入顺序。"""
    if not codes:
        return []
    rows = db.query(AdminMenu).filter(AdminMenu.code.in_(codes)).all()
    by_code = {row.code: row for row in rows}
    return [{"code": c, "name": by_code[c].name} for c in codes if c in by_code]


def get_all_menu_items(db: Session) -> List[dict]:
    """全部菜单（超管可见集合）。"""
    rows = db.query(AdminMenu).order_by(AdminMenu.sort_order).all()
    return [{"code": row.code, "name": row.name} for row in rows]


def build_principal(db: Session, user) -> Optional[dict]:
    """构建微信关联管理员主体；无任何启用角色返回 None（拒绝访问）。

    返回 dict：{is_super, username, user_id, roles, menus}。
    """
    roles = get_enabled_roles(db, user.id)
    if not roles:
        return None
    return {
        "is_super": False,
        "username": user.nickname,
        "user_id": user.id,
        "roles": [role.code for role in roles],
        "menus": get_menu_codes(db, [role.id for role in roles]),
    }


# ---------------- 人员授权管理 ----------------
def list_users(
    db: Session,
    page: int,
    page_size: int,
    keyword: str = "",
    org_id: Optional[int] = None,
    has_access: Optional[bool] = None,
) -> Tuple[int, List[dict]]:
    """人员分页列表（含角色与后台授权状态）；批量取角色与组织名避免 N+1。"""
    query = db.query(User)
    if keyword:
        query = query.filter(User.nickname.ilike(f"%{keyword}%"))
    if org_id is not None:
        query = query.filter(User.org_id == org_id)
    if has_access is not None:
        enabled_ids = db.query(AdminUserRole.user_id).filter(
            AdminUserRole.enabled.is_(True)
        )
        query = query.filter(
            User.id.in_(enabled_ids) if has_access else User.id.notin_(enabled_ids)
        )
    total = query.count()
    users = (
        query.order_by(User.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    if not users:
        return total, []

    user_ids = [user.id for user in users]
    role_rows = (
        db.query(
            AdminUserRole.user_id,
            AdminRole.id,
            AdminRole.code,
            AdminRole.name,
            AdminUserRole.enabled,
        )
        .join(AdminRole, AdminRole.id == AdminUserRole.role_id)
        .filter(AdminUserRole.user_id.in_(user_ids))
        .all()
    )
    roles_by_user: dict = defaultdict(list)
    for uid, role_id, code, name, enabled in role_rows:
        roles_by_user[uid].append(
            {"id": role_id, "code": code, "name": name, "enabled": enabled}
        )
    org_ids = {user.org_id for user in users if user.org_id is not None}
    org_names = (
        dict(db.query(Organization.id, Organization.name).filter(Organization.id.in_(org_ids)).all())
        if org_ids
        else {}
    )
    items = [
        {
            "id": user.id,
            "nickname": user.nickname,
            "avatar": user.avatar or "",
            "org_id": user.org_id,
            "org_name": org_names.get(user.org_id),
            "has_access": any(r["enabled"] for r in roles_by_user[user.id]),
            "roles": roles_by_user[user.id],
        }
        for user in users
    ]
    return total, items


# ---------------- 角色管理 ----------------
def _validate_menu_codes(db: Session, codes: List[str]) -> None:
    existing = {row[0] for row in db.query(AdminMenu.code).all()}
    invalid = [c for c in codes if c not in existing]
    if invalid:
        raise ValueError("无效菜单：" + "、".join(invalid))


def list_roles(db: Session) -> List[dict]:
    """角色列表（含菜单码与授权用户数）。"""
    roles = db.query(AdminRole).order_by(AdminRole.id).all()
    role_ids = [role.id for role in roles]
    menu_rows = (
        db.query(AdminRoleMenu.role_id, AdminMenu.code)
        .join(AdminMenu, AdminMenu.id == AdminRoleMenu.menu_id)
        .filter(AdminRoleMenu.role_id.in_(role_ids))
        .order_by(AdminMenu.sort_order)
        .all()
    )
    menus_by_role: dict = defaultdict(list)
    for role_id, code in menu_rows:
        menus_by_role[role_id].append(code)
    count_rows = (
        db.query(AdminUserRole.role_id, AdminUserRole.user_id)
        .filter(AdminUserRole.role_id.in_(role_ids))
        .all()
    )
    users_by_role: dict = defaultdict(set)
    for role_id, user_id in count_rows:
        users_by_role[role_id].add(user_id)
    return [
        {
            "id": role.id,
            "code": role.code,
            "name": role.name,
            "is_builtin": role.is_builtin,
            "menus": menus_by_role[role.id],
            "user_count": len(users_by_role[role.id]),
        }
        for role in roles
    ]


def create_role(
    db: Session, name: str, menu_codes: List[str], actor_type: str, actor_id: Optional[int]
) -> dict:
    """新建角色（code 自动生成）；审计 access.role.create。"""
    _validate_menu_codes(db, menu_codes)
    role = AdminRole(code="r" + secrets.token_hex(4), name=name, is_builtin=False)
    db.add(role)
    db.flush()
    db.add_all(
        [
            AdminRoleMenu(role_id=role.id, menu_id=_menu_id_by_code(db, code))
            for code in menu_codes
        ]
    )
    audit_service.record(
        db, actor_type, actor_id, "access.role.create", None, {"role": name}
    )
    db.commit()
    return _role_out(db, role)


def _menu_id_by_code(db: Session, code: str) -> int:
    return db.query(AdminMenu.id).filter(AdminMenu.code == code).scalar()


def _role_out(db: Session, role: AdminRole) -> dict:
    menus = [
        row[0]
        for row in db.query(AdminMenu.code)
        .join(AdminRoleMenu, AdminRoleMenu.menu_id == AdminMenu.id)
        .filter(AdminRoleMenu.role_id == role.id)
        .order_by(AdminMenu.sort_order)
        .all()
    ]
    user_count = (
        db.query(AdminUserRole).filter(AdminUserRole.role_id == role.id).count()
    )
    return {
        "id": role.id,
        "code": role.code,
        "name": role.name,
        "is_builtin": role.is_builtin,
        "menus": menus,
        "user_count": user_count,
    }


def update_role(
    db: Session, role_id: int, name: str, menu_codes: List[str],
    actor_type: str, actor_id: Optional[int],
) -> dict:
    """编辑角色（名称 + 全量覆盖菜单）；审计 access.role.update。"""
    role = db.query(AdminRole).filter(AdminRole.id == role_id).first()
    if role is None:
        raise ValueError("角色不存在")
    _validate_menu_codes(db, menu_codes)
    role.name = name
    db.query(AdminRoleMenu).filter(AdminRoleMenu.role_id == role_id).delete(
        synchronize_session=False
    )
    db.add_all(
        [
            AdminRoleMenu(role_id=role.id, menu_id=_menu_id_by_code(db, code))
            for code in menu_codes
        ]
    )
    audit_service.record(
        db, actor_type, actor_id, "access.role.update", None, {"role": name}
    )
    db.commit()
    return _role_out(db, role)


def delete_role(
    db: Session, role_id: int, actor_type: str, actor_id: Optional[int]
) -> None:
    """删除角色：内置角色或被授权引用的角色拒绝删除。"""
    role = db.query(AdminRole).filter(AdminRole.id == role_id).first()
    if role is None:
        raise ValueError("角色不存在")
    if role.is_builtin:
        raise ValueError("内置角色不可删除")
    if db.query(AdminUserRole).filter(AdminUserRole.role_id == role_id).count():
        raise ValueError("角色已授权给用户，请先移除授权")
    audit_service.record(
        db, actor_type, actor_id, "access.role.delete", None, {"role": role.name}
    )
    db.query(AdminRoleMenu).filter(AdminRoleMenu.role_id == role_id).delete(
        synchronize_session=False
    )
    db.delete(role)
    db.commit()


# ---------------- 用户角色授权 ----------------
def grant_roles(
    db: Session, user_id: int, role_ids: List[int],
    actor_type: str, actor_id: Optional[int], actor_name: str,
) -> None:
    """全量覆盖用户角色：新增授权、移除不在列表中的、列表内角色统一启用。

    授权变更逐项写审计（grant/revoke/enable）。
    """
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise ValueError("用户不存在")
    valid_ids = {row[0] for row in db.query(AdminRole.id).all()}
    invalid = [rid for rid in role_ids if rid not in valid_ids]
    if invalid:
        raise ValueError("角色不存在")
    current_rows = (
        db.query(AdminUserRole).filter(AdminUserRole.user_id == user_id).all()
    )
    current_by_role = {row.role_id: row for row in current_rows}
    desired = set(role_ids)
    for row in current_rows:
        if row.role_id not in desired:
            db.delete(row)
            audit_service.record(
                db, actor_type, actor_id, "access.roles.revoke", user_id,
                {"role_id": row.role_id},
            )
        elif not row.enabled:
            row.enabled = True
            row.updated_at = datetime.utcnow()
            audit_service.record(
                db, actor_type, actor_id, "access.role.enable", user_id,
                {"role_id": row.role_id},
            )
    for role_id in desired:
        if role_id not in current_by_role:
            db.add(
                AdminUserRole(
                    user_id=user_id, role_id=role_id, enabled=True, granted_by=actor_name
                )
            )
            audit_service.record(
                db, actor_type, actor_id, "access.roles.grant", user_id,
                {"role_id": role_id},
            )
    db.commit()


def set_role_enabled(
    db: Session, user_id: int, role_id: int, is_enabled: bool,
    actor_type: str, actor_id: Optional[int],
) -> None:
    """启用/禁用用户角色（禁用即时生效）；审计 enable/disable。"""
    row = (
        db.query(AdminUserRole)
        .filter(AdminUserRole.user_id == user_id, AdminUserRole.role_id == role_id)
        .first()
    )
    if row is None:
        raise ValueError("该用户未被授予此角色")
    if row.enabled == is_enabled:
        return
    row.enabled = is_enabled
    row.updated_at = datetime.utcnow()
    audit_service.record(
        db,
        actor_type,
        actor_id,
        "access.role.enable" if is_enabled else "access.role.disable",
        user_id,
        {"role_id": role_id},
    )
    db.commit()


# ---------------- 审计日志 ----------------
def list_audit_logs(
    db: Session,
    page: int,
    page_size: int,
    action: str = "",
    actor_type: str = "",
    date: str = "",
) -> Tuple[int, List[dict]]:
    """审计日志分页（按日期/动作/操作人筛选）；批量解析操作人/目标昵称避免 N+1。"""
    query = db.query(AuditLog)
    if action:
        query = query.filter(AuditLog.action == action)
    if actor_type:
        query = query.filter(AuditLog.actor_type == actor_type)
    if date:
        start = datetime.strptime(date, "%Y-%m-%d")
        query = query.filter(
            AuditLog.created_at >= start, AuditLog.created_at < start + timedelta(days=1)
        )
    total = query.count()
    rows = (
        query.order_by(AuditLog.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    if not rows:
        return total, []
    user_ids = {
        row.actor_user_id for row in rows if row.actor_user_id is not None
    } | {row.target_user_id for row in rows if row.target_user_id is not None}
    names = (
        dict(db.query(User.id, User.nickname).filter(User.id.in_(user_ids)).all())
        if user_ids
        else {}
    )
    items = [
        {
            "id": row.id,
            "actor_type": row.actor_type,
            "actor_user_id": row.actor_user_id,
            "actor_name": "超级管理员" if row.actor_type == ACTOR_SUPER else names.get(row.actor_user_id),
            "action": row.action,
            "target_user_id": row.target_user_id,
            "target_name": names.get(row.target_user_id),
            "detail": row.detail,
            "created_at": row.created_at,
        }
        for row in rows
    ]
    return total, items
