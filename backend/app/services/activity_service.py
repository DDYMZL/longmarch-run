"""活动时间控制服务（V2.0 需求一）。

状态由服务器时间实时计算（不落库）：
  unpublished 未发布 / not_started 未开始 / ongoing 进行中 / ended 已结束。
准入口径：
  allow_participate：可产生新业务数据（步数同步、答题、积分、勋章、点亮）——仅 ongoing；
  allow_view：可查看历史成绩与排行——未结束时恒可查看，结束后取 allow_view_after_end。
  restrict_enabled=False 时两者恒为 True（仅展示状态，不拦截）。
配置不存在（如测试库未执行迁移）时按「不限制」处理，保证存量行为不变。
"""
from datetime import datetime
from typing import Dict, Optional

from sqlalchemy.orm import Session

from app.core.helpers import BEIJING_TZ, local_to_utc, now_utc, to_local
from app.models.models import ActivitySetting
from app.services import audit_service

SETTING_ID = 1

STATUS_UNPUBLISHED = "unpublished"
STATUS_NOT_STARTED = "not_started"
STATUS_ONGOING = "ongoing"
STATUS_ENDED = "ended"

STATUS_TEXT = {
    STATUS_UNPUBLISHED: "未发布",
    STATUS_NOT_STARTED: "未开始",
    STATUS_ONGOING: "进行中",
    STATUS_ENDED: "已结束",
}

DEFAULT_NAME = "长征步迹·荣耀征程"
DEFAULT_END_TITLE = "征程圆满 · 荣耀永驻"
DEFAULT_END_MESSAGE = "本次长征步迹活动已圆满结束，感谢每一位战友的坚持与奔跑。"

_BLOCK_MESSAGE = {
    STATUS_UNPUBLISHED: "活动暂未发布，敬请期待",
    STATUS_NOT_STARTED: "活动尚未开始，请于开始后参与",
    STATUS_ENDED: "活动已结束，暂不支持继续参与",
}


def get_setting(db: Session) -> Optional[ActivitySetting]:
    return db.query(ActivitySetting).filter(ActivitySetting.id == SETTING_ID).first()


def compute_status(setting: Optional[ActivitySetting], now: Optional[datetime] = None) -> str:
    if setting is None:
        return STATUS_ONGOING
    if not setting.is_published:
        return STATUS_UNPUBLISHED
    now = now or now_utc()
    if now < setting.start_at:
        return STATUS_NOT_STARTED
    if now >= setting.end_at:
        return STATUS_ENDED
    return STATUS_ONGOING


def _access(setting: Optional[ActivitySetting], status: str) -> Dict[str, bool]:
    if setting is None or not setting.restrict_enabled:
        return {"allow_participate": True, "allow_view": True}
    return {
        "allow_participate": status == STATUS_ONGOING,
        "allow_view": status != STATUS_ENDED or bool(setting.allow_view_after_end),
    }


def _bj(dt: Optional[datetime]) -> Optional[datetime]:
    """UTC naive -> 带 +08:00 时区的北京时间（序列化为 ISO 时带偏移，前端无歧义）。"""
    return to_local(dt).replace(tzinfo=BEIJING_TZ) if dt is not None else None


def get_status(db: Session) -> Dict:
    """小程序公开状态：名称、状态、起止时间、准入与提示文案、服务器时间。"""
    setting = get_setting(db)
    now = now_utc()
    status = compute_status(setting, now)
    access = _access(setting, status)
    if status == STATUS_ENDED:
        message = (setting.end_message if setting else None) or DEFAULT_END_MESSAGE
    else:
        message = "" if access["allow_participate"] else _BLOCK_MESSAGE.get(status, "")
    return {
        "name": setting.name if setting else DEFAULT_NAME,
        "status": status,
        "status_text": STATUS_TEXT[status],
        "start_at": _bj(setting.start_at) if setting else None,
        "end_at": _bj(setting.end_at) if setting else None,
        "allow_participate": access["allow_participate"],
        "allow_view": access["allow_view"],
        "restrict_enabled": bool(setting.restrict_enabled) if setting else False,
        "end_title": (setting.end_title if setting else None) or DEFAULT_END_TITLE,
        "message": message,
        "server_time": _bj(now),
    }


def check(db: Session, need_participate: bool) -> Optional[Dict]:
    """业务准入校验：通过返回 None，拒绝返回 {status, message}（供依赖层转 403）。"""
    setting = get_setting(db)
    status = compute_status(setting)
    access = _access(setting, status)
    allowed = access["allow_participate"] if need_participate else access["allow_view"]
    if allowed:
        return None
    return {"status": status, "message": _BLOCK_MESSAGE.get(status, "活动当前不可访问")}


def is_participation_open(db: Session) -> bool:
    return check(db, need_participate=True) is None


# ---------------- 管理端 ----------------
def get_admin_view(db: Session) -> Dict:
    setting = get_setting(db)
    return {
        **get_status(db),
        "is_published": bool(setting.is_published) if setting else False,
        "allow_view_after_end": bool(setting.allow_view_after_end) if setting else True,
        "end_message": (setting.end_message if setting else None) or "",
        "end_title": (setting.end_title if setting else None) or "",
        "updated_at": _bj(setting.updated_at) if setting else None,
        "updated_by": setting.updated_by if setting else None,
        "configured": setting is not None,
    }


def _ensure_setting(db: Session) -> ActivitySetting:
    setting = get_setting(db)
    if setting is None:
        now = now_utc()
        setting = ActivitySetting(
            id=SETTING_ID, name=DEFAULT_NAME, start_at=now, end_at=now, is_published=False
        )
        db.add(setting)
        db.flush()
    return setting


def _snapshot(s: ActivitySetting) -> Dict:
    return {
        "name": s.name,
        "start_at": to_local(s.start_at).strftime("%Y-%m-%d %H:%M") if s.start_at else None,
        "end_at": to_local(s.end_at).strftime("%Y-%m-%d %H:%M") if s.end_at else None,
        "is_published": bool(s.is_published),
        "restrict_enabled": bool(s.restrict_enabled),
        "allow_view_after_end": bool(s.allow_view_after_end),
        "end_title": s.end_title,
        "end_message": s.end_message,
    }


def update(
    db: Session,
    data: Dict,
    operator: str,
    actor_type: str,
    actor_id: Optional[int],
) -> Dict:
    """保存活动配置（北京时间入参，精确到分钟）；校验开始早于结束，变更与审计同一事务。"""
    start = local_to_utc(data["start_at"]).replace(second=0, microsecond=0)
    end = local_to_utc(data["end_at"]).replace(second=0, microsecond=0)
    if start >= end:
        raise ValueError("开始时间必须早于结束时间")
    name = (data.get("name") or "").strip()
    if not name:
        raise ValueError("活动名称不能为空")
    setting = _ensure_setting(db)
    before = _snapshot(setting)
    setting.name = name
    setting.start_at = start
    setting.end_at = end
    setting.restrict_enabled = bool(data["restrict_enabled"])
    setting.allow_view_after_end = bool(data["allow_view_after_end"])
    setting.end_title = (data.get("end_title") or "").strip() or None
    setting.end_message = (data.get("end_message") or "").strip() or None
    setting.updated_at = now_utc()
    setting.updated_by = operator
    audit_service.record(
        db, actor_type, actor_id, "activity.update", None,
        {"operator": operator, "before": before, "after": _snapshot(setting)},
    )
    db.commit()
    return get_admin_view(db)


def set_published(
    db: Session, published: bool, operator: str, actor_type: str, actor_id: Optional[int]
) -> Dict:
    setting = get_setting(db)
    if setting is None:
        raise ValueError("请先保存活动配置")
    setting.is_published = published
    setting.updated_at = now_utc()
    setting.updated_by = operator
    audit_service.record(
        db, actor_type, actor_id, "activity.publish" if published else "activity.unpublish", None,
        {"operator": operator, "name": setting.name},
    )
    db.commit()
    return get_admin_view(db)
