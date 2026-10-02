"""组织架构服务：逐级下钻、路径回溯、用户所属组织设定。

组织为多级树（Organization.parent_id 为空即顶级）。用户可选定任意层级节点。
"""
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.models import Organization, User


def _child_counts(db: Session, parent_ids: List[int]) -> Dict[int, int]:
    """批量统计一批组织的直接下级数量，避免逐项查询。"""
    if not parent_ids:
        return {}
    rows = (
        db.query(Organization.parent_id, Organization.id)
        .filter(Organization.parent_id.in_(parent_ids))
        .all()
    )
    counts: Dict[int, int] = {}
    for parent_id, _ in rows:
        counts[parent_id] = counts.get(parent_id, 0) + 1
    return counts


def get_children(db: Session, parent_id: Optional[int] = None) -> List[Dict]:
    """获取某一层级的组织列表（parent_id 为空返回顶级）。

    每项附带 has_children / child_count，供前端判断是否可继续下钻。
    """
    nodes = (
        db.query(Organization)
        .filter(Organization.parent_id == parent_id)
        .order_by(Organization.sort_order, Organization.id)
        .all()
    )
    counts = _child_counts(db, [n.id for n in nodes])
    return [
        {
            "id": n.id,
            "name": n.name,
            "parent_id": n.parent_id,
            "level": n.level,
            "has_children": counts.get(n.id, 0) > 0,
            "child_count": counts.get(n.id, 0),
        }
        for n in nodes
    ]


def get_org(db: Session, org_id: int) -> Optional[Organization]:
    return db.query(Organization).filter(Organization.id == org_id).first()


def get_path(db: Session, org_id: int) -> List[Dict]:
    """回溯从顶级到该节点的完整路径（面包屑），返回 [{id, name}]。"""
    path: List[Dict] = []
    current = get_org(db, org_id)
    guard = 0
    while current is not None and guard < 32:
        path.append({"id": current.id, "name": current.name})
        current = get_org(db, current.parent_id) if current.parent_id else None
        guard += 1
    path.reverse()
    return path


def get_full_name(db: Session, org_id: int) -> str:
    """组织全路径名，如「长征集团总部 / 华东分公司 / 技术部」。"""
    return " / ".join(p["name"] for p in get_path(db, org_id))


def get_full_name_map(db: Session, org_ids: List[Optional[int]]) -> Dict[int, str]:
    """批量计算组织全路径名：整表一次加载、内存回溯，避免逐组织逐层查询（N+1）。

    供排名、榜单等需要成批组织名的场景使用；不存在的 id 映射为空串。
    """
    rows = db.query(Organization.id, Organization.name, Organization.parent_id).all()
    info = {oid: (name, parent_id) for oid, name, parent_id in rows}
    result: Dict[int, str] = {}
    for org_id in set(o for o in org_ids if o is not None):
        names: List[str] = []
        current: Optional[int] = org_id
        guard = 0
        while current in info and guard < 32:
            name, current = info[current]
            names.append(name)
            guard += 1
        names.reverse()
        result[org_id] = " / ".join(names)
    return result


def set_user_org(db: Session, user_id: int, org_id: int) -> Optional[User]:
    """设定用户所属组织；组织不存在返回 None。"""
    org = get_org(db, org_id)
    if org is None:
        return None
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        return None
    user.org_id = org_id
    db.commit()
    db.refresh(user)
    return user


def get_user_org(db: Session, user: User) -> Dict:
    """当前用户所属组织信息（未选择时 org_id 为 None）。"""
    if not user.org_id:
        return {"org_id": None, "org_name": "", "full_name": "", "path": []}
    path = get_path(db, user.org_id)
    return {
        "org_id": user.org_id,
        "org_name": path[-1]["name"] if path else "",
        "full_name": " / ".join(p["name"] for p in path),
        "path": path,
    }
