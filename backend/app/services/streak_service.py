"""连续行军服务。

规则：当天步数 >= settings.STREAK_GOAL_STEPS（默认 5000）即完成当日行军。
- 写入侧（on_sport_written）：当日记录首次达标时推进连续天数、达成里程碑时
  发放积分并写 STREAK_* 事件（一次性成就，以事件表去重）；
- 读取侧（compute_streaks）：以 daily_sport.is_goal_completed 为准重算，
  「当前连续」允许今天尚未达标（连续算到昨天），今天昨天都未达标则为 0；
- users.continuous_days / max_continuous_days 为缓存，供管理端列表免逐户重算，
  启动时 recompute_all 全量兜底。
"""
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.models import DailySport, User
from app.services import event_service, points_service


def _goal_map(db: Session, user_id: int) -> Dict[str, bool]:
    """用户每日达标标记（date -> is_goal_completed）。"""
    rows = (
        db.query(DailySport.date, DailySport.is_goal_completed)
        .filter(DailySport.user_id == user_id)
        .all()
    )
    return {r[0]: bool(r[1]) for r in rows}


def compute_streaks(db: Session, user_id: int) -> Tuple[int, int]:
    """按记录重算（当前连续天数, 历史最长连续天数）。

    当前连续：从今天开始往前数连续达标日；今天未达标时允许从昨天开始数
    （今日尚未结束，连续仍然有效），昨天也未达标则为 0。
    """
    goals = _goal_map(db, user_id)
    if not goals:
        return 0, 0

    today = datetime.now().date()
    current = 0
    cursor = today
    if not goals.get(cursor.strftime("%Y-%m-%d"), False):
        cursor = today - timedelta(days=1)
    while goals.get(cursor.strftime("%Y-%m-%d"), False):
        current += 1
        cursor -= timedelta(days=1)

    best = 0
    run = 0
    for day in sorted(goals):
        if goals[day]:
            run += 1
            best = max(best, run)
        else:
            run = 0
    best = max(best, current)
    return current, best


def compute_run_with_min_steps(db: Session, user_id: int, min_steps: int) -> int:
    """历史最长「单日步数 >= min_steps」连续天数（隐藏勋章等判定用）。"""
    rows = (
        db.query(DailySport.date, DailySport.steps)
        .filter(DailySport.user_id == user_id)
        .order_by(DailySport.date.asc())
        .all()
    )
    best = 0
    run = 0
    for _date, steps in rows:
        if (steps or 0) >= min_steps:
            run += 1
            best = max(best, run)
        else:
            run = 0
    return best


def on_sport_written(db: Session, user_id: int, date: str) -> Optional[int]:
    """运动记录写入后的连续行军维护。

    当日首次达标（is_goal_completed 由 False 翻为 True）时：
    重算并更新 users 连续天数缓存；跨越里程碑（3/7/14/30/60）时发放积分、
    写 DAILY_GOAL / STREAK_* 事件。返回当日首次达标后的当前连续天数，未变化返回 None。
    """
    record = (
        db.query(DailySport)
        .filter(DailySport.user_id == user_id, DailySport.date == date)
        .first()
    )
    if record is None:
        return None

    reached = (record.steps or 0) >= settings.STREAK_GOAL_STEPS
    if reached == bool(record.is_goal_completed):
        return None  # 达标状态未变化，不产生新事件
    record.is_goal_completed = reached
    db.commit()
    if not reached:
        return None

    current, best = compute_streaks(db, user_id)
    user = db.query(User).filter(User.id == user_id).first()
    old_best = user.max_continuous_days if user else 0
    if user is not None:
        user.continuous_days = current
        user.max_continuous_days = max(best, old_best)
        db.commit()

    event_service.record(
        db, user_id, "DAILY_GOAL", {"date": date, "steps": record.steps, "streak": current}
    )

    for milestone in event_service.STREAK_MILESTONES:
        event_type = f"STREAK_{milestone}"
        if current >= milestone and old_best < milestone and not event_service.has_event(
            db, user_id, event_type
        ):
            points_service.grant(db, user_id, f"连续行军{milestone}天", event_service.MILESTONE_POINTS[milestone])
            event_service.record(db, user_id, event_type, {"days": milestone})
    return current


def recompute_all(db: Session) -> int:
    """启动兜底：全量重算 users 连续天数缓存（daily_sport 为准）。返回更新用户数。"""
    user_ids = [r[0] for r in db.query(User.id).all()]
    for uid in user_ids:
        current, best = compute_streaks(db, uid)
        db.query(User).filter(User.id == uid).update(
            {User.continuous_days: current, User.max_continuous_days: best},
            synchronize_session=False,
        )
    db.commit()
    return len(user_ids)
