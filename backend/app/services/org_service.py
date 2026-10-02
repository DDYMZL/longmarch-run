"""组织架构服务：逐级下钻、路径回溯、用户所属组织设定。

组织为多级树（Organization.parent_id 为空即顶级）。用户可选定任意层级节点。
"""
from typing import Dict, List, Optional

from sqlalchemy import and_, func
from sqlalchemy.orm import Session

from app.core.helpers import today_str
from app.models.models import DailySport, Organization, User
from app.services import march_service


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


def _subtree_org_ids(db: Session, root_id: int) -> List[int]:
    """组织子树 id 集合（含自身）：整表一次加载内存 BFS，避免逐层查询。"""
    rows = db.query(Organization.id, Organization.parent_id).all()
    children: Dict[Optional[int], List[int]] = {}
    for oid, pid in rows:
        children.setdefault(pid, []).append(oid)
    result: List[int] = []
    stack = [root_id]
    while stack:
        oid = stack.pop()
        result.append(oid)
        stack.extend(children.get(oid, []))
    return result


def get_companions(db: Session, user: User, limit: int = 6) -> Dict:
    """同组织同行者（需求 §9）：我的组织 + 同行人数 + 今日共同前进 + 同行者列表。

    口径：同组织 = 用户所选组织的整棵子树（含下级）；今日共同前进 = 子树成员
    当日步数之和。隐私（§9.4）：同行者只下发昵称/头像/今日步数与是否本人，
    不含用户 id、openid 等敏感字段。
    """
    if not user.org_id:
        return {"org": None, "member_count": 0, "today_total_steps": 0, "companions": []}
    org_ids = _subtree_org_ids(db, user.org_id)
    today = today_str()
    member_count = (
        db.query(func.count(User.id)).filter(User.org_id.in_(org_ids)).scalar() or 0
    )
    today_total = (
        db.query(func.coalesce(func.sum(DailySport.steps), 0))
        .join(User, DailySport.user_id == User.id)
        .filter(User.org_id.in_(org_ids), DailySport.date == today)
        .scalar()
    )
    rows = (
        db.query(User.id, User.nickname, User.avatar, DailySport.steps)
        .outerjoin(
            DailySport,
            and_(DailySport.user_id == User.id, DailySport.date == today),
        )
        .filter(User.org_id.in_(org_ids))
        .order_by(func.coalesce(DailySport.steps, 0).desc(), User.id)
        .limit(limit)
        .all()
    )
    return {
        "org": get_user_org(db, user),
        "member_count": int(member_count),
        "today_total_steps": int(today_total or 0),
        "companions": [
            {
                "nickname": nickname or "",
                "avatar": avatar,
                "today_steps": int(steps or 0),
                "is_self": uid == user.id,
            }
            for uid, nickname, avatar, steps in rows
        ],
    }


def get_org_march(db: Session, user: User) -> Dict:
    """组织共同长征目标（需求 §10）：组织集体进度 + 组织路线。

    计算规则（§10.4）：组织累计步数 = 子树成员累计有效步数之和（daily_sport
    按用户+日期覆盖存储，天然无重复统计）；组织路线按组织累计步数现算
    （与个人路线共用 _route_state，无持久点亮概念）。
    节点 pct：已完成 100 / 当前节点按累计步数占其目标比例 / 其余 0（§10.3 展示口径）。
    """
    empty = {
        "org": None, "member_count": 0, "total_steps": 0, "progress_pct": 0,
        "current_node_name": "", "next_node_name": "", "finished": False,
        "lit_count": 0, "total_count": 0, "nodes": [],
    }
    if not user.org_id:
        return empty
    org_ids = _subtree_org_ids(db, user.org_id)
    member_count = (
        db.query(func.count(User.id)).filter(User.org_id.in_(org_ids)).scalar() or 0
    )
    total = (
        db.query(func.coalesce(func.sum(DailySport.steps), 0))
        .join(User, DailySport.user_id == User.id)
        .filter(User.org_id.in_(org_ids))
        .scalar()
    )
    total = int(total or 0)

    nodes_def = march_service._ordered_nodes(db)
    lit = {n.id for n in nodes_def if total >= n.target_steps}
    state = march_service._route_state(nodes_def, lit, total)

    nodes = [
        {
            "id": x["id"],
            "name": x["name"],
            "target_steps": x["target_steps"],
            "status": x["status"],
            "pct": (
                100 if x["status"] == "completed"
                else min(100, round(total / x["target_steps"] * 100)) if x["status"] == "current" and x["target_steps"] > 0
                else 0
            ),
        }
        for x in state["nodes"]
    ]
    # §10.2 口径：「当前到达」= 正在抵达的节点（第一个未完成），「下一站」为其后一个
    current_idx = next((i for i, x in enumerate(nodes) if x["status"] != "completed"), None)
    current_name = nodes[current_idx]["name"] if current_idx is not None else (nodes[-1]["name"] if nodes else "")
    next_name = (
        nodes[current_idx + 1]["name"]
        if current_idx is not None and current_idx + 1 < len(nodes)
        else ""
    )
    return {
        "org": get_user_org(db, user),
        "member_count": int(member_count),
        "total_steps": total,
        "progress_pct": round(state["route_progress"] * 100),
        "current_node_name": current_name,
        "next_node_name": next_name,
        "finished": state["finished"],
        "lit_count": state["lit_count"],
        "total_count": state["total_count"],
        "nodes": nodes,
    }
