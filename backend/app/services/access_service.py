"""后台访问授权服务（RBAC 查询部分）。

授权模型：用户至少拥有 1 个启用角色即可访问后台；菜单取启用角色的并集。
超级管理员（账号登录）不走角色体系，拥有全部菜单。
"""
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.models import AdminMenu, AdminRole, AdminRoleMenu, AdminUserRole

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
