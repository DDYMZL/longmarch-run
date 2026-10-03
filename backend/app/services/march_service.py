"""长征路线服务（迁移自前端 services/march.js）。

节点状态规则：
  completed 已点亮（累计步数达标，一旦点亮永久保留）；
  current   进行中（达到上一节点但未达当前节点）；
  unlocked  未解锁（未达到上一节点）。

章节系统（需求 §4）：10 个节点划分为 5 章，章节名称与节点归属集中在
CHAPTERS 配置（管理端可视化编辑为后续增强）；章节状态由后端统一下发，
章节最后节点点亮写 CHAPTER_COMPLETE 事件（不改变原有节点点亮逻辑）。
"""
from datetime import datetime
from typing import Dict, List, Optional, Set, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.helpers import to_local
from app.models.models import DailySport, LitNode, RouteNode, User
from app.services import event_service, person_service, points_service

# 长征章节配置（node_ids 对应 route_nodes 主键；介绍为公开史实概述，供章节完成仪式展示）
CHAPTERS: List[Dict] = [
    {
        "id": 1, "name": "出发", "title": "第一章 · 出发", "node_ids": [1, 2],
        "intro": "1934年10月，中央红军从瑞金等地出发踏上战略转移征途；1935年1月，遵义会议在最危急的关头挽救了党和红军。",
    },
    {
        "id": 2, "name": "转折", "title": "第二章 · 转折", "node_ids": [3, 4],
        "intro": "四渡赤水出奇兵，巧渡金沙江摆脱数十万敌军围追堵截，红军由被动转为主动。",
    },
    {
        "id": 3, "name": "突围", "title": "第三章 · 突围", "node_ids": [5, 6],
        "intro": "1935年5月，强渡大渡河、飞夺泸定桥，红军以血肉之躯撕开北上通道。",
    },
    {
        "id": 4, "name": "翻越", "title": "第四章 · 翻越", "node_ids": [7, 8],
        "intro": "翻越皑皑雪山，跋涉茫茫草地，红军以非凡意志战胜自然极限。",
    },
    {
        "id": 5, "name": "会师", "title": "第五章 · 会师", "node_ids": [9, 10],
        "intro": "1935年10月中央红军抵达吴起镇，1936年10月三大主力胜利会师，长征宣告胜利结束。",
    },
]

# 全员共同长征目标配置（需求 §11）：活动总目标与阶段里程碑。
# name 为展示文案（随配置调整）；管理端可视化编辑为后续增强。
GLOBAL_GOAL_STEPS = 200_000_000
GLOBAL_MILESTONES: List[Dict] = [
    {"name": "5000万", "steps": 50_000_000},
    {"name": "1亿", "steps": 100_000_000},
    {"name": "1.5亿", "steps": 150_000_000},
    {"name": "2亿", "steps": 200_000_000},
]


def _total_steps(db: Session, user_id: int) -> int:
    rows = db.query(DailySport.steps).filter(DailySport.user_id == user_id).all()
    return sum((r[0] or 0) for r in rows)


def _lit_node_ids(db: Session, user_id: int) -> Set[int]:
    rows = db.query(LitNode.node_id).filter(LitNode.user_id == user_id).all()
    return {r[0] for r in rows}


def _ordered_nodes(db: Session) -> List[RouteNode]:
    return (
        db.query(RouteNode)
        .filter(RouteNode.is_enabled.is_(True))
        .order_by(RouteNode.sort_order.asc(), RouteNode.id.asc())
        .all()
    )


def get_route_nodes(db: Session) -> List[RouteNode]:
    """返回供小程序展示的启用节点配置。"""
    return _ordered_nodes(db)


def _chapter_views(nodes: List[Dict]) -> Tuple[List[Dict], Optional[int]]:
    """按路线节点状态计算章节视图与当前章节 id。

    status：COMPLETED 全部点亮 / ACTIVE 第一个未完成章 / LOCKED 之后各章；
    节点全部停用的章节跳过不下发。
    """
    status_by_id = {x["id"]: x["status"] for x in nodes}
    views: List[Dict] = []
    for ch in CHAPTERS:
        ids = [nid for nid in ch["node_ids"] if nid in status_by_id]
        if not ids:
            continue
        lit = sum(1 for nid in ids if status_by_id[nid] == "completed")
        views.append(
            {
                "id": ch["id"],
                "name": ch["name"],
                "title": ch["title"],
                "node_ids": ids,
                "lit_count": lit,
                "total_count": len(ids),
                "progress": lit / len(ids),
                "intro": ch["intro"],
                "status": "LOCKED",
            }
        )
    active_found = False
    for v in views:
        if v["lit_count"] == v["total_count"]:
            v["status"] = "COMPLETED"
        elif not active_found:
            v["status"] = "ACTIVE"
            active_found = True
    current_chapter_id = next((v["id"] for v in views if v["status"] == "ACTIVE"), None)
    return views, current_chapter_id


def _completed_chapters(lit_ids: Set[int], enabled_ids: Set[int]) -> List[Dict]:
    """返回指定点亮集合下已完成的章节配置（route 顺序）。"""
    done: List[Dict] = []
    for ch in CHAPTERS:
        ids = [nid for nid in ch["node_ids"] if nid in enabled_ids]
        if ids and all(nid in lit_ids for nid in ids):
            done.append(ch)
    return done


def _route_state(
    nodes_def: List[RouteNode], lit: Set[int], current_steps: int
) -> Dict:
    """由累计步数 + 点亮集合计算节点状态列表与路线进度（个人/组织路线共用）。

    lit 为已点亮节点 id 集合（个人含历史持久点亮；组织路线按步数达标现算，
    调用方负责构造）。状态规则见模块 docstring。
    """
    nodes: List[Dict] = []
    for idx, n in enumerate(nodes_def):
        if n.id in lit:
            status = "completed"
        else:
            prev = nodes_def[idx - 1] if idx > 0 else None
            status = "current" if prev is None or current_steps >= prev.target_steps else "unlocked"
        nodes.append(
            {
                "id": n.id,
                "name": n.name,
                "icon": n.icon,
                "target_steps": n.target_steps,
                "status": status,
                "remain": max(n.target_steps - current_steps, 0),
                "historical_time": n.historical_time,
                "description": n.description,
                "latitude": n.latitude,
                "longitude": n.longitude,
            }
        )

    lit_count = sum(1 for x in nodes if x["status"] == "completed")
    total_count = len(nodes_def)
    finished = lit_count >= total_count and total_count > 0
    next_node = next((x for x in nodes if x["status"] != "completed"), None)
    total_steps_target = nodes_def[-1].target_steps if nodes_def else 0

    # 行军轨迹进度（文档 §3.6：由后端统一计算，小程序只负责表现）
    # route_progress   全程进度 0~1（累计步数 / 终点目标步数）
    # current_node_id  正在前往的节点（即下一站）；全程完成时为 None
    # current_progress 当前区间段内进度 0~1（(累计步数-上一节点目标) / 本段跨度）
    route_progress = (
        min(1.0, current_steps / total_steps_target) if total_steps_target > 0 else 0.0
    )
    current_node_id: Optional[int] = None
    current_progress = 0.0
    if next_node is not None:
        current_node_id = next_node["id"]
        idx = next(i for i, x in enumerate(nodes) if x["id"] == next_node["id"])
        prev_target = nodes_def[idx - 1].target_steps if idx > 0 else 0
        span = next_node["target_steps"] - prev_target
        current_progress = (
            min(1.0, max(0.0, (current_steps - prev_target) / span)) if span > 0 else 1.0
        )

    return {
        "nodes": nodes,
        "lit_count": lit_count,
        "total_count": total_count,
        "next_node": next_node,
        "finished": finished,
        "current_node_id": current_node_id,
        "current_progress": current_progress,
        "route_progress": route_progress,
        "total_steps_target": total_steps_target,
    }


def get_route(db: Session, user_id: int) -> Dict:
    """计算节点状态列表 + 路线整体进度。"""
    nodes_def = _ordered_nodes(db)
    current_steps = _total_steps(db, user_id)
    lit = _lit_node_ids(db, user_id)

    # 步数达标即视为点亮（规则：点亮后永久保留，即使步数下降也不取消）
    for n in nodes_def:
        if current_steps >= n.target_steps:
            lit.add(n.id)

    state = _route_state(nodes_def, lit, current_steps)
    chapters, current_chapter_id = _chapter_views(state["nodes"])

    # 完成仪式触发（需求 §20.4）：全部点亮且未观看过仪式时下发 ceremony_pending，
    # 前端播放完整仪式动画后调 POST /march/ceremony 标记；仅完成时查一次 users。
    ceremony_pending = False
    if state["finished"]:
        row = db.query(User.route_ceremony_at).filter(User.id == user_id).first()
        ceremony_pending = row is not None and row[0] is None

    return {
        "nodes": state["nodes"],
        "current_steps": current_steps,
        "total_steps": state["total_steps_target"],
        "lit_count": state["lit_count"],
        "total_count": state["total_count"],
        "next_node": state["next_node"],
        "finished": state["finished"],
        "current_node_id": state["current_node_id"],
        "current_progress": state["current_progress"],
        "route_progress": state["route_progress"],
        "chapters": chapters,
        "current_chapter_id": current_chapter_id,
        "ceremony_pending": ceremony_pending,
    }


def mark_ceremony_seen(db: Session, user_id: int) -> None:
    """标记长征完成仪式已观看（需求 §20.4：仅第一次完成触发完整动画）。幂等。"""
    user = db.query(User).filter(User.id == user_id).first()
    if user is None or user.route_ceremony_at is not None:
        return
    user.route_ceremony_at = datetime.utcnow()
    db.commit()


def get_global_goal(db: Session) -> Dict:
    """全员共同长征目标（需求 §11）：全员累计步数对总目标的进度与阶段里程碑。

    全员累计步数 = 全部用户 daily_sport.steps 之和（按用户+日期覆盖存储，
    无重复统计）。里程碑达成状态按累计步数实时计算；§11.3 的解锁内容 /
    全局动画 / 系统动态等奖励钩子为后续增强（需系统级事件通道，不在本期）。
    """
    total = int(
        db.query(func.coalesce(func.sum(DailySport.steps), 0)).scalar() or 0
    )
    milestones = [
        {"name": m["name"], "steps": m["steps"], "reached": total >= m["steps"]}
        for m in GLOBAL_MILESTONES
    ]
    upcoming = next((m for m in milestones if not m["reached"]), None)
    return {
        "total_steps": total,
        "target_steps": GLOBAL_GOAL_STEPS,
        "progress_pct": (
            min(100.0, round(total / GLOBAL_GOAL_STEPS * 100, 1))
            if GLOBAL_GOAL_STEPS > 0
            else 0.0
        ),
        "milestones": milestones,
        "next_milestone": (
            {
                "name": upcoming["name"],
                "steps": upcoming["steps"],
                "remain": upcoming["steps"] - total,
            }
            if upcoming
            else None
        ),
    }


def get_footprints(db: Session, user_id: int) -> Dict:
    """我的长征足迹（需求 §7）：已点亮节点 + 点亮日期 + 当日步数 + 点亮时累计步数。

    数据源（§7.4）：lit_nodes（lit_at / step_snapshot）与 daily_sport 当日步数，
    不新增冗余存储。lit_date 为本地日期（与 DailySport.date 同口径，lit_at 按
    UTC 存储转本地）；cum_steps 取点亮时刻累计快照（历史回填数据 snapshot=0，
    由前端判空展示）。
    """
    rows = (
        db.query(LitNode, RouteNode)
        .join(RouteNode, LitNode.node_id == RouteNode.id)
        .filter(LitNode.user_id == user_id, RouteNode.is_enabled.is_(True))
        .order_by(RouteNode.sort_order.asc(), RouteNode.id.asc())
        .all()
    )
    if not rows:
        return {"nodes": []}
    lit_dates = {
        to_local(lit.lit_at).strftime("%Y-%m-%d") for lit, _ in rows if lit.lit_at
    }
    day_steps = (
        {
            d: s
            for d, s in db.query(DailySport.date, DailySport.steps)
            .filter(DailySport.user_id == user_id, DailySport.date.in_(lit_dates))
            .all()
        }
        if lit_dates
        else {}
    )
    nodes: List[Dict] = []
    for lit, rn in rows:
        local_date = to_local(lit.lit_at).strftime("%Y-%m-%d") if lit.lit_at else ""
        nodes.append(
            {
                "id": rn.id,
                "name": rn.name,
                "icon": rn.icon,
                "lit_at": lit.lit_at,
                "lit_date": local_date,
                "day_steps": int(day_steps.get(local_date) or 0),
                "cum_steps": int(lit.step_snapshot or 0),
            }
        )
    return {"nodes": nodes}


def get_node_detail(db: Session, user_id: int, node_id: int) -> Optional[Dict]:
    """获取单个节点详情（含状态、距离与历史事件卡内容）。任意状态节点均可查看。"""
    route = get_route(db, user_id)
    node_def = (
        db.query(RouteNode)
        .filter(RouteNode.id == node_id, RouteNode.is_enabled.is_(True))
        .first()
    )
    if node_def is None:
        return None
    state = next((x for x in route["nodes"] if x["id"] == node_id), None)
    return {
        "id": node_def.id,
        "name": node_def.name,
        "icon": node_def.icon,
        "target_steps": node_def.target_steps,
        "historical_time": node_def.historical_time,
        "description": node_def.description,
        "status": state["status"] if state else "unlocked",
        "remain": state["remain"] if state else node_def.target_steps,
        "current_steps": route["current_steps"],
        "brief": node_def.brief or "",
        "significance": node_def.significance or "",
        "figures": node_def.figures or "",
        "location": node_def.location or "",
        "images": node_def.images or [],
        "audio": node_def.audio or "",
        "keywords": node_def.keywords or "",
        "persons": person_service.get_persons_by_node(db, node_id),
    }


def light_up_nodes(db: Session, user_id: int) -> Tuple[List[Dict], List[Dict]]:
    """点亮步数达标且未点亮的节点，发放积分；全部点亮额外 +100。

    返回 (本次新点亮节点, 本次新完成章节)：
    - 每个新点亮节点附带 gained_points / lit_at / next_node（下一站名称与剩余步数，
      全部点亮时为 None），供前端到达动画与「抵达事件卡」直接使用；
    - 每个新完成章节附带 id / name / title / intro，供前端「章节完成仪式」使用。
    副作用：LitNode 记录点亮时刻累计步数快照（step_snapshot），并写
    NODE_UNLOCK / CHAPTER_COMPLETE / COMPLETE_ROUTE 事件（我的足迹与管理端动态同源）。
    章节完成不改变原有节点点亮逻辑与积分规则（需求 §4.5）。
    """
    current_steps = _total_steps(db, user_id)
    lit = _lit_node_ids(db, user_id)
    nodes_def = _ordered_nodes(db)
    enabled_ids = {n.id for n in nodes_def}
    chapters_before = {ch["id"] for ch in _completed_chapters(lit, enabled_ids)}

    newly: List[Dict] = []
    lit_records: List[LitNode] = []
    for n in nodes_def:
        if current_steps >= n.target_steps and n.id not in lit:
            record = LitNode(user_id=user_id, node_id=n.id, step_snapshot=current_steps)
            db.add(record)
            lit_records.append(record)
            lit.add(n.id)
            newly.append(
                {
                    "id": n.id,
                    "name": n.name,
                    "icon": n.icon,
                    "target_steps": n.target_steps,
                    "status": "completed",
                    "remain": 0,
                    "historical_time": n.historical_time,
                    "description": n.description,
                    "latitude": n.latitude,
                    "longitude": n.longitude,
                }
            )

    if not newly:
        return [], []

    db.commit()
    # 点亮完成后的下一站（本次操作后第一个未达标节点）
    upcoming = next((n for n in nodes_def if current_steps < n.target_steps), None)
    next_node = (
        {"name": upcoming.name, "remain": upcoming.target_steps - current_steps}
        if upcoming
        else None
    )
    for item, record in zip(newly, lit_records):
        item["gained_points"] = 10
        item["lit_at"] = record.lit_at
        item["next_node"] = next_node
    for item in newly:
        points_service.grant(db, user_id, f"点亮节点：{item['name']}", 10)
        event_service.record(
            db,
            user_id,
            "NODE_UNLOCK",
            {"nodeId": item["id"], "nodeName": item["name"], "stepSnapshot": current_steps},
        )
    if len(lit) >= len(nodes_def):
        points_service.grant(db, user_id, "完成长征路线", 100)
        event_service.record(db, user_id, "COMPLETE_ROUTE", {"totalSteps": current_steps})

    # 章节完成判定：本次点亮后新完成的章节写 CHAPTER_COMPLETE 事件
    new_chapters: List[Dict] = []
    for ch in _completed_chapters(lit, enabled_ids):
        if ch["id"] in chapters_before:
            continue
        event_service.record(
            db,
            user_id,
            "CHAPTER_COMPLETE",
            {"chapterId": ch["id"], "chapterName": ch["title"]},
        )
        new_chapters.append(
            {"id": ch["id"], "name": ch["name"], "title": ch["title"], "intro": ch["intro"]}
        )

    return newly, new_chapters
