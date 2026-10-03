"""长征人物志服务（需求 §14）：人物 ↔ 历史事件(节点) 三者关联查询。

人物相关的历史事件即其关联节点的历史事件，历史时间取自 route_nodes.historical_time；
不建知识图谱，仅维护 person_nodes 一张关联表（§14.4 本期范围）。
"""
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.models.models import Person, PersonNode, RouteNode


def get_persons_by_node(db: Session, node_id: int) -> List[Dict]:
    """节点的相关人物列表（节点详情 → 人物入口），按人物 id 排序。"""
    rows = (
        db.query(Person.id, Person.name)
        .join(PersonNode, PersonNode.person_id == Person.id)
        .filter(PersonNode.node_id == node_id)
        .order_by(Person.id.asc())
        .all()
    )
    return [{"id": r[0], "name": r[1]} for r in rows]


def get_person_detail(db: Session, person_id: int) -> Optional[Dict]:
    """人物详情（§14.2）：头像/名称/简介 + 相关历史事件（节点）+ 历史时间。"""
    person = db.query(Person).filter(Person.id == person_id).first()
    if person is None:
        return None
    rows = (
        db.query(RouteNode)
        .join(PersonNode, PersonNode.node_id == RouteNode.id)
        .filter(PersonNode.person_id == person_id, RouteNode.is_enabled.is_(True))
        .order_by(RouteNode.sort_order.asc(), RouteNode.id.asc())
        .all()
    )
    return {
        "id": person.id,
        "name": person.name,
        "avatar": person.avatar or "",
        "brief": person.brief or "",
        "nodes": [
            {
                "id": n.id,
                "name": n.name,
                "icon": n.icon,
                "historical_time": n.historical_time,
                "brief": n.brief or "",
            }
            for n in rows
        ],
    }
