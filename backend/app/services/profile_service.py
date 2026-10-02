"""个人档案服务：summary 聚合（功能 1）与 timeline 足迹（功能 2.6）。

summary 从各业务表实时聚合（运动 / 连续行军 / 路线 / 答题 / 勋章 / 积分），
timeline 直接读取 user_event 统一事件表，文案由 event_service.build_text 生成。
"""
from datetime import datetime
from typing import Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.helpers import to_local
from app.models.models import (
    DailySport,
    MedalDef,
    QuizRecord,
    RouteNode,
    User,
    UserEvent,
    UserMedal,
)
from app.services import event_service, march_service, org_service, points_service, streak_service

# 数据画像归一化配置（需求 §17.3：画像必须基于真实统计数据，各维度 0~100）。
# 满分参照值集中在此，调整口径只改配置。
PORTRAIT_DAYS_FULL = 30    # 行军：运动天数满分参照
PORTRAIT_STREAK_FULL = 30  # 坚持：连续天数满分参照
PORTRAIT_QUIZ_FULL = 50    # 知识：答题次数满分参照


def _portrait(
    total_steps: int,
    sport_days: int,
    current_streak: int,
    max_streak: int,
    route_total_steps: int,
    progress: int,
    quiz_total: int,
    correct_rate: int,
    owned_count: int,
    medal_total: int,
) -> Dict:
    """数据画像五维评分（§17.2：行军/坚持/知识/路线/成就；§17.4 只展示数据）。

    行军  = 累计步数（对路线全程目标）70% + 运动天数 30%
    坚持  = 最长连续 60% + 当前连续 40%
    知识  = 答题次数 50% + 正确率 50%
    路线  = 节点完成比例
    成就  = 勋章完成比例 70% + 连续行军里程碑达成档数（由最长连续推导）30%
    """
    steps_ref = route_total_steps if route_total_steps > 0 else 1
    march_v = total_steps / steps_ref * 70 + min(sport_days, PORTRAIT_DAYS_FULL) / PORTRAIT_DAYS_FULL * 30
    persistence_v = (
        min(max_streak, PORTRAIT_STREAK_FULL) / PORTRAIT_STREAK_FULL * 60
        + min(current_streak, PORTRAIT_STREAK_FULL) / PORTRAIT_STREAK_FULL * 40
    )
    knowledge_v = min(quiz_total, PORTRAIT_QUIZ_FULL) / PORTRAIT_QUIZ_FULL * 50 + correct_rate * 0.5
    medal_ratio = owned_count / medal_total if medal_total else 0
    streak_milestones = sum(1 for m in event_service.STREAK_MILESTONES if max_streak >= m)
    achievement_v = medal_ratio * 70 + streak_milestones / len(event_service.STREAK_MILESTONES) * 30
    return {
        "march": min(100, round(march_v)),
        "persistence": min(100, round(persistence_v)),
        "knowledge": min(100, round(knowledge_v)),
        "route": min(100, progress),
        "achievement": min(100, round(achievement_v)),
    }


def _join_days(created_at: Optional[datetime]) -> int:
    """加入天数（注册当天为第 1 天）。created_at 为 UTC 存储，按本地日期计。"""
    if created_at is None:
        return 1
    local_date = to_local(created_at).date()
    return max((datetime.now().date() - local_date).days + 1, 1)


def get_summary(db: Session, user: User) -> Dict:
    """档案页聚合：用户信息 + 运动/路线统计 + 答题 + 勋章 + 积分。"""
    sport_rows = (
        db.query(DailySport.steps, DailySport.distance)
        .filter(DailySport.user_id == user.id)
        .all()
    )
    total_steps = sum((r[0] or 0) for r in sport_rows)
    total_distance = round(sum(float(r[1] or 0) for r in sport_rows), 2)
    sport_days = len(sport_rows)
    max_day_steps = max((r[0] or 0) for r in sport_rows) if sport_rows else 0

    current_streak, max_streak = streak_service.compute_streaks(db, user.id)

    route = march_service.get_route(db, user.id)
    lit_count = route["lit_count"]
    total_count = route["total_count"]
    progress = round(lit_count / total_count * 100) if total_count else 0

    completed = [n for n in route["nodes"] if n["status"] == "completed"]
    last_lit = completed[-1] if completed else None
    current_node = (
        {"id": last_lit["id"], "name": last_lit["name"], "icon": last_lit["icon"]}
        if last_lit
        else None
    )
    next_raw = route["next_node"]
    next_node = (
        {
            "id": next_raw["id"],
            "name": next_raw["name"],
            "icon": next_raw["icon"],
            "remain": next_raw["remain"],
        }
        if next_raw
        else None
    )

    quiz_rows = db.query(QuizRecord).filter(QuizRecord.user_id == user.id).all()
    quiz_total = len(quiz_rows)
    answered = sum(r.total_count for r in quiz_rows)
    correct = sum(r.correct_count for r in quiz_rows)
    correct_rate = round(correct / answered * 100) if answered else 0
    full_score_count = sum(1 for r in quiz_rows if r.score >= 100)

    owned_count = db.query(UserMedal.id).filter(UserMedal.user_id == user.id).count()
    medal_total = db.query(MedalDef.id).count()

    org_name = org_service.get_full_name(db, user.org_id) if user.org_id else ""

    return {
        "user": {
            "nickname": user.nickname,
            "avatar": user.avatar or "",
            "org_name": org_name,
            "created_at": user.created_at,
            "join_days": _join_days(user.created_at),
        },
        "stats": {
            "total_steps": total_steps,
            "total_distance": total_distance,
            "sport_days": sport_days,
            "current_streak": current_streak,
            "max_streak": max_streak,
            "max_day_steps": max_day_steps,
            "avg_daily_steps": round(total_steps / sport_days) if sport_days else 0,
            "progress": progress,
            "lit_count": lit_count,
            "total_count": total_count,
            "current_node": current_node,
            "next_node": next_node,
        },
        "quiz": {
            "total_count": quiz_total,
            "correct_rate": correct_rate,
            "full_score_count": full_score_count,
        },
        "medals": {"owned_count": owned_count, "total_count": medal_total},
        "points": {"total": points_service.get_total(db, user.id)},
        "portrait": _portrait(
            total_steps=total_steps,
            sport_days=sport_days,
            current_streak=current_streak,
            max_streak=max_streak,
            route_total_steps=route["total_steps"],
            progress=progress,
            quiz_total=quiz_total,
            correct_rate=correct_rate,
            owned_count=owned_count,
            medal_total=medal_total,
        ),
    }


def get_timeline(db: Session, user_id: int, limit: int = 50) -> List[Dict]:
    """长征足迹时间轴（user_event 倒序，文案后端生成）。"""
    rows = (
        db.query(UserEvent)
        .filter(UserEvent.user_id == user_id)
        .order_by(UserEvent.event_time.desc(), UserEvent.id.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "event_type": r.event_type,
            "event_time": r.event_time,
            "text": event_service.build_text(r.event_type, r.event_data or {}),
            "data": r.event_data or {},
        }
        for r in rows
    ]
