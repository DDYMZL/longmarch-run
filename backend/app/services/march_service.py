"""长征路线服务（迁移自前端 services/march.js）。

节点状态规则：
  completed 已点亮（累计步数达标，一旦点亮永久保留）；
  current   进行中（达到上一节点但未达当前节点）；
  unlocked  未解锁（未达到上一节点）。
"""
from typing import Dict, List, Optional, Set

from sqlalchemy.orm import Session

from app.models.models import DailySport, LitNode, RouteNode
from app.services import event_service, points_service


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


def get_route(db: Session, user_id: int) -> Dict:
    """计算节点状态列表 + 路线整体进度。"""
    nodes_def = _ordered_nodes(db)
    current_steps = _total_steps(db, user_id)
    lit = _lit_node_ids(db, user_id)

    # 步数达标即视为点亮（规则：点亮后永久保留，即使步数下降也不取消）
    for n in nodes_def:
        if current_steps >= n.target_steps:
            lit.add(n.id)

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
        "current_steps": current_steps,
        "total_steps": total_steps_target,
        "lit_count": lit_count,
        "total_count": total_count,
        "next_node": next_node,
        "finished": finished,
        "current_node_id": current_node_id,
        "current_progress": current_progress,
        "route_progress": route_progress,
    }


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
    }


def light_up_nodes(db: Session, user_id: int) -> List[Dict]:
    """点亮步数达标且未点亮的节点，发放积分；全部点亮额外 +100。返回本次新点亮节点。

    每个新点亮节点附带 gained_points / lit_at / next_node（下一站名称与剩余步数，
    全部点亮时为 None），供前端到达动画与「抵达事件卡」直接使用。
    副作用：LitNode 记录点亮时刻累计步数快照（step_snapshot），并写
    NODE_UNLOCK / COMPLETE_ROUTE 事件（我的足迹与管理端动态同源）。
    """
    current_steps = _total_steps(db, user_id)
    lit = _lit_node_ids(db, user_id)
    nodes_def = _ordered_nodes(db)

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

    if newly:
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

    return newly
