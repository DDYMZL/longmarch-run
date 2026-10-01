"""今日播报服务（功能 6 全局播报 + 功能 7 长征记忆彩蛋）。

global：全平台今日数据；personal：当前用户今日数据与排名百分比；
memory：按当天「月-日」匹配 route_nodes.historical_time（如「1935年5月29日」），
无匹配时按年内第几天轮转推荐一个节点。
"""
import re
from datetime import datetime
from typing import Dict, Optional

from sqlalchemy.orm import Session

from app.core.helpers import local_to_utc, today_str
from app.models.models import DailySport, LitNode, QuizRecord, RouteNode, User
from app.services import march_service

_MD_PATTERN = re.compile(r"(\d{1,2})月(\d{1,2})日")


def _history_md(historical_time: str) -> Optional[tuple]:
    """从「1935年5月29日」中提取 (月, 日)，无法解析返回 None。"""
    m = _MD_PATTERN.search(historical_time or "")
    return (int(m.group(1)), int(m.group(2))) if m else None


def _pick_memory(db: Session, today: datetime) -> Optional[RouteNode]:
    """长征记忆：优先当天月-日匹配的历史节点，否则按日轮转推荐。"""
    nodes = (
        db.query(RouteNode)
        .filter(RouteNode.is_enabled.is_(True))
        .order_by(RouteNode.sort_order.asc(), RouteNode.id.asc())
        .all()
    )
    if not nodes:
        return None
    md = (today.month, today.day)
    for n in nodes:
        if _history_md(n.historical_time) == md:
            return n
    return nodes[today.timetuple().tm_yday % len(nodes)]


def get_today(db: Session, user_id: int) -> Dict:
    """今日播报聚合：global / personal / memory 三段。"""
    date = today_str()
    now = datetime.now()

    today_rows = (
        db.query(DailySport.user_id, DailySport.steps)
        .filter(DailySport.date == date)
        .all()
    )
    today_users = len(today_rows)
    today_steps_total = sum((r[1] or 0) for r in today_rows)

    # lit_at 为 UTC 存储：本地今日 0 点换算成 UTC 再比较
    day_start_utc = local_to_utc(now.replace(hour=0, minute=0, second=0, microsecond=0))
    today_lit_count = (
        db.query(LitNode.id).filter(LitNode.lit_at >= day_start_utc).count()
    )
    today_quiz_users = db.query(QuizRecord.id).filter(QuizRecord.date == date).count()
    total_users = db.query(User.id).count()

    step_map = {uid: (steps or 0) for uid, steps in today_rows}
    my_steps = step_map.get(user_id, 0)
    beaten = sum(1 for value in step_map.values() if value <= my_steps)
    beat_percent = round(beaten / today_users * 100) if today_users else 0

    route = march_service.get_route(db, user_id)
    next_node = route["next_node"]

    memory_node = _pick_memory(db, now)

    return {
        "global": {
            "today_users": today_users,
            "today_steps": today_steps_total,
            "today_lit_count": today_lit_count,
            "today_quiz_users": today_quiz_users,
            "total_users": total_users,
        },
        "personal": {
            "today_steps": my_steps,
            "beat_percent": beat_percent,
            "remain_to_next": next_node["remain"] if next_node else 0,
            "next_node_name": next_node["name"] if next_node else "",
        },
        "memory": (
            {
                "node_id": memory_node.id,
                "title": memory_node.name,
                "historical_time": memory_node.historical_time or "",
                "brief": memory_node.brief or "",
            }
            if memory_node
            else None
        ),
    }
