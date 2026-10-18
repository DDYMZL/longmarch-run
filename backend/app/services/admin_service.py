"""管理后台服务：题库 CRUD、组织架构维护与外部同步。

仅供 api/routes/admin.py 调用，全部方法要求已通过 get_current_admin 鉴权。
组织架构同步：配置 ORG_SYNC_API_URL 时从外部系统拉取；留空时降级使用
内置种子数据（data/seed.ORGANIZATIONS），便于开发调试。
"""
import csv
import io
import itertools
import math
from datetime import datetime
from typing import Dict, Iterator, List, Optional, Tuple

import httpx
from sqlalchemy import String, cast, func, or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.helpers import to_local
from app.data.seed import ORGANIZATIONS
from app.models.models import (
    Chapter,
    DailySport,
    LitNode,
    MedalDef,
    Organization,
    Person,
    PersonNode,
    PointsLog,
    Question,
    QuizRecord,
    RouteNode,
    User,
    UserMedal,
)
from app.services import march_service, org_service, points_service, rank_service, sport_service


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
    for key in ("brief", "figures", "location", "audio", "keywords"):
        data[key] = (data.get(key) or "").strip()
    data["significance"] = (data.get("significance") or "").strip()
    data["images"] = [
        str(url).strip() for url in (data.get("images") or []) if str(url).strip()
    ]
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


# ---------------- 章节维护（工作流 A3） ----------------
def _chapter_out(row: Chapter) -> Dict:
    """Chapter ORM → 契约 dict（intro/node_ids 可空回退默认）。"""
    return {
        "id": row.id,
        "name": row.name,
        "title": row.title or "",
        "intro": row.intro or "",
        "node_ids": list(row.node_ids or []),
        "sort_order": row.sort_order,
    }


def _normalize_chapter_data(data: Dict) -> None:
    """归一化章节字段并校验：名称必填、node_ids 为去重整数列表、sort_order 非负。"""
    data["name"] = (data.get("name") or "").strip()
    data["title"] = (data.get("title") or "").strip()
    data["intro"] = (data.get("intro") or "").strip()
    if not data["name"]:
        raise ValueError("章节名称不能为空")
    node_ids: List[int] = []
    for raw in (data.get("node_ids") or []):
        try:
            nid = int(raw)
        except (TypeError, ValueError):
            raise ValueError("章节节点必须为整数 id")
        if nid not in node_ids:
            node_ids.append(nid)
    data["node_ids"] = node_ids
    try:
        sort_order = int(data.get("sort_order", 0) or 0)
    except (TypeError, ValueError):
        raise ValueError("排序必须为整数")
    if sort_order < 0:
        raise ValueError("排序不能小于 0")
    data["sort_order"] = sort_order


def list_chapters(
    db: Session, page: int = 1, page_size: int = 20, keyword: str = ""
) -> Tuple[int, List[Dict]]:
    """分页返回章节（管理端可视化编辑）。

    keyword 模糊匹配 name/title（为空不过滤）；先 count 再 offset/limit；
    按 sort_order 升序、id 兜底保证排序稳定。返回 (过滤后总数, 当页 items)。
    """
    query = db.query(Chapter)
    kw = keyword.strip()
    if kw:
        query = query.filter(
            or_(
                Chapter.name.contains(kw, autoescape=True),
                Chapter.title.contains(kw, autoescape=True),
            )
        )
    total = query.count()
    rows = (
        query.order_by(Chapter.sort_order, Chapter.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return total, [_chapter_out(r) for r in rows]


def create_chapter(db: Session, data: Dict) -> Dict:
    """新增章节（只 flush，路由层审计并 commit）。"""
    _normalize_chapter_data(data)
    row = Chapter(
        name=data["name"],
        title=data["title"],
        intro=data["intro"] or None,
        node_ids=data["node_ids"],
        sort_order=data["sort_order"],
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    march_service.invalidate_chapter_cache()  # #15：章节变更，失效生效章节缓存
    return _chapter_out(row)


def update_chapter(db: Session, chapter_id: int, data: Dict) -> Optional[Dict]:
    """更新章节；不存在返回 None。"""
    _normalize_chapter_data(data)
    row = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if row is None:
        return None
    row.name = data["name"]
    row.title = data["title"]
    row.intro = data["intro"] or None
    row.node_ids = data["node_ids"]
    row.sort_order = data["sort_order"]
    db.flush()
    db.refresh(row)
    march_service.invalidate_chapter_cache()  # #15：章节变更，失效生效章节缓存
    return _chapter_out(row)


def delete_chapter(db: Session, chapter_id: int) -> bool:
    """删除章节（无外键依赖，硬删除）；不存在返回 False。"""
    row = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if row is None:
        return False
    db.delete(row)
    db.flush()
    march_service.invalidate_chapter_cache()  # #15：章节变更，失效生效章节缓存
    return True


def reorder_chapters(db: Session, ordered_ids: List[int]) -> List[Dict]:
    """按给定 id 顺序重排章节（sort_order 从 1 递增）；含未知 id 抛 ValueError。"""
    rows = {r.id: r for r in db.query(Chapter).all()}
    unknown = [cid for cid in ordered_ids if cid not in rows]
    if unknown:
        raise ValueError(f"章节不存在：{unknown}")
    if len(set(ordered_ids)) != len(rows):
        raise ValueError("排序列表必须包含全部章节且不重复")
    for idx, cid in enumerate(ordered_ids):
        rows[cid].sort_order = idx + 1
    db.flush()
    march_service.invalidate_chapter_cache()  # #15：章节重排，失效生效章节缓存
    ordered = db.query(Chapter).order_by(Chapter.sort_order, Chapter.id).all()
    return [_chapter_out(r) for r in ordered]


# ---------------- 人物志维护（工作流 A4） ----------------
def _person_out(row: Person, node_ids: List[int]) -> Dict:
    return {
        "id": row.id,
        "name": row.name,
        "avatar": row.avatar or "",
        "brief": row.brief or "",
        "node_ids": node_ids,
    }


def _normalize_person_data(data: Dict) -> None:
    """归一化人物字段：名称必填、node_ids 去重整数列表。"""
    data["name"] = (data.get("name") or "").strip()
    data["avatar"] = (data.get("avatar") or "").strip()
    data["brief"] = (data.get("brief") or "").strip()
    if not data["name"]:
        raise ValueError("人物名称不能为空")
    node_ids: List[int] = []
    for raw in (data.get("node_ids") or []):
        try:
            nid = int(raw)
        except (TypeError, ValueError):
            raise ValueError("关联节点必须为整数 id")
        if nid not in node_ids:
            node_ids.append(nid)
    data["node_ids"] = node_ids


def _set_person_nodes(db: Session, person_id: int, node_ids: List[int]) -> None:
    """重建人物-节点关联（删旧建新，事务内）；校验节点存在，含未知 id 抛 ValueError。"""
    if node_ids:
        valid = {
            r[0]
            for r in db.query(RouteNode.id).filter(RouteNode.id.in_(node_ids)).all()
        }
        unknown = [nid for nid in node_ids if nid not in valid]
        if unknown:
            raise ValueError(f"关联节点不存在：{unknown}")
    db.query(PersonNode).filter(PersonNode.person_id == person_id).delete(
        synchronize_session=False
    )
    for nid in node_ids:
        db.add(PersonNode(person_id=person_id, node_id=nid))


def list_persons(
    db: Session, page: int = 1, page_size: int = 20, keyword: str = ""
) -> Tuple[int, List[Dict]]:
    """人物分页列表（含关联节点 id）。

    keyword 模糊匹配 name/brief（为空不过滤）；先 count 再 offset/limit；按 id 升序。
    仅批量加载「当页人物」的 person_nodes（IN 查询），避免 N+1。返回 (过滤后总数, 当页 items)。
    """
    query = db.query(Person)
    kw = keyword.strip()
    if kw:
        query = query.filter(
            or_(
                Person.name.contains(kw, autoescape=True),
                Person.brief.contains(kw, autoescape=True),
            )
        )
    total = query.count()
    persons = (
        query.order_by(Person.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    if not persons:
        return total, []
    person_ids = [p.id for p in persons]
    nodes_by_person: Dict[int, List[int]] = {}
    for pid, nid in (
        db.query(PersonNode.person_id, PersonNode.node_id)
        .filter(PersonNode.person_id.in_(person_ids))
        .all()
    ):
        nodes_by_person.setdefault(pid, []).append(nid)
    for ids in nodes_by_person.values():
        ids.sort()
    return total, [_person_out(p, nodes_by_person.get(p.id, [])) for p in persons]


def get_person(db: Session, person_id: int) -> Optional[Dict]:
    row = db.query(Person).filter(Person.id == person_id).first()
    if row is None:
        return None
    node_ids = [
        r[0]
        for r in db.query(PersonNode.node_id)
        .filter(PersonNode.person_id == person_id)
        .order_by(PersonNode.node_id)
        .all()
    ]
    return _person_out(row, node_ids)


def create_person(db: Session, data: Dict) -> Dict:
    """新增人物（显式主键 max_id+1，Person.id 无自增）并重建关联；只 flush。"""
    _normalize_person_data(data)
    max_id = db.query(func.max(Person.id)).scalar() or 0
    row = Person(
        id=max_id + 1,
        name=data["name"],
        avatar=data["avatar"] or None,
        brief=data["brief"] or None,
    )
    db.add(row)
    db.flush()
    _set_person_nodes(db, row.id, data["node_ids"])
    db.flush()
    return _person_out(row, sorted(data["node_ids"]))


def update_person(db: Session, person_id: int, data: Dict) -> Optional[Dict]:
    """更新人物（含关联节点删旧建新）；不存在返回 None。"""
    _normalize_person_data(data)
    row = db.query(Person).filter(Person.id == person_id).first()
    if row is None:
        return None
    row.name = data["name"]
    row.avatar = data["avatar"] or None
    row.brief = data["brief"] or None
    _set_person_nodes(db, person_id, data["node_ids"])
    db.flush()
    return _person_out(row, sorted(data["node_ids"]))


def delete_person(db: Session, person_id: int) -> bool:
    """删除人物及其关联；不存在返回 False。"""
    row = db.query(Person).filter(Person.id == person_id).first()
    if row is None:
        return False
    db.query(PersonNode).filter(PersonNode.person_id == person_id).delete(
        synchronize_session=False
    )
    db.delete(row)
    db.flush()
    return True


# ---------------- 勋章维护（工作流 A4） ----------------
def _medal_out(row: MedalDef) -> Dict:
    return {
        "id": row.id,
        "name": row.name,
        "icon": row.icon,
        "desc": row.desc or "",
        "category": row.category or "",
        "hidden": bool(row.hidden),
        "sort_order": row.sort_order,
    }


def _normalize_medal_data(data: Dict) -> None:
    data["name"] = (data.get("name") or "").strip()
    data["icon"] = (data.get("icon") or "").strip()
    data["desc"] = (data.get("desc") or "").strip()
    data["category"] = (data.get("category") or "").strip()
    if not data["name"]:
        raise ValueError("勋章名称不能为空")
    if not data["icon"]:
        raise ValueError("勋章图标不能为空")
    data["hidden"] = bool(data.get("hidden", False))
    try:
        data["sort_order"] = int(data.get("sort_order", 0) or 0)
    except (TypeError, ValueError):
        raise ValueError("排序必须为整数")
    if data["sort_order"] < 0:
        raise ValueError("排序不能小于 0")


def list_medals(
    db: Session, page: int = 1, page_size: int = 20, keyword: str = ""
) -> Tuple[int, List[Dict]]:
    """勋章分页列表。

    keyword 模糊匹配 id/name（为空不过滤）；先 count 再 offset/limit；
    按 sort_order 升序、id 兜底保证排序稳定。返回 (过滤后总数, 当页 items)。
    """
    query = db.query(MedalDef)
    kw = keyword.strip()
    if kw:
        query = query.filter(
            or_(
                MedalDef.id.contains(kw, autoescape=True),
                MedalDef.name.contains(kw, autoescape=True),
            )
        )
    total = query.count()
    rows = (
        query.order_by(MedalDef.sort_order, MedalDef.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return total, [_medal_out(r) for r in rows]


def create_medal(db: Session, data: Dict) -> Dict:
    """新增勋章：id 缺省时后端生成 medal_{ms}；id 重复抛 ValueError。只 flush。"""
    _normalize_medal_data(data)
    medal_id = (data.get("id") or "").strip()
    if not medal_id:
        medal_id = f"medal_{int(datetime.now().timestamp() * 1000)}"
    if db.query(MedalDef).filter(MedalDef.id == medal_id).first() is not None:
        raise ValueError(f"勋章 id 已存在：{medal_id}")
    row = MedalDef(
        id=medal_id,
        name=data["name"],
        icon=data["icon"],
        desc=data["desc"],
        category=data["category"] or None,
        hidden=data["hidden"],
        sort_order=data["sort_order"],
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    return _medal_out(row)


def update_medal(db: Session, medal_id: str, data: Dict) -> Optional[Dict]:
    """更新勋章（id 不可改）；不存在返回 None。"""
    _normalize_medal_data(data)
    row = db.query(MedalDef).filter(MedalDef.id == medal_id).first()
    if row is None:
        return None
    row.name = data["name"]
    row.icon = data["icon"]
    row.desc = data["desc"]
    row.category = data["category"] or None
    row.hidden = data["hidden"]
    row.sort_order = data["sort_order"]
    db.flush()
    db.refresh(row)
    return _medal_out(row)


def delete_medal(db: Session, medal_id: str) -> bool:
    """删除勋章定义并清理已发放记录（user_medals 无 FK，显式清理）；不存在返回 False。"""
    row = db.query(MedalDef).filter(MedalDef.id == medal_id).first()
    if row is None:
        return False
    db.query(UserMedal).filter(UserMedal.medal_id == medal_id).delete(
        synchronize_session=False
    )
    db.delete(row)
    db.flush()
    return True


# ---------------- 题库维护 ----------------
def list_questions(
    db: Session,
    page: int = 1,
    page_size: int = 20,
    keyword: str = "",
    qtype: str = "",
    category: str = "",
) -> Tuple[int, List[Question]]:
    """分页返回题目（管理端可见正确答案）。

    keyword 模糊匹配题干；qtype（single/judge）与 category（event/route/figure）
    精确过滤；按 id 升序。
    """
    query = db.query(Question).filter(Question.active.is_(True))
    if keyword.strip():
        query = query.filter(Question.question.contains(keyword.strip(), autoescape=True))
    if qtype:
        query = query.filter(Question.type == qtype)
    if category:
        query = query.filter(Question.category == category)
    total = query.count()
    items = (
        query.order_by(Question.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return total, items


def create_question(db: Session, data: Dict) -> Question:
    """新增题目；questions.id 无数据库自增（种子占用固定 id），显式取 max+1。"""
    _validate_question(data)
    max_id = db.query(func.max(Question.id)).scalar() or 0
    question = Question(id=max_id + 1, **data)
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
    """软停用题目；之后不再抽取，当天已生成的答题任务仍保留并可完成。

    题目不存在或已停用时静默返回（幂等）。
    """
    question = db.query(Question).filter(Question.id == question_id).first()
    if question is None or not question.active:
        return
    question.active = False
    db.commit()


def _validate_question(data: Dict) -> None:
    """校验题目数据合法性，非法抛 ValueError（路由层转 400）。"""
    if data.get("type") not in ("single", "judge"):
        raise ValueError("题目类型必须为 single（单选）或 judge（判断）")
    if not (data.get("question") or "").strip():
        raise ValueError("题干不能为空")
    category = (data.get("category") or "").strip()
    if category and category not in ("event", "route", "figure"):
        raise ValueError("分类必须为 event（历史事件）/ route（长征路线）/ figure（历史人物）或留空")
    data["category"] = category
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
# 导出时每批处理的人数（流式游标批量读取，内存占用与总人数无关）
RANK_EXPORT_BATCH = 1000


def _enabled_route_nodes(db: Session) -> List:
    return (
        db.query(RouteNode.id, RouteNode.name, RouteNode.target_steps)
        .filter(RouteNode.is_enabled.is_(True))
        .order_by(RouteNode.sort_order, RouteNode.id)
        .all()
    )


def _filter_rank_users(query, keyword: str, org_id: Optional[int], only_changed: bool):
    """排名筛选：昵称（不区分大小写）或人员 ID 包含关键字、所属组织精确匹配、仅已改名。"""
    word = (keyword or "").strip().lower()
    if word:
        query = query.filter(
            or_(
                func.lower(User.nickname).contains(word, autoescape=True),
                cast(User.id, String).contains(word, autoescape=True),
            )
        )
    if org_id is not None:
        query = query.filter(User.org_id == org_id)
    if only_changed:
        query = query.filter(User.nickname_changed_at.isnot(None))
    return query


def _ranked_user_query(db: Session, keyword: str = "", org_id: Optional[int] = None, only_changed: bool = False):
    """按全员名次排序的用户查询；名次始终是全员口径，筛选不改变名次。"""
    ranked = rank_service.ranked_users_subquery(db)
    query = (
        db.query(
            ranked.c.rank,
            ranked.c.steps,
            ranked.c.points,
            ranked.c.walk_points,
            ranked.c.quiz_points,
            User.id.label("user_id"),
            User.nickname,
            User.avatar,
            User.org_id,
            User.original_nickname,
            User.nickname_changed_at,
            User.created_at,
        )
        .join(User, User.id == ranked.c.user_id)
        .order_by(ranked.c.rank)
    )
    return _filter_rank_users(query, keyword, org_id, only_changed)


def _reached_map(db: Session, user_ids: List[int], node_ids: List[int]) -> Dict[int, Dict[int, datetime]]:
    """一批用户在启用节点上的点亮时间 {user_id: {node_id: lit_at}}。"""
    if not user_ids or not node_ids:
        return {}
    reached: Dict[int, Dict[int, datetime]] = {}
    for uid, nid, lit_at in (
        db.query(LitNode.user_id, LitNode.node_id, LitNode.lit_at)
        .filter(LitNode.user_id.in_(user_ids), LitNode.node_id.in_(node_ids))
        .all()
    ):
        reached.setdefault(uid, {})[nid] = lit_at
    return reached


def _rank_items(db: Session, rows: List, route_nodes: List, org_names: Dict[int, str]) -> List[Dict]:
    reached_by_user = _reached_map(db, [r.user_id for r in rows], [n.id for n in route_nodes])
    items = []
    for r in rows:
        reached = reached_by_user.get(r.user_id, {})
        items.append(
            {
                "rank": int(r.rank),
                "user_id": r.user_id,
                "nickname": r.nickname,
                "avatar": r.avatar,
                "org_name": org_names.get(r.org_id, ""),
                "original_nickname": r.original_nickname or r.nickname,
                "nickname_changed_at": r.nickname_changed_at,
                "total_steps": int(r.steps),
                "total_points": int(r.points),
                "walk_points": int(r.walk_points),
                "quiz_points": int(r.quiz_points),
                "completed_nodes": len(reached),
                "node_count": len(route_nodes),
                "last_reached_at": max(reached.values()) if reached else None,
                "created_at": r.created_at,
                "nodes": [
                    {
                        "id": n.id,
                        "name": n.name,
                        "target_steps": n.target_steps,
                        "reached": n.id in reached,
                        "reached_at": reached.get(n.id),
                    }
                    for n in route_nodes
                ],
            }
        )
    return items


def _rank_summary(db: Session, node_ids: List[int]) -> Dict:
    """全员指标：人数、总步数、总积分、完成全程人数、平均路线进度（各人进度四舍五入后取平均）。"""
    total = db.query(func.count(User.id)).scalar() or 0
    total_steps = db.query(func.coalesce(func.sum(DailySport.steps), 0)).scalar() or 0
    total_points = (
        db.query(func.coalesce(func.sum(PointsLog.delta), 0))
        .filter(PointsLog.source_type.in_(points_service.SOURCES))
        .scalar()
        or 0
    )
    node_count = len(node_ids)
    completed_users, avg_progress = 0, 0
    if node_count and total:
        per_user = (
            db.query(func.count(LitNode.id).label("cnt"))
            .filter(LitNode.node_id.in_(node_ids))
            .group_by(LitNode.user_id)
            .subquery()
        )
        # 按「点亮节点数」分布聚合：结果行数不超过节点数 + 1，与人数无关
        histogram = db.query(per_user.c.cnt, func.count()).group_by(per_user.c.cnt).all()
        completed_users = sum(users for cnt, users in histogram if cnt == node_count)
        progress_sum = sum(math.floor(cnt * 100 / node_count + 0.5) * users for cnt, users in histogram)
        avg_progress = math.floor(progress_sum / total + 0.5)
    return {
        "total": int(total),
        "total_steps": int(total_steps),
        "total_points": int(total_points),
        "completed_users": int(completed_users),
        "avg_progress": int(avg_progress),
    }


def get_rank_overview(
    db: Session,
    page: int = 1,
    page_size: int = 50,
    keyword: str = "",
    org_id: Optional[int] = None,
    only_changed: bool = False,
) -> Dict:
    """排名洞察：全员指标 + 荣誉榜前 10 名（不受筛选影响）+ 筛选后的当前页明细（含每个启用节点的到达时间）。"""
    route_nodes = _enabled_route_nodes(db)
    summary = _rank_summary(db, [n.id for n in route_nodes])
    filtered = bool((keyword or "").strip()) or org_id is not None or only_changed
    rows = (
        _ranked_user_query(db, keyword, org_id, only_changed)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    elite = rank_service.ELITE_SIZE
    podium_rows = (
        _ranked_user_query(db).limit(elite).all()
        if filtered or page != 1 or page_size < elite
        else rows[:elite]
    )
    match_total = (
        _filter_rank_users(db.query(func.count(User.id)), keyword, org_id, only_changed).scalar()
        if filtered
        else summary["total"]
    )

    org_ids = [oid for (oid,) in db.query(User.org_id).filter(User.org_id.isnot(None)).distinct().all()]
    org_names = org_service.get_full_name_map(db, org_ids)
    return {
        **summary,
        "match_total": int(match_total or 0),
        "org_options": sorted(
            ({"id": oid, "name": org_names[oid]} for oid in org_ids if org_names.get(oid)),
            key=lambda o: o["name"],
        ),
        "route_nodes": [
            {"id": n.id, "name": n.name, "target_steps": n.target_steps, "reached": False, "reached_at": None}
            for n in route_nodes
        ],
        "podium": _rank_items(db, podium_rows, route_nodes, org_names),
        "items": _rank_items(db, rows, route_nodes, org_names),
    }


def _csv_text(value) -> str:
    """CSV 单元格防公式注入：以 = + - @ 开头的内容前置单引号。"""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@") else text


def _export_time(value: Optional[datetime], empty: str) -> str:
    return to_local(value).strftime("%Y/%m/%d %H:%M") if value else empty


def iter_rank_csv(keyword: str = "", org_id: Optional[int] = None, only_changed: bool = False) -> Iterator[str]:
    """按筛选条件流式生成排名 CSV（UTF-8 BOM）。

    使用独立会话：响应体在路由返回后才被逐块消费，不能依赖请求级会话。
    """
    db = SessionLocal()
    buffer = io.StringIO()
    writer = csv.writer(buffer, quoting=csv.QUOTE_ALL, lineterminator="\r\n")

    def flush() -> str:
        chunk = buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)
        return chunk

    try:
        route_nodes = _enabled_route_nodes(db)
        node_ids = [n.id for n in route_nodes]
        org_names = org_service.get_full_name_map(db, [oid for (oid,) in db.query(Organization.id).all()])
        writer.writerow(
            ["排名", "人员ID", "姓名", "曾用名", "改名时间", "所属组织", "总积分", "步行积分", "答题积分", "累计步数", "到达节点数"]
            + [_csv_text(f"{n.name}到达时间") for n in route_nodes]
        )
        yield "\ufeff" + flush()

        rows_iter = iter(_ranked_user_query(db, keyword, org_id, only_changed).yield_per(RANK_EXPORT_BATCH))
        while True:
            batch = list(itertools.islice(rows_iter, RANK_EXPORT_BATCH))
            if not batch:
                break
            reached_by_user = _reached_map(db, [r.user_id for r in batch], node_ids)
            for r in batch:
                reached = reached_by_user.get(r.user_id, {})
                changed = r.nickname_changed_at is not None
                writer.writerow(
                    [
                        int(r.rank),
                        r.user_id,
                        _csv_text(r.nickname),
                        _csv_text((r.original_nickname or r.nickname) if changed else ""),
                        _export_time(r.nickname_changed_at, ""),
                        _csv_text(org_names.get(r.org_id) or "未分配组织"),
                        int(r.points),
                        int(r.walk_points),
                        int(r.quiz_points),
                        int(r.steps),
                        len(reached),
                    ]
                    + [_export_time(reached.get(nid), "尚未到达") for nid in node_ids]
                )
            yield flush()
    finally:
        db.close()


# ---------------- 人员详情聚合 ----------------
def get_user_overview(db: Session, user_id: int) -> Optional[Dict]:
    """聚合某人员全部业务数据：基本信息、运动、答题、勋章、长征、积分。

    供排名洞察点击人员后展示；用户不存在返回 None。
    """
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        return None
    route_nodes = (
        db.query(RouteNode)
        .filter(RouteNode.is_enabled.is_(True))
        .order_by(RouteNode.sort_order, RouteNode.id)
        .all()
    )
    lit_at_by_node = {
        row.node_id: row.lit_at
        for row in db.query(LitNode).filter(LitNode.user_id == user_id).all()
    }
    march_nodes = [
        {
            "id": node.id,
            "name": node.name,
            "target_steps": node.target_steps,
            "reached": node.id in lit_at_by_node,
            "reached_at": lit_at_by_node.get(node.id),
        }
        for node in route_nodes
    ]

    medals = [
        {
            "id": medal_def.id,
            "name": medal_def.name,
            "icon": medal_def.icon,
            "desc": medal_def.desc,
            "granted_at": granted_at,
        }
        for medal_def, granted_at in (
            db.query(MedalDef, UserMedal.granted_at)
            .join(UserMedal, UserMedal.medal_id == MedalDef.id)
            .filter(UserMedal.user_id == user_id)
            .order_by(UserMedal.granted_at)
            .all()
        )
    ]

    points_logs = (
        db.query(PointsLog)
        .filter(PointsLog.user_id == user_id, PointsLog.source_type.in_(points_service.SOURCES))
        .order_by(PointsLog.date.desc(), PointsLog.id.desc())
        .all()
    )

    today = sport_service.get_today(db, user_id)
    quiz_records = (
        db.query(QuizRecord)
        .filter(QuizRecord.user_id == user_id)
        .order_by(QuizRecord.date.desc())
        .all()
    )

    return {
        "user": {
            "user_id": user.id,
            "nickname": user.nickname,
            "avatar": user.avatar or "",
            "org_name": (
                org_service.get_full_name(db, user.org_id)
                if user.org_id is not None
                else ""
            ),
            "original_nickname": user.original_nickname or user.nickname,
            "nickname_changed_at": user.nickname_changed_at,
            "created_at": user.created_at,
        },
        "sport": {
            "today_steps": today["steps"],
            "total_steps": today["total_steps"],
            "recent": sport_service.get_recent(db, user_id, 7),
        },
        "quiz_records": [
            {
                "date": record.date,
                "total_count": record.total_count,
                "correct_count": record.correct_count,
                "score": record.score,
                "points": record.points,
                "answer_at": record.answer_at,
            }
            for record in quiz_records
        ],
        "medals": medals,
        "march": {
            "completed_nodes": len(lit_at_by_node),
            "node_count": len(route_nodes),
            "nodes": march_nodes,
        },
        "points": {
            **points_service.get_breakdown(db, user_id),
            "rank": rank_service.get_user_rank(db, user_id),
            "logs": [
                {
                    "date": item.date,
                    "reason": item.reason,
                    "delta": item.delta,
                    "source_type": item.source_type,
                }
                for item in points_logs
            ],
        },
    }


# ---------------- 组织架构维护 ----------------
def get_org_tree(db: Session) -> Dict:
    """返回完整组织树（children 嵌套）与节点总数，供前端树形表格展示。

    每个节点附带人数统计：direct_user_count 为直接选择该组织的用户数，
    total_user_count 为含全部下级组织的累计用户数（后序累加）。
    """
    nodes = db.query(Organization).order_by(Organization.sort_order, Organization.id).all()
    direct_counts = dict(
        db.query(User.org_id, func.count(User.id))
        .filter(User.org_id.isnot(None))
        .group_by(User.org_id)
        .all()
    )
    tree_map: Dict[Optional[int], List[Dict]] = {}
    for n in nodes:
        item = {
            "id": n.id,
            "name": n.name,
            "parent_id": n.parent_id,
            "level": n.level,
            "sort_order": n.sort_order,
            "direct_user_count": int(direct_counts.get(n.id, 0)),
            "total_user_count": 0,
            "children": [],
        }
        tree_map.setdefault(n.parent_id, []).append(item)
    for item in tree_map.get(None, []):
        _fill_children(item, tree_map)
        _accumulate_user_count(item)
    return {"total": len(nodes), "nodes": tree_map.get(None, [])}


def _accumulate_user_count(item: Dict) -> int:
    """后序遍历累加子树人数，写入 total_user_count 并返回该节点累计值。"""
    total = item["direct_user_count"]
    for child in item["children"]:
        total += _accumulate_user_count(child)
    item["total_user_count"] = total
    return total


def _fill_children(item: Dict, tree_map: Dict[Optional[int], List[Dict]]) -> None:
    """递归挂载子节点（组织树层级有限，无深递归风险）。"""
    for child in tree_map.get(item["id"], []):
        _fill_children(child, tree_map)
        item["children"].append(child)


def get_org_users(
    db: Session, org_id: int, scope: str, page: int, page_size: int
) -> Optional[Dict]:
    """组织人员明细分页查询。

    口径与组织树统计一致：scope=direct 仅直属该组织的用户（对应
    direct_user_count）；scope=all 含整棵子树全部用户（对应 total_user_count，
    按子树组织 id 集合一次 in 查询，不重不漏）。组织不存在返回 None。
    """
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if org is None:
        return None
    if scope == "all":
        org_ids = org_service.subtree_org_ids(db, org_id)
        base_query = db.query(User).filter(User.org_id.in_(org_ids))
    else:
        base_query = db.query(User).filter(User.org_id == org_id)
    total = base_query.count()
    users = (
        base_query.order_by(User.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    org_names = org_service.get_full_name_map(db, [u.org_id for u in users])
    return {
        "total": total,
        "items": [
            {
                "user_id": u.id,
                "nickname": u.nickname,
                "avatar": u.avatar,
                "org_name": org_names.get(u.org_id, ""),
                "created_at": u.created_at,
            }
            for u in users
        ],
    }


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
    subtree_ids = org_service.subtree_org_ids(db, org_id)
    used_ids = {
        row[0]
        for row in db.query(User.org_id)
        .filter(User.org_id.in_(subtree_ids))
        .distinct()
        .all()
    }
    # 被引用节点的祖先也必须保留，否则树断裂（父链整表一次加载，逐级上溯不再查库）
    parent_of = dict(db.query(Organization.id, Organization.parent_id).all())
    kept_ids = set(used_ids)
    for used_id in used_ids:
        current = parent_of.get(used_id)
        while current is not None and current not in kept_ids:
            kept_ids.add(current)
            current = parent_of.get(current)
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
    return candidate_id in org_service.subtree_org_ids(db, org_id)[1:]


def _shift_subtree_level(db: Session, root_id: int, diff: int) -> None:
    """父节点变更后，整棵子树（不含根自身）层级平移 diff（单条批量 UPDATE）。"""
    sub_ids = org_service.subtree_org_ids(db, root_id)[1:]
    if sub_ids:
        db.query(Organization).filter(Organization.id.in_(sub_ids)).update(
            {Organization.level: Organization.level + diff}, synchronize_session=False
        )
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
        "level": _calc_level(raw),
    }


def _calc_level(raw: Dict) -> int:
    """优先采用数据源 level 字段；缺失时按 1 处理，由 _rebuild_levels 依 parent 链修正。"""
    level = raw.get("level")
    if isinstance(level, int) and level > 0:
        return level
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
