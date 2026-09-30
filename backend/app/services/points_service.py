"""积分服务（迁移自前端 services/points.js）。

积分规则：
  每日登录 +1；每日运动达 5000/10000 步 +5/+10；每日答题 +5、满分额外 +10；
  点亮历史节点 +10；完成长征路线 +100。
去重：同一原因每天最多发放一次（同日同 reason）。
"""
from typing import Dict, List

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.helpers import today_str
from app.models.models import PointsLog


def grant(db: Session, user_id: int, reason: str, delta: int) -> bool:
    """发放积分；同日同 reason 已存在则跳过。返回是否真正发放。"""
    date = today_str()
    exists = (
        db.query(PointsLog.id)
        .filter(
            PointsLog.user_id == user_id,
            PointsLog.date == date,
            PointsLog.reason == reason,
        )
        .first()
    )
    if exists:
        return False
    db.add(PointsLog(user_id=user_id, date=date, reason=reason, delta=delta))
    db.commit()
    return True


def grant_daily_login(db: Session, user_id: int) -> bool:
    """每日登录积分 +1。"""
    return grant(db, user_id, "每日登录", 1)


def get_total(db: Session, user_id: int) -> int:
    """积分总额。"""
    total = (
        db.query(func.coalesce(func.sum(PointsLog.delta), 0))
        .filter(PointsLog.user_id == user_id)
        .scalar()
    )
    return int(total or 0)


def get_logs(db: Session, user_id: int) -> List[Dict]:
    """积分流水（从新到旧）。"""
    rows = (
        db.query(PointsLog)
        .filter(PointsLog.user_id == user_id)
        .order_by(PointsLog.id.desc())
        .all()
    )
    return [{"date": r.date, "reason": r.reason, "delta": r.delta} for r in rows]
