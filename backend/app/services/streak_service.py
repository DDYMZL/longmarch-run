"""连续行军服务。

规则：当天步数 >= settings.STREAK_GOAL_STEPS（默认 5000）即完成当日行军。
- 写入侧（on_sport_written）：达标状态变化时重算连续天数缓存；首次达标并跨越里程碑时
  写 STREAK_* 事件（一次性成就，以事件表去重；V2.0 起里程碑不再发放积分）；
- 读取侧（compute_streaks）：以 daily_sport.is_goal_completed 为准重算，
  「当前连续」允许今天尚未达标（连续算到昨天），今天昨天都未达标则为 0；
- users.continuous_days / max_continuous_days 为缓存，供管理端列表免逐户重算，
  启动时 recompute_all 全量兜底。
"""
from datetime import date, timedelta
from typing import Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.helpers import now_beijing
from app.models.models import DailySport, User
from app.services import event_service


def longest_run(days: Iterable[str]) -> int:
    """日期集合（'YYYY-MM-DD'）中最长的连续自然日天数；缺记录的日期视为中断。"""
    best = run = 0
    prev: Optional[date] = None
    for day in sorted(set(days)):
        cur = date.fromisoformat(day)
        run = run + 1 if prev is not None and cur - prev == timedelta(days=1) else 1
        best = max(best, run)
        prev = cur
    return best


def streaks_of(achieved_days: Set[str]) -> Tuple[int, int]:
    """由达标日期集合计算（当前连续天数, 历史最长连续天数）。

    当前连续：从今天开始往前数连续达标日；今天未达标时允许从昨天开始数
    （今日尚未结束，连续仍然有效），昨天也未达标则为 0。
    """
    if not achieved_days:
        return 0, 0
    cursor = now_beijing().date()
    if cursor.isoformat() not in achieved_days:
        cursor -= timedelta(days=1)
    current = 0
    while cursor.isoformat() in achieved_days:
        current += 1
        cursor -= timedelta(days=1)
    return current, max(longest_run(achieved_days), current)


def compute_streaks(db: Session, user_id: int) -> Tuple[int, int]:
    """按 daily_sport.is_goal_completed 重算（当前连续天数, 历史最长连续天数）。"""
    rows = (
        db.query(DailySport.date)
        .filter(DailySport.user_id == user_id, DailySport.is_goal_completed.is_(True))
        .all()
    )
    return streaks_of({r[0] for r in rows})


def on_sport_written(db: Session, user_id: int, date: str) -> Optional[int]:
    """运动记录写入后的连续行军维护。

    当日首次达标（is_goal_completed 由 False 翻为 True）时：
    重算并更新 users 连续天数缓存；跨越里程碑（3/7/14/30/60）时
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

    current, best = compute_streaks(db, user_id)
    user = db.query(User).filter(User.id == user_id).first()
    old_best = user.max_continuous_days if user else 0
    if user is not None:
        user.continuous_days = current
        user.max_continuous_days = best
        db.commit()
    if not reached:
        return None

    event_service.record(
        db, user_id, "DAILY_GOAL", {"date": date, "steps": record.steps, "streak": current}
    )

    for milestone in event_service.STREAK_MILESTONES:
        event_type = f"STREAK_{milestone}"
        if current >= milestone and old_best < milestone and not event_service.has_event(
            db, user_id, event_type
        ):
            event_service.record(db, user_id, event_type, {"days": milestone})
    return current


def recompute_all(db: Session) -> int:
    """启动兜底：全量重算 users 连续天数缓存（daily_sport 为准）。返回更新用户数。

    达标记录按用户流式分组计算，只回写与缓存不一致的用户，避免逐户查询。
    """
    achieved: Dict[int, Set[str]] = {}
    rows = (
        db.query(DailySport.user_id, DailySport.date)
        .filter(DailySport.is_goal_completed.is_(True))
        .yield_per(5000)
    )
    for uid, day in rows:
        achieved.setdefault(uid, set()).add(day)

    changes: List[Dict] = []
    for uid, cached_current, cached_best in db.query(
        User.id, User.continuous_days, User.max_continuous_days
    ).yield_per(5000):
        current, best = streaks_of(achieved.get(uid, set()))
        if (current, best) != (cached_current or 0, cached_best or 0):
            changes.append({"id": uid, "continuous_days": current, "max_continuous_days": best})
    if changes:
        db.bulk_update_mappings(User, changes)
        db.commit()
    return len(changes)
