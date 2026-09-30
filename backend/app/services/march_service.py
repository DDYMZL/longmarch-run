"""长征路线服务（迁移自前端 services/march.js）。

节点状态规则：
  completed 已点亮（累计步数达标，一旦点亮永久保留）；
  current   进行中（达到上一节点但未达当前节点）；
  unlocked  未解锁（未达到上一节点）。
"""
from typing import Dict, List, Optional, Set

from sqlalchemy.orm import Session

from app.models.models import DailySport, LitNode, RouteNode
from app.services import points_service


def _total_steps(db: Session, user_id: int) -> int:
    rows = db.query(DailySport.steps).filter(DailySport.user_id == user_id).all()
    return sum((r[0] or 0) for r in rows)


def _lit_node_ids(db: Session, user_id: int) -> Set[int]:
    rows = db.query(LitNode.node_id).filter(LitNode.user_id == user_id).all()
    return {r[0] for r in rows}


def _ordered_nodes(db: Session) -> List[RouteNode]:
    return db.query(RouteNode).order_by(RouteNode.id.asc()).all()


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
            status = "current" if (prev and current_steps >= prev.target_steps) else "unlocked"
        nodes.append(
            {
                "id": n.id,
                "name": n.name,
                "icon": n.icon,
                "target_steps": n.target_steps,
                "status": status,
                "remain": max(n.target_steps - current_steps, 0),
            }
        )

    lit_count = sum(1 for x in nodes if x["status"] == "completed")
    total_count = len(nodes_def)
    finished = lit_count >= total_count and total_count > 0
    next_node = next((x for x in nodes if x["status"] != "completed"), None)
    total_steps_target = nodes_def[-1].target_steps if nodes_def else 0

    return {
        "nodes": nodes,
        "current_steps": current_steps,
        "total_steps": total_steps_target,
        "lit_count": lit_count,
        "total_count": total_count,
        "next_node": next_node,
        "finished": finished,
    }


def get_node_detail(db: Session, user_id: int, node_id: int) -> Optional[Dict]:
    """获取单个节点详情（含状态与距离）。任意状态节点均可查看。"""
    route = get_route(db, user_id)
    node_def = db.query(RouteNode).filter(RouteNode.id == node_id).first()
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
    }


def light_up_nodes(db: Session, user_id: int) -> List[Dict]:
    """点亮步数达标且未点亮的节点，发放积分；全部点亮额外 +100。返回本次新点亮节点。"""
    current_steps = _total_steps(db, user_id)
    lit = _lit_node_ids(db, user_id)
    nodes_def = _ordered_nodes(db)

    newly: List[Dict] = []
    for n in nodes_def:
        if current_steps >= n.target_steps and n.id not in lit:
            db.add(LitNode(user_id=user_id, node_id=n.id))
            lit.add(n.id)
            newly.append(
                {
                    "id": n.id,
                    "name": n.name,
                    "icon": n.icon,
                    "target_steps": n.target_steps,
                    "status": "completed",
                    "remain": 0,
                }
            )

    if newly:
        db.commit()
        for item in newly:
            points_service.grant(db, user_id, f"点亮节点：{item['name']}", 10)
        if len(lit) >= len(nodes_def):
            points_service.grant(db, user_id, "完成长征路线", 100)

    return newly
