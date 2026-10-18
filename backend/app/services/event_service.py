"""用户统一业务事件服务。

所有重要行为（运动 / 答题 / 点亮 / 勋章 / 连续行军 / 完成长征）统一落 user_event 表：
- 小程序「我的长征足迹」由该表直接生成；
- 管理端实时动态通过 WebSocket「activity」消息推送同一份文案。

事件在主数据提交后写入；事件写入失败不得影响主流程（调用方按既有的
medal_service.check_and_grant + ws 广播副作用链继续执行）。
"""
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core import ws as ws_manager
from app.models.models import User, UserEvent
from app.services import operation_config_service

# 连续行军里程碑（天）：达成时写 STREAK_* 事件（一次性成就）
STREAK_MILESTONES: List[int] = [3, 7, 14, 30, 60]

# 邀请漏斗埋点（点13 数据运营分析）：仅供分析统计，不进入公开/管理端实时动态流。
INVITE_SCAN = "INVITE_SCAN"  # 扫码/校验邀请码（匿名，user_id 为空，按邀请码分组）
FIRST_LOGIN = "FIRST_LOGIN"  # 新用户首次登录
# 分析型事件：不在「实时行军动态」与「管理端动态」中展示，也不 WS 广播。
ANALYTICS_EVENTS = {INVITE_SCAN, FIRST_LOGIN}


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
    if event_type == INVITE_SCAN:
        return "扫码校验邀请码"
    if event_type == FIRST_LOGIN:
        return "首次登录长征步迹"
    return event_type


def has_event(db: Session, user_id: int, event_type: str) -> bool:
    """判断用户是否已产生过某类事件（一次性成就去重依据）。"""
    return (
        db.query(UserEvent.id)
        .filter(UserEvent.user_id == user_id, UserEvent.event_type == event_type)
        .first()
        is not None
    )


def extract_node_id(event_type: str, data: Optional[dict] = None) -> Optional[int]:
    """从事件参数提取下钻用 nodeId（#9）：仅节点类事件（NODE_UNLOCK 等）含 nodeId。

    供实时动态（list_public_activities）与 WS 广播（record）统一附带 nodeId，
    使前端点击动态可下钻到对应节点；无 nodeId 的事件返回 None。
    """
    d = data or {}
    raw = d.get("nodeId")
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def mask_nickname(nickname: str) -> str:
    """昵称脱敏（需求 §8.5：ACTIVITY_MASK_NICKNAME 开启时用于对外实时动态）。"""
    n = (nickname or "").strip()
    if not n:
        return "战友"
    if len(n) == 1:
        return n
    if len(n) == 2:
        return n[0] + "*"
    return n[0] + "*" + n[-1]


def recent_events(db: Session, limit: int) -> List[Tuple[UserEvent, str]]:
    """最近 limit 条事件及其用户昵称（单次外连接查询，事件倒序）。

    过滤分析型事件（INVITE_SCAN/FIRST_LOGIN）：它们仅供运营漏斗统计，
    不进入小程序实时动态与管理端动态流。
    """
    rows = (
        db.query(UserEvent, User.nickname)
        .outerjoin(User, User.id == UserEvent.user_id)
        .filter(UserEvent.event_type.notin_(ANALYTICS_EVENTS))
        .order_by(UserEvent.event_time.desc(), UserEvent.id.desc())
        .limit(limit)
        .all()
    )
    return [(event, nickname or "") for event, nickname in rows]


def list_public_activities(db: Session, limit: int = 10) -> List[Dict]:
    """小程序实时行军动态（user_event 倒序，关联昵称）。

    隐私边界（需求 §8.5）：只下发昵称 / 行为文案 / 事件类型与时间，
    不含 user_id、openid 与事件参数；运营参数 activity_mask_nickname 开启时昵称脱敏。
    """
    mask = operation_config_service.get_effective(db).activity_mask_nickname
    return [
        {
            "id": r.id,
            "event_type": r.event_type,
            "event_time": r.event_time,
            "nickname": mask_nickname(nickname) if mask else nickname,
            "text": build_text(r.event_type, r.event_data or {}),
            "node_id": extract_node_id(r.event_type, r.event_data or {}),
        }
        for r, nickname in recent_events(db, limit)
    ]


def record(
    db: Session,
    user_id: Optional[int],
    event_type: str,
    data: Optional[dict] = None,
    event_time: Optional[datetime] = None,
) -> UserEvent:
    """写入用户事件并广播管理端动态（activity 消息含文案与昵称）。

    分析型事件（INVITE_SCAN/FIRST_LOGIN）仅供运营漏斗统计：user_id 可为空（匿名扫码），
    不查询昵称、不 WS 广播，避免污染实时动态流。
    """
    event = UserEvent(
        user_id=user_id,
        event_type=event_type,
        event_data=data or {},
        event_time=event_time or datetime.utcnow(),
    )
    db.add(event)
    db.commit()

    if event_type in ANALYTICS_EVENTS:
        return event

    nickname = db.query(User.nickname).filter(User.id == user_id).scalar() or ""
    if operation_config_service.get_effective(db).activity_mask_nickname:
        nickname = mask_nickname(nickname)
    ws_manager.broadcast(
        ws_manager.build_activity(
            event_type, user_id, nickname, build_text(event_type, data),
            extract_node_id(event_type, data),
        )
    )
    return event
