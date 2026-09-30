"""运动数据服务（迁移自前端 services/sport.js）。

规则：按 user+date 保存每日步数，同日覆盖而非累加。
步数来源：正式版为微信运动 wx.getWeRunData 后端解密；未接入时用 seeded_steps 模拟。
"""
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.helpers import recent_dates, seeded_steps, today_str
from app.models.models import DailySport
from app.services import points_service

DAILY_TARGET = 10000  # 今日目标步数（展示用）


def _calc_total(db: Session, user_id: int) -> int:
    """累计有效步数（每日步数求和）。"""
    rows = db.query(DailySport.steps).filter(DailySport.user_id == user_id).all()
    return sum((r[0] or 0) for r in rows)


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

    value = steps if steps is not None else seeded_steps(date, user_id)
    db.add(DailySport(user_id=user_id, date=date, steps=value))
    db.commit()

    # 积分：≥10000 得 10，≥5000 得 5（取最高档）
    if value >= 10000:
        points_service.grant(db, user_id, "每日运动达到10000步", 10)
    elif value >= 5000:
        points_service.grant(db, user_id, "每日运动达到5000步", 5)

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
    record = (
        db.query(DailySport)
        .filter(DailySport.user_id == user_id, DailySport.date == date)
        .first()
    )
    if record is None:
        record = DailySport(user_id=user_id, date=date, steps=0)
        db.add(record)
    record.steps = (record.steps or 0) + delta
    db.commit()
    return {"date": date, "steps": record.steps, "total_steps": _calc_total(db, user_id)}
