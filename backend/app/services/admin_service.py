"""管理后台服务：题库 CRUD、组织架构维护与外部同步。

仅供 api/routes/admin.py 调用，全部方法要求已通过 get_current_admin 鉴权。
组织架构同步：配置 ORG_SYNC_API_URL 时从外部系统拉取；留空时降级使用
内置种子数据（data/seed.ORGANIZATIONS），便于开发调试。
"""
from typing import Dict, List, Optional

import httpx
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.data.seed import ORGANIZATIONS
from app.models.models import (
    DailyQuestion,
    DailySport,
    LitNode,
    Organization,
    Question,
    RouteNode,
    User,
)
from app.services import org_service


# ---------------- 路线节点维护 ----------------
def list_route_nodes(db: Session) -> List[RouteNode]:
    """按展示顺序返回全部路线节点。"""
    return db.query(RouteNode).order_by(RouteNode.sort_order, RouteNode.id).all()


def create_route_node(db: Session, data: Dict) -> RouteNode:
    """新增路线节点并校验启用路线的步数顺序。"""
    _normalize_route_node_data(data)
    max_id = db.query(func.max(RouteNode.id)).scalar() or 0
    node = RouteNode(id=max_id + 1, **data)
    db.add(node)
    try:
        db.flush()
        _validate_enabled_route(db)
        db.commit()
    except ValueError:
        db.rollback()
        raise
    db.refresh(node)
    return node


def update_route_node(
    db: Session, node_id: int, data: Dict
) -> Optional[RouteNode]:
    """更新路线节点；节点 id 与历史点亮关系保持不变。"""
    _normalize_route_node_data(data)
    node = db.query(RouteNode).filter(RouteNode.id == node_id).first()
    if node is None:
        return None
    for key, value in data.items():
        setattr(node, key, value)
    try:
        db.flush()
        _validate_enabled_route(db)
        db.commit()
    except ValueError:
        db.rollback()
        raise
    db.refresh(node)
    return node


def set_route_node_enabled(
    db: Session, node_id: int, is_enabled: bool
) -> Optional[RouteNode]:
    """启用或停用节点；停用不删除历史点亮记录。"""
    node = db.query(RouteNode).filter(RouteNode.id == node_id).first()
    if node is None:
        return None
    node.is_enabled = is_enabled
    try:
        db.flush()
        _validate_enabled_route(db)
        db.commit()
    except ValueError:
        db.rollback()
        raise
    db.refresh(node)
    return node


def _normalize_route_node_data(data: Dict) -> None:
    """归一化节点文本并校验基础字段。"""
    data["name"] = (data.get("name") or "").strip()
    data["icon"] = (data.get("icon") or "").strip()
    data["historical_time"] = (data.get("historical_time") or "").strip()
    data["description"] = (data.get("description") or "").strip()
    if not data["name"]:
        raise ValueError("节点名称不能为空")
    if data.get("target_steps", 0) < 0:
        raise ValueError("目标步数不能小于 0")
    if data.get("sort_order", 0) < 0:
        raise ValueError("排序不能小于 0")
    latitude = float(data.get("latitude", 0))
    longitude = float(data.get("longitude", 0))
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ValueError("经纬度超出合法范围")


def _validate_enabled_route(db: Session) -> None:
    """确保启用路线非空，且目标步数随展示顺序严格递增。"""
    nodes = (
        db.query(RouteNode)
        .filter(RouteNode.is_enabled.is_(True))
        .order_by(RouteNode.sort_order, RouteNode.id)
        .all()
    )
    if not nodes:
        raise ValueError("至少需要保留一个启用节点")
    for previous, current in zip(nodes, nodes[1:]):
        if current.target_steps <= previous.target_steps:
            raise ValueError(
                f"启用节点“{current.name}”的目标步数必须大于上一节点“{previous.name}”"
            )


# ---------------- 题库维护 ----------------
def list_questions(db: Session) -> List[Question]:
    """按 id 升序返回全部题目（管理端可见正确答案）。"""
    return db.query(Question).order_by(Question.id).all()


def create_question(db: Session, data: Dict) -> Question:
    """新增题目，id 由数据库自增分配。"""
    _validate_question(data)
    question = Question(**data)
    db.add(question)
    db.commit()
    db.refresh(question)
    return question


def update_question(db: Session, question_id: int, data: Dict) -> Optional[Question]:
    """整体更新题目；题目不存在返回 None。"""
    _validate_question(data)
    question = db.query(Question).filter(Question.id == question_id).first()
    if question is None:
        return None
    for key, value in data.items():
        setattr(question, key, value)
    db.commit()
    db.refresh(question)
    return question


def delete_question(db: Session, question_id: int) -> None:
    """删除题目；若已被抽取进未过期的每日题目缓存，先一并清理避免脏引用。

    题目不存在时静默返回（幂等）。
    """
    question = db.query(Question).filter(Question.id == question_id).first()
    if question is None:
        return
    caches = db.query(DailyQuestion).all()
    for cache in caches:
        if question_id in (cache.question_ids or []):
            cache.question_ids = [q for q in cache.question_ids if q != question_id]
    db.delete(question)
    db.commit()


def _validate_question(data: Dict) -> None:
    """校验题目数据合法性，非法抛 ValueError（路由层转 400）。"""
    if data.get("type") not in ("single", "judge"):
        raise ValueError("题目类型必须为 single（单选）或 judge（判断）")
    if not (data.get("question") or "").strip():
        raise ValueError("题干不能为空")
    options = data.get("options") or []
    if len(options) < 2:
        raise ValueError("至少需要 2 个选项")
    labels = [o.get("label") for o in options]
    if len(set(labels)) != len(labels):
        raise ValueError("选项标签（label）不能重复")
    answer = data.get("answer") or []
    if not answer:
        raise ValueError("正确答案不能为空")
    invalid = [a for a in answer if a not in labels]
    if invalid:
        raise ValueError(f"正确答案 {invalid} 不在选项标签中")
    if data.get("type") == "single" and len(answer) != 1:
        raise ValueError("单选题正确答案只能有 1 个")
    if int(data.get("score") or 0) <= 0:
        raise ValueError("分值必须为正整数")


# ---------------- 排名洞察 ----------------
def get_rank_overview(db: Session) -> Dict:
    """返回全员累计步数排名及每个路线节点的实际到达时间。"""
    users = db.query(User).all()
    route_nodes = (
        db.query(RouteNode)
        .filter(RouteNode.is_enabled.is_(True))
        .order_by(RouteNode.sort_order, RouteNode.id)
        .all()
    )
    route_node_ids = {node.id for node in route_nodes}
    steps_by_user = {
        user_id: int(total or 0)
        for user_id, total in (
            db.query(DailySport.user_id, func.sum(DailySport.steps))
            .group_by(DailySport.user_id)
            .all()
        )
    }
    reached_by_user: Dict[int, Dict[int, object]] = {}
    for row in db.query(LitNode).order_by(LitNode.lit_at).all():
        reached_by_user.setdefault(row.user_id, {})[row.node_id] = row.lit_at

    org_names = {
        org_id: org_service.get_full_name(db, org_id)
        for org_id in {user.org_id for user in users if user.org_id is not None}
    }
    items = []
    for user in users:
        reached_nodes = {
            node_id: reached_at
            for node_id, reached_at in reached_by_user.get(user.id, {}).items()
            if node_id in route_node_ids
        }
        node_details = [
            {
                "id": node.id,
                "name": node.name,
                "target_steps": node.target_steps,
                "reached": node.id in reached_nodes,
                "reached_at": reached_nodes.get(node.id),
            }
            for node in route_nodes
        ]
        reached_times = [item["reached_at"] for item in node_details if item["reached_at"]]
        items.append(
            {
                "user_id": user.id,
                "nickname": user.nickname,
                "avatar": user.avatar,
                "org_name": org_names.get(user.org_id, ""),
                "total_steps": steps_by_user.get(user.id, 0),
                "completed_nodes": len(reached_nodes),
                "node_count": len(route_nodes),
                "last_reached_at": max(reached_times) if reached_times else None,
                "created_at": user.created_at,
                "nodes": node_details,
            }
        )

    items.sort(key=lambda item: (-item["total_steps"], item["user_id"]))
    for index, item in enumerate(items, start=1):
        item["rank"] = index

    total_steps = sum(item["total_steps"] for item in items)
    completed_users = sum(
        item["completed_nodes"] == item["node_count"] and item["node_count"] > 0
        for item in items
    )
    return {
        "total": len(items),
        "total_steps": total_steps,
        "completed_users": completed_users,
        "route_nodes": [
            {
                "id": node.id,
                "name": node.name,
                "target_steps": node.target_steps,
                "reached": False,
                "reached_at": None,
            }
            for node in route_nodes
        ],
        "items": items,
    }


# ---------------- 组织架构维护 ----------------
def get_org_tree(db: Session) -> Dict:
    """返回完整组织树（children 嵌套）与节点总数，供前端树形表格展示。"""
    nodes = db.query(Organization).order_by(Organization.sort_order, Organization.id).all()
    tree_map: Dict[Optional[int], List[Dict]] = {}
    for n in nodes:
        item = {
            "id": n.id,
            "name": n.name,
            "parent_id": n.parent_id,
            "level": n.level,
            "sort_order": n.sort_order,
            "children": [],
        }
        tree_map.setdefault(n.parent_id, []).append(item)
    for item in tree_map.get(None, []):
        _fill_children(item, tree_map)
    return {"total": len(nodes), "nodes": tree_map.get(None, [])}


def _fill_children(item: Dict, tree_map: Dict[Optional[int], List[Dict]]) -> None:
    """递归挂载子节点（组织树层级有限，无深递归风险）。"""
    for child in tree_map.get(item["id"], []):
        _fill_children(child, tree_map)
        item["children"].append(child)


def create_org(db: Session, data: Dict) -> Organization:
    """新增组织节点；level 根据父节点自动计算。"""
    level = _resolve_level(db, data.get("parent_id"))
    org = Organization(
        name=data["name"].strip(),
        parent_id=data.get("parent_id"),
        level=level,
        sort_order=int(data.get("sort_order") or 0),
    )
    db.add(org)
    db.commit()
    db.refresh(org)
    return org


def update_org(db: Session, org_id: int, data: Dict) -> Optional[Organization]:
    """更新组织节点；父节点变更时级联重算整棵子树的 level。

    组织不存在返回 None；父节点非法（不存在 / 指向自身 / 指向自己的子孙）抛 ValueError。
    """
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if org is None:
        return None
    parent_id = data.get("parent_id")
    if parent_id is not None:
        if parent_id == org_id:
            raise ValueError("上级组织不能是自身")
        if _is_descendant(db, org_id, parent_id):
            raise ValueError("上级组织不能是自身的下级，否则将产生环")
    level = _resolve_level(db, parent_id)
    org.name = data["name"].strip()
    org.parent_id = parent_id
    org.sort_order = int(data.get("sort_order") or 0)
    old_level_diff = level - org.level
    org.level = level
    db.commit()
    if old_level_diff != 0:
        _shift_subtree_level(db, org_id, old_level_diff)
    db.refresh(org)
    return org


def delete_org(db: Session, org_id: int) -> List[int]:
    """删除组织节点及其整棵子树；仍被用户引用的节点保留并计入返回值。

    返回被保留（有用户归属或为被保留节点的祖先）的节点 id 列表。
    """
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if org is None:
        return []
    subtree_ids = _collect_subtree_ids(db, org_id)
    used_ids = {
        row[0]
        for row in db.query(User.org_id)
        .filter(User.org_id.in_(subtree_ids))
        .distinct()
        .all()
    }
    # 被引用节点的祖先也必须保留，否则树断裂
    kept_ids = set(used_ids)
    for used_id in used_ids:
        kept_ids.update(_collect_ancestor_ids(db, used_id))
    deletable = [i for i in subtree_ids if i not in kept_ids]
    db.query(Organization).filter(Organization.id.in_(deletable)).delete(
        synchronize_session=False
    )
    db.commit()
    return sorted(kept_ids)


def _resolve_level(db: Session, parent_id: Optional[int]) -> int:
    """根据父节点计算层级：顶级为 1，否则为父层级 + 1；父节点不存在抛 ValueError。"""
    if parent_id is None:
        return 1
    parent = db.query(Organization).filter(Organization.id == parent_id).first()
    if parent is None:
        raise ValueError("上级组织不存在")
    return parent.level + 1


def _is_descendant(db: Session, org_id: int, candidate_id: int) -> bool:
    """判断 candidate_id 是否为 org_id 的子孙节点。"""
    return candidate_id in _collect_subtree_ids(db, org_id)[1:]


def _collect_subtree_ids(db: Session, org_id: int) -> List[int]:
    """收集以 org_id 为根的整棵子树 id（含自身），广度优先避免递归。"""
    all_nodes = db.query(Organization.id, Organization.parent_id).all()
    children_map: Dict[Optional[int], List[int]] = {}
    for nid, pid in all_nodes:
        children_map.setdefault(pid, []).append(nid)
    result: List[int] = []
    queue = [org_id]
    while queue:
        current = queue.pop(0)
        result.append(current)
        queue.extend(children_map.get(current, []))
    return result


def _collect_ancestor_ids(db: Session, org_id: int) -> List[int]:
    """收集 org_id 的全部祖先 id（不含自身）。"""
    ancestors: List[int] = []
    current = db.query(Organization).filter(Organization.id == org_id).first()
    guard = 0
    while current is not None and current.parent_id is not None and guard < 32:
        ancestors.append(current.parent_id)
        current = (
            db.query(Organization).filter(Organization.id == current.parent_id).first()
        )
        guard += 1
    return ancestors


def _shift_subtree_level(db: Session, root_id: int, diff: int) -> None:
    """父节点变更后，整棵子树（不含根自身）层级平移 diff。"""
    for sub_id in _collect_subtree_ids(db, root_id)[1:]:
        sub = db.query(Organization).filter(Organization.id == sub_id).first()
        if sub is not None:
            sub.level += diff
    db.commit()


# ---------------- 组织架构同步 ----------------
def sync_orgs(db: Session) -> Dict:
    """从外部系统同步组织架构（全量对齐）。

    数据源：配置 ORG_SYNC_API_URL 时 GET 拉取（接受裸数组或 {data: [...]} 包装，
    字段兼容 id/name/parentId|parent_id/sortOrder|sort_order）；
    留空时降级使用内置种子数据 ORGANIZATIONS。

    同步策略：按 id upsert（name/parent_id/sort_order/level 全量覆盖），
    数据源中不存在的本地节点删除；仍被用户引用的节点保留并计入 skipped。
    """
    source, raw_nodes = _fetch_org_source()
    nodes = [_normalize_org_node(raw) for raw in raw_nodes]
    if any(not isinstance(raw, dict) or raw.get("level") is None for raw in raw_nodes):
        _rebuild_levels(nodes)
    node_ids = {n["id"] for n in nodes}

    existing: Dict[int, Organization] = {
        o.id: o for o in db.query(Organization).all()
    }
    created = updated = 0
    for n in nodes:
        org = existing.get(n["id"])
        if org is None:
            db.add(
                Organization(
                    id=n["id"],
                    name=n["name"],
                    parent_id=n["parent_id"],
                    level=n["level"],
                    sort_order=n["sort_order"],
                )
            )
            created += 1
        else:
            org.name = n["name"]
            org.parent_id = n["parent_id"]
            org.level = n["level"]
            org.sort_order = n["sort_order"]
            updated += 1

    # 数据源已删除的本地节点：无用户引用则删除，有引用则保留
    removed_ids = [oid for oid in existing if oid not in node_ids]
    skipped: List[int] = []
    deleted = 0
    if removed_ids:
        used_ids = {
            row[0]
            for row in db.query(User.org_id)
            .filter(User.org_id.in_(removed_ids))
            .distinct()
            .all()
        }
        skipped = sorted(used_ids)
        deletable = [oid for oid in removed_ids if oid not in used_ids]
        if deletable:
            db.query(Organization).filter(Organization.id.in_(deletable)).delete(
                synchronize_session=False
            )
            deleted = len(deletable)
    db.commit()
    return {
        "source": source,
        "created": created,
        "updated": updated,
        "deleted": deleted,
        "kept": len(nodes),
        "skipped": skipped,
    }


def _fetch_org_source() -> tuple:
    """拉取同步数据源，返回 (source 描述, 原始节点列表)。失败抛 ValueError。"""
    url = (settings.ORG_SYNC_API_URL or "").strip()
    if not url:
        return "seed（未配置 ORG_SYNC_API_URL，使用内置种子数据）", list(ORGANIZATIONS)
    try:
        resp = httpx.get(url, timeout=10)
        resp.raise_for_status()
        payload = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ValueError(f"调用外部组织架构接口失败：{exc}")
    nodes = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(nodes, list):
        raise ValueError("外部接口返回格式非法：期望数组或 {data: [...]}")
    return f"external（{url}）", nodes


def _normalize_org_node(raw: Dict) -> Dict:
    """归一化外部节点字段（兼容 camelCase / snake_case），并校验合法性。"""
    if not isinstance(raw, dict):
        raise ValueError("组织节点必须为对象")
    org_id = raw.get("id")
    name = (raw.get("name") or "").strip()
    if not isinstance(org_id, int) or not name:
        raise ValueError(f"组织节点缺少合法 id/name：{raw}")
    parent_id = raw.get("parent_id", raw.get("parentId"))
    sort_order = raw.get("sort_order", raw.get("sortOrder")) or 0
    return {
        "id": org_id,
        "name": name,
        "parent_id": parent_id,
        "sort_order": int(sort_order),
        "level": _calc_level(raw, org_id),
    }


def _calc_level(raw: Dict, fallback_id: int) -> int:
    """优先采用数据源 level 字段；缺失时按 parent_id 链在源数据内推算，顶级为 1。"""
    level = raw.get("level")
    if isinstance(level, int) and level > 0:
        return level
    # 无 level 字段时统一按 1 处理，随后由 _rebuild_levels 依据 parent 链修正
    return 1


def _rebuild_levels(nodes: List[Dict]) -> None:
    """依据 parent_id 链重算全部节点 level（数据源未提供 level 时兜底）。"""
    by_id = {n["id"]: n for n in nodes}

    def depth(node: Dict, guard: int = 0) -> int:
        if guard > 32:
            return 1
        parent = by_id.get(node["parent_id"]) if node["parent_id"] is not None else None
        return 1 if parent is None else depth(parent, guard + 1) + 1

    for n in nodes:
        n["level"] = depth(n)
