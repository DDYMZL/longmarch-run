"""运动数据服务（迁移自前端 services/sport.js）。

规则：按 user+date 保存每日步数，同日覆盖而非累加。
步数来源：正式版为微信运动 wx.getWeRunData 后端解密；未接入时用 seeded_steps 模拟。

写入副作用：
- distance 按步长估算同步更新；is_goal_completed 与连续行军由 streak_service 维护；
- 事件：FIRST_STEP 首次运动 / DAILY_GOAL 当日达标（streak_service）/
  STEP_10000 单日破万 / TOTAL_STEPS_* 累计突破（均以事件表去重）。
"""
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.helpers import recent_dates, seeded_steps, today_str
from app.models.models import DailySport
from app.services import event_service, points_service, streak_service

DAILY_TARGET = 10000  # 今日目标步数（展示用）
TOTAL_MILESTONES = [(100000, "TOTAL_STEPS_100000"), (500000, "TOTAL_STEPS_500000")]


def _calc_total(db: Session, user_id: int) -> int:
    """累计有效步数（每日步数求和）。"""
    rows = db.query(DailySport.steps).filter(DailySport.user_id == user_id).all()
    return sum((r[0] or 0) for r in rows)


def _distance_of(steps: int) -> float:
    """按配置步长估算距离（km，保留两位）。"""
    return round(steps * settings.STRIDE_M / 1000, 2)


def _after_written(
    db: Session,
    user_id: int,
    date: str,
    record: DailySport,
    is_first_record: bool,
    prev_record_steps: int,
    prev_total: int,
) -> None:
    """运动写入后的统一副作用：连续行军 + 事件（均在主数据提交后触发）。"""
    if is_first_record:
        event_service.record(db, user_id, "FIRST_STEP", {"date": date, "steps": record.steps})

    streak_service.on_sport_written(db, user_id, date)

    if prev_record_steps < 10000 <= (record.steps or 0):
        event_service.record(db, user_id, "STEP_10000", {"date": date, "steps": record.steps})

    total = _calc_total(db, user_id)
    for threshold, event_type in TOTAL_MILESTONES:
        if prev_total < threshold <= total and not event_service.has_event(db, user_id, event_type):
            event_service.record(db, user_id, event_type, {"totalSteps": total})


def sync_today(db: Session, user_id: int, steps: Optional[int] = None) -> Dict:
    """同步今日步数。当天已有记录则保持不变（synced=False）；否则写入并发放达标积分。"""
    date = today_str()
    record = (
        db.query(DailySport)
        .filter(DailySport.user_id == user_id, DailySport.date == date)
        .first()
    )
    if record is not None:
        return {
            "date": date,
            "steps": record.steps,
            "total_steps": _calc_total(db, user_id),
            "synced": False,
        }

    prev_total = _calc_total(db, user_id)
    is_first_record = (
        db.query(DailySport.id).filter(DailySport.user_id == user_id).first() is None
    )
    value = steps if steps is not None else seeded_steps(date, user_id)
    record = DailySport(user_id=user_id, date=date, steps=value, distance=_distance_of(value))
    db.add(record)
    db.commit()

    # 积分：≥10000 得 10，≥5000 得 5（取最高档）
    if value >= 10000:
        points_service.grant(db, user_id, "每日运动达到10000步", 10)
    elif value >= 5000:
        points_service.grant(db, user_id, "每日运动达到5000步", 5)

    _after_written(db, user_id, date, record, is_first_record, 0, prev_total)

    return {
        "date": date,
        "steps": value,
        "total_steps": _calc_total(db, user_id),
        "synced": True,
    }


def get_today(db: Session, user_id: int) -> Dict:
    """今日步数概况。"""
    date = today_str()
    record = (
        db.query(DailySport)
        .filter(DailySport.user_id == user_id, DailySport.date == date)
        .first()
    )
    return {
        "date": date,
        "steps": record.steps if record else 0,
        "target": DAILY_TARGET,
        "total_steps": _calc_total(db, user_id),
    }


def get_recent(db: Session, user_id: int, n: int) -> List[Dict]:
    """最近 n 天运动记录（从旧到新）。"""
    dates = recent_dates(n)
    rows = (
        db.query(DailySport)
        .filter(DailySport.user_id == user_id, DailySport.date.in_(dates))
        .all()
    )
    step_map = {r.date: r.steps for r in rows}
    return [{"date": d, "steps": step_map.get(d, 0), "text": d[5:]} for d in dates]


def add_steps(db: Session, user_id: int, delta: int) -> Dict:
    """手动补充步数（演示用）：当天累加 delta，不触发达标积分。"""
    date = today_str()
    prev_total = _calc_total(db, user_id)
    record = (
        db.query(DailySport)
        .filter(DailySport.user_id == user_id, DailySport.date == date)
        .first()
    )
    is_first_record = record is None
    if record is None:
        record = DailySport(user_id=user_id, date=date, steps=0)
        db.add(record)
    prev_steps = record.steps or 0
    record.steps = prev_steps + delta
    record.distance = _distance_of(record.steps)
    db.commit()

    _after_written(db, user_id, date, record, is_first_record, prev_steps, prev_total)

    return {"date": date, "steps": record.steps, "total_steps": _calc_total(db, user_id)}
