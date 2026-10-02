"""管理端驾驶舱 / 数据大屏服务。

dashboard：核心指标 + 路线总览（每节点达成人数，口径与小程序一致——累计步数
达标即视为点亮）；trend：近 N 日总步数/参与人数/新增用户/新增点亮；
activities：user_event 实时动态（关联昵称，文案与小程序足迹同源）；
screen：大屏单接口聚合（指标 + 路线总览 + 7 日趋势 + 动态，组织维度按需求取消）。

库内 created_at / lit_at / event_time 为 UTC 存储，按本地日期分桶时统一经
helpers.to_local / local_to_utc 换算。
"""
from bisect import bisect_left
from datetime import datetime
from typing import Dict, List

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.helpers import local_to_utc, recent_dates, to_local, today_str
from app.models.models import (
    DailySport,
    LitNode,
    QuizRecord,
    RouteNode,
    User,
    UserEvent,
    UserMedal,
)
from app.services import event_service


def _user_total_steps(db: Session) -> Dict[int, int]:
    """每用户累计步数。"""
    rows = (
        db.query(DailySport.user_id, func.sum(DailySport.steps))
        .group_by(DailySport.user_id)
        .all()
    )
    return {uid: int(total or 0) for uid, total in rows}


def _enabled_nodes(db: Session) -> List[RouteNode]:
    return (
        db.query(RouteNode)
        .filter(RouteNode.is_enabled.is_(True))
        .order_by(RouteNode.sort_order.asc(), RouteNode.id.asc())
        .all()
    )


def get_dashboard(db: Session) -> Dict:
    """驾驶舱聚合：metrics + route_overview。"""
    total_users = db.query(User.id).count()
    today_users = (
        db.query(DailySport.user_id)
        .filter(DailySport.date == today_str())
        .distinct()
        .count()
    )
    totals = _user_total_steps(db)
    total_steps = sum(totals.values())
    avg_steps = round(total_steps / total_users) if total_users else 0

    nodes = _enabled_nodes(db)
    final_target = nodes[-1].target_steps if nodes else 0
    finished = (
        sum(1 for value in totals.values() if value >= final_target) if final_target else 0
    )
    completion_rate = round(finished / total_users * 100) if total_users else 0

    quiz_users = db.query(QuizRecord.user_id).distinct().count()
    medals_granted = db.query(UserMedal.id).count()

    # 累计步数升序后二分计数：每节点 O(log U)，替代逐节点 O(U) 全量扫描（用户量大时关键路径）
    sorted_totals = sorted(totals.values())
    route_overview = []
    for n in nodes:
        lit_count = len(sorted_totals) - bisect_left(sorted_totals, n.target_steps)
        route_overview.append(
            {
                "node_id": n.id,
                "name": n.name,
                "target_steps": n.target_steps,
                "lit_count": lit_count,
                "completion_rate": (
                    round(lit_count / total_users * 100) if total_users else 0
                ),
            }
        )

    return {
        "metrics": {
            "total_users": total_users,
            "today_users": today_users,
            "total_steps": total_steps,
            "avg_steps": avg_steps,
            "completion_rate": completion_rate,
            "quiz_users": quiz_users,
            "medals_granted": medals_granted,
        },
        "route_overview": route_overview,
    }


def get_trend(db: Session, days: int) -> Dict:
    """近 N 日趋势（本地日期分桶）：总步数/参与人数/新增用户/新增点亮。"""
    dates = recent_dates(days)
    points = {
        d: {"date": d, "total_steps": 0, "active_users": 0, "new_users": 0, "new_lit": 0}
        for d in dates
    }

    sport_rows = (
        db.query(DailySport.date, func.sum(DailySport.steps), func.count(DailySport.id))
        .filter(DailySport.date.in_(dates))
        .group_by(DailySport.date)
        .all()
    )
    for date, steps, cnt in sport_rows:
        if date in points:
            points[date]["total_steps"] = int(steps or 0)
            points[date]["active_users"] = cnt

    # created_at / lit_at 为 UTC 存储：范围按 UTC 过滤，归桶按本地日期
    range_start_utc = local_to_utc(datetime.strptime(dates[0], "%Y-%m-%d"))

    user_rows = db.query(User.created_at).filter(User.created_at >= range_start_utc).all()
    for (created_at,) in user_rows:
        key = to_local(created_at).strftime("%Y-%m-%d")
        if key in points:
            points[key]["new_users"] += 1

    lit_rows = db.query(LitNode.lit_at).filter(LitNode.lit_at >= range_start_utc).all()
    for (lit_at,) in lit_rows:
        key = to_local(lit_at).strftime("%Y-%m-%d")
        if key in points:
            points[key]["new_lit"] += 1

    return {"days": days, "points": [points[d] for d in dates]}


def get_activities(db: Session, limit: int = 50) -> List[Dict]:
    """实时动态（user_event 倒序，关联昵称）。"""
    rows = (
        db.query(UserEvent)
        .order_by(UserEvent.event_time.desc(), UserEvent.id.desc())
        .limit(limit)
        .all()
    )
    user_ids = {r.user_id for r in rows}
    nicknames = {
        u.id: (u.nickname or "")
        for u in db.query(User.id, User.nickname).filter(User.id.in_(user_ids)).all()
    } if user_ids else {}
    return [
        {
            "id": r.id,
            "event_type": r.event_type,
            "event_time": r.event_time,
            "user_id": r.user_id,
            "nickname": nicknames.get(r.user_id, ""),
            "text": event_service.build_text(r.event_type, r.event_data or {}),
            "data": r.event_data or {},
        }
        for r in rows
    ]


def get_screen(db: Session) -> Dict:
    """数据大屏单接口聚合：指标 + 路线总览 + 7 日趋势 + 最近 20 条动态。"""
    dashboard = get_dashboard(db)
    return {
        "metrics": dashboard["metrics"],
        "route_overview": dashboard["route_overview"],
        "trend": get_trend(db, 7)["points"],
        "activities": get_activities(db, 20),
    }
