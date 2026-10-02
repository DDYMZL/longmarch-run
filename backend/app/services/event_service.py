"""用户统一业务事件服务。

所有重要行为（运动 / 答题 / 点亮 / 勋章 / 连续行军 / 完成长征）统一落 user_event 表：
- 小程序「我的长征足迹」由该表直接生成；
- 管理端实时动态通过 WebSocket「activity」消息推送同一份文案。

事件在主数据提交后写入；事件写入失败不得影响主流程（调用方按既有的
medal_service.check_and_grant + ws 广播副作用链继续执行）。
"""
from datetime import datetime
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.core import ws as ws_manager
from app.models.models import User, UserEvent

# 连续行军里程碑（天）：达成时发放积分并写 STREAK_* 事件（一次性成就）
STREAK_MILESTONES: List[int] = [3, 7, 14, 30, 60]
MILESTONE_POINTS: Dict[int, int] = {3: 5, 7: 10, 14: 20, 30: 30, 60: 60}


def build_text(event_type: str, data: Optional[dict] = None) -> str:
    """按事件类型生成展示文案（足迹时间轴与管理端动态共用）。"""
    d = data or {}
    if event_type == "FIRST_STEP":
        return "首次完成运动同步，迈出长征第一步"
    if event_type == "DAILY_GOAL":
        return f"完成当日行军目标（{d.get('steps', 0)} 步），连续行军 {d.get('streak', 1)} 天"
    if event_type == "NODE_UNLOCK":
        return f"点亮「{d.get('nodeName', '')}」"
    if event_type == "CHAPTER_COMPLETE":
        return f"完成长征章节「{d.get('chapterName', '')}」"
    if event_type == "BADGE_UNLOCK":
        return f"获得勋章「{d.get('medalName', '')}」"
    if event_type == "QUIZ_COMPLETE":
        return f"完成今日答题，得分 {d.get('score', 0)}"
    if event_type == "QUIZ_FULL_SCORE":
        return "今日答题满分通关"
    if event_type.startswith("STREAK_"):
        return f"连续行军 {d.get('days', event_type[7:])} 天达成"
    if event_type == "STEP_10000":
        return "单日步数突破 10,000"
    if event_type == "TOTAL_STEPS_100000":
        return "累计步数突破 100,000"
    if event_type == "TOTAL_STEPS_500000":
        return "累计步数突破 500,000"
    if event_type == "COMPLETE_ROUTE":
        return "完成长征路线，全部节点点亮"
    return event_type


def has_event(db: Session, user_id: int, event_type: str) -> bool:
    """判断用户是否已产生过某类事件（一次性成就去重依据）。"""
    return (
        db.query(UserEvent.id)
        .filter(UserEvent.user_id == user_id, UserEvent.event_type == event_type)
        .first()
        is not None
    )


def record(
    db: Session,
    user_id: int,
    event_type: str,
    data: Optional[dict] = None,
    event_time: Optional[datetime] = None,
) -> UserEvent:
    """写入用户事件并广播管理端动态（activity 消息含文案与昵称）。"""
    event = UserEvent(
        user_id=user_id,
        event_type=event_type,
        event_data=data or {},
        event_time=event_time or datetime.utcnow(),
    )
    db.add(event)
    db.commit()

    nickname = ""
    user = db.query(User).filter(User.id == user_id).first()
    if user is not None:
        nickname = user.nickname or ""
    ws_manager.broadcast(
        ws_manager.build_activity(event_type, user_id, nickname, build_text(event_type, data))
    )
    return event
