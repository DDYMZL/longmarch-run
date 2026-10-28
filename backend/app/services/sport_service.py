"""运动数据服务（迁移自前端 services/sport.js）。

规则：按 user+date 保存每日步数，微信最近 7 日数据逐日覆盖而非累加；
同步窗口按 PC 端配置的活动开始日（activity_settings.start_at，北京时间）过滤，开始日之前不写入；
每次写入在同一事务内按运动源数据全量核对修复该用户步行台账（见 points_service.recompute_walk），
保证累计步行积分 = 累计计分步数 // 1000，重复同步幂等。
步数来源：前端 wx.getWeRunData 加密数据，后端 code2Session 换 session_key 解密 stepInfoList；
仅 mock 登录用户（开发模式）或未配置微信凭证时回退 seeded_steps 模拟，真实用户绝不编造步数。

写入副作用：
- distance 按步长估算同步更新；is_goal_completed 与连续行军由 streak_service 维护；
- 事件：FIRST_STEP 首次运动 / DAILY_GOAL 当日达标（streak_service）/
  STEP_10000 单日破万 / TOTAL_STEPS_* 累计突破（均以事件表去重）。
"""
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.helpers import BEIJING_TZ, local_to_utc, now_utc, recent_dates, seeded_steps, to_local, today_str
from app.core.wx import code2session, decrypt_werun
from app.models.models import DailySport, LitNode, QuizRecord, RouteNode, User
from app.services import activity_service, event_service, operation_config_service, points_service, streak_service

DAILY_TARGET = 20000  # 今日目标步数（展示用）
TOTAL_MILESTONES = [(100000, "TOTAL_STEPS_100000"), (500000, "TOTAL_STEPS_500000")]


def get_total_steps(db: Session, user_id: int) -> int:
    """累计有效步数（每日步数求和，库内聚合）。"""
    total = (
        db.query(func.coalesce(func.sum(DailySport.steps), 0))
        .filter(DailySport.user_id == user_id)
        .scalar()
    )
    return int(total or 0)


def _distance_of(steps: int, stride_m: float) -> float:
    """按步长估算距离（km，保留两位）；stride_m 取自运营参数快照。"""
    return round(steps * stride_m / 1000, 2)


def _after_written(
    db: Session,
    user_id: int,
    date: str,
    record: DailySport,
    is_first_record: bool,
    prev_record_steps: int,
    prev_total: int,
) -> int:
    """运动写入后的统一副作用：连续行军 + 事件（均在主数据提交后触发）。返回写入后累计步数。"""
    if is_first_record:
        event_service.record(db, user_id, "FIRST_STEP", {"date": date, "steps": record.steps})

    streak_service.on_sport_written(db, user_id, date)

    if prev_record_steps < 10000 <= (record.steps or 0):
        event_service.record(db, user_id, "STEP_10000", {"date": date, "steps": record.steps})

    total = prev_total - prev_record_steps + (record.steps or 0)
    for threshold, event_type in TOTAL_MILESTONES:
        if prev_total < threshold <= total and not event_service.has_event(db, user_id, event_type):
            event_service.record(db, user_id, event_type, {"totalSteps": total})
    return total


def _resolve_steps(
    openid: str,
    code: Optional[str],
    encrypted_data: Optional[str],
    iv: Optional[str],
    date: str,
    user_id: int,
) -> Dict[str, int]:
    """确定本次同步的步数 {日期: 步数}（北京时间自然日），范围以微信实际返回为准。

    - 已配置微信凭证且携带加密数据：code 换 session_key 解密 stepInfoList；任何环节失败抛 ValueError；
    - 其余情况：仅 mock 登录用户（开发模式）或未配置微信凭证时回退 seeded_steps 模拟最近 7 日；
    - 真实用户未携带数据：抛 ValueError，绝不写入编造步数。
    """
    has_creds = bool(settings.WX_APPID and settings.WX_SECRET)
    if has_creds and code and encrypted_data and iv:
        session_info = code2session(code)
        if not session_info or not session_info.get("session_key"):
            raise ValueError("微信会话换取失败，请重新同步")
        payload = decrypt_werun(session_info["session_key"], encrypted_data, iv)
        steps: Dict[str, int] = {}
        for item in payload.get("stepInfoList") or []:
            ts = item.get("timestamp")
            if ts:
                day = datetime.fromtimestamp(int(ts), BEIJING_TZ).strftime("%Y-%m-%d")
                steps[day] = int(item.get("step") or 0)
        if not steps:
            raise ValueError("微信运动本次未返回可用步数，请稍后重试")
        return steps
    if openid.startswith("mock_") or not has_creds:
        return {day: seeded_steps(day, user_id) for day in recent_dates(7)}
    raise ValueError("未获取到微信运动数据，请在小程序内重新同步")


def _lock_day(db: Session, user_id: int, date: str) -> Optional[DailySport]:
    return (
        db.query(DailySport)
        .filter(DailySport.user_id == user_id, DailySport.date == date)
        .with_for_update()
        .first()
    )


def _upsert_day(
    db: Session, user_id: int, date: str, steps: int, source: str, stride_m: float
) -> Tuple[DailySport, int, bool, bool]:
    """锁内按微信最终值覆盖某日记录，返回（记录、原步数、是否新建、是否变化）。"""
    record = _lock_day(db, user_id, date)
    created = record is None
    if created:
        record = DailySport(user_id=user_id, date=date, steps=steps, distance=_distance_of(steps, stride_m))
        db.add(record)
        previous = 0
    else:
        previous = record.steps or 0
        record.steps = steps
        record.distance = _distance_of(steps, stride_m)
    record.source = source
    record.synced_at = now_utc()
    record.sync_status = "processed"
    record.fail_reason = None  # 成功入账，清除历史失败标记
    db.flush()
    return record, previous, created, created or previous != steps


def _mark_failed(db: Session, user_id: int, date: str, reason: str, source: str) -> None:
    """把某日标记为同步失败（sync_status='failed' + fail_reason），供管理端失败清单只读感知。

    无记录时以 steps=0 占位（不计入累计步数与积分）。已有记录分两种（#3）：
    - 仍是 steps=0 的占位行：本次未取到数据，降级为 failed + fail_reason，保留在失败清单；
    - 已有真实步数（steps>0）：说明历史已成功入账，本次缺该日数据不应把它误判为失败，
      只更新 synced_at（最近尝试时间），不改 sync_status/fail_reason，避免污染失败清单。
    不提交，由调用方统一提交。
    """
    record = _lock_day(db, user_id, date)
    if record is None:
        db.add(
            DailySport(
                user_id=user_id,
                date=date,
                steps=0,
                distance=0,
                source=source,
                synced_at=now_utc(),
                sync_status="failed",
                fail_reason=reason[:200],
            )
        )
    elif (record.steps or 0) == 0:
        record.synced_at = now_utc()
        record.sync_status = "failed"
        record.fail_reason = reason[:200]
    else:
        # 已有真实步数：仅刷新最近同步尝试时间，保留既有成功状态，不降级为失败。
        record.synced_at = now_utc()
    db.flush()


def _activity_start_date(db: Session) -> Optional[str]:
    """PC 端（管理后台）配置的活动开始日（北京时间自然日，YYYY-MM-DD）。

    未配置（activity_settings 无行）时返回 None，表示不过滤，保证存量行为不变；
    步数同步只允许写入不早于该日的日期，活动开始前的数据一律不入账（不追溯历史存量数据）。
    """
    setting = activity_service.get_setting(db)
    if setting is None:
        return None
    return to_local(setting.start_at).strftime("%Y-%m-%d")


def sync_today(
    db: Session,
    user_id: int,
    openid: str = "",
    code: Optional[str] = None,
    encrypted_data: Optional[str] = None,
    iv: Optional[str] = None,
) -> Dict:
    """同步微信运动最近 7 个北京时间自然日，逐日覆盖并按源数据全量修复步行台账（幂等）。

    同步窗口再按 PC 端配置的活动开始日（activity_settings.start_at，北京时间）过滤：
    开始日之前的日期不写入、不标记失败，活动前数据一律不入账。
    微信数据缺失的日期不写 0、不覆盖已有记录，作为 failed_dates 返回并允许后续重试。
    """
    date = today_str()
    start_date = _activity_start_date(db)
    expected_dates = [d for d in recent_dates(7) if start_date is None or d >= start_date]
    steps_by_date = _resolve_steps(openid, code, encrypted_data, iv, date, user_id)
    source = "mock" if openid.startswith("mock_") or not (settings.WX_APPID and settings.WX_SECRET) else "werun"
    cfg = operation_config_service.get_effective(db)
    db.query(User.id).filter(User.id == user_id).with_for_update().first()
    before_points = points_service.get_total(db, user_id)
    prev_total_steps = get_total_steps(db, user_id)
    # 仅按真实步数（steps>0）判定是否首次运动：失败占位行（steps=0）不应抑制 FIRST_STEP。
    had_any = (
        db.query(DailySport.id)
        .filter(DailySport.user_id == user_id, DailySport.steps > 0)
        .first()
        is not None
    )

    processed: List[str] = []
    failed = [
        {"date": day, "reason": "微信运动本次未返回该日数据，可稍后重试"}
        for day in expected_dates
        if day not in steps_by_date
    ]
    written: List[Tuple[str, DailySport, int, bool]] = []
    for day in expected_dates:
        if day not in steps_by_date:
            continue
        try:
            value = int(steps_by_date[day])
        except (TypeError, ValueError):
            failed.append({"date": day, "reason": "微信运动返回的步数格式无效"})
            continue
        if value < 0:
            failed.append({"date": day, "reason": "微信运动返回的步数无效"})
            continue
        record, previous, created, changed = _upsert_day(db, user_id, day, value, source, cfg.stride_m)
        processed.append(day)
        if changed:
            written.append((day, record, previous, created))

    # 持久化同步失败日期（点13）：供管理端「同步失败清单」只读感知，允许后续重试覆盖。
    for item in failed:
        _mark_failed(db, user_id, item["date"], item["reason"], source)

    if processed:
        points_service.recompute_walk(db, user_id)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ValueError("步数同步冲突，请稍后重试")

    total = prev_total_steps
    for day, record, previous, created in written:
        total = _after_written(db, user_id, day, record, created and not had_any, previous, total)
        had_any = True

    today_steps = db.query(DailySport.steps).filter(
        DailySport.user_id == user_id, DailySport.date == date
    ).scalar()
    after_points = points_service.get_total(db, user_id)
    return {
        "date": date,
        "steps": int(today_steps or 0),
        "total_steps": get_total_steps(db, user_id),
        "synced": any(day == date for day, _record, _previous, _created in written),
        "status": "success" if not failed else "partial",
        "processed_dates": processed,
        "failed_dates": failed,
        "points_change": after_points - before_points,
        "today_walk_points": points_service.walk_on(db, user_id, date),
        "walk_carry": points_service.walk_carry(db, user_id, cfg),
    }


def get_today(db: Session, user_id: int) -> Dict:
    """今日步数概况（含连续行军卡片字段）。"""
    date = today_str()
    record = (
        db.query(DailySport)
        .filter(DailySport.user_id == user_id, DailySport.date == date)
        .first()
    )
    current_streak, max_streak = streak_service.compute_streaks(db, user_id)
    next_milestone = next(
        (m for m in event_service.STREAK_MILESTONES if m > current_streak), None
    )
    return {
        "date": date,
        "steps": record.steps if record else 0,
        "target": DAILY_TARGET,
        "total_steps": get_total_steps(db, user_id),
        "current_streak": current_streak,
        "max_streak": max_streak,
        "streak_goal": operation_config_service.get_effective(db).streak_goal_steps,
        "today_goal_completed": bool(record.is_goal_completed) if record else False,
        "next_streak_milestone": next_milestone,
        "streak_remain": (next_milestone - current_streak) if next_milestone else 0,
    }


def _level_of(steps: int) -> int:
    """日历热力档位：0=0 步 / 1=1~4999 / 2=5000~9999 / 3=10000+。"""
    if steps >= 10000:
        return 3
    if steps >= 5000:
        return 2
    return 1 if steps > 0 else 0


def get_calendar(db: Session, user_id: int, month: str) -> Dict:
    """行军日历（功能 3）：整月逐日步数档位 + 答题/点亮标记 + 月度统计。"""
    year, mon = int(month[:4]), int(month[5:7])
    month_start = datetime(year, mon, 1)
    if mon == 12:
        month_end = datetime(year + 1, 1, 1)
    else:
        month_end = datetime(year, mon + 1, 1)
    days_in_month = (month_end - month_start).days
    dates = [f"{year:04d}-{mon:02d}-{d:02d}" for d in range(1, days_in_month + 1)]

    sport_rows = (
        db.query(DailySport)
        .filter(DailySport.user_id == user_id, DailySport.date.in_(dates))
        .all()
    )
    sport_map = {r.date: r for r in sport_rows}

    quiz_rows = (
        db.query(QuizRecord.date, QuizRecord.score)
        .filter(QuizRecord.user_id == user_id, QuizRecord.date.in_(dates))
        .all()
    )
    quiz_map = {r[0]: r[1] for r in quiz_rows}

    lit_rows = (
        db.query(LitNode.lit_at, RouteNode.name)
        .join(RouteNode, RouteNode.id == LitNode.node_id)
        .filter(
            LitNode.user_id == user_id,
            LitNode.lit_at >= local_to_utc(month_start),
            LitNode.lit_at < local_to_utc(month_end),
        )
        .all()
    )
    lit_map: Dict[str, List[str]] = {}
    for lit_at, name in lit_rows:
        # lit_at 为 UTC 存储，按本地日期归入格子
        lit_map.setdefault(to_local(lit_at).strftime("%Y-%m-%d"), []).append(name)

    days: List[Dict] = []
    for d in dates:
        record = sport_map.get(d)
        steps = record.steps if record else 0
        days.append(
            {
                "date": d,
                "steps": steps,
                "level": _level_of(steps),
                "goal_completed": bool(record.is_goal_completed) if record else False,
                "quiz_done": d in quiz_map,
                "quiz_score": quiz_map.get(d, 0),
                "lit_nodes": lit_map.get(d, []),
            }
        )

    month_steps = sum(d["steps"] for d in days)
    sport_days = sum(1 for d in days if d["steps"] > 0)
    current_streak, _best = streak_service.compute_streaks(db, user_id)

    return {
        "month": month,
        "days": days,
        "stats": {
            "month_steps": month_steps,
            "sport_days": sport_days,
            "avg_steps": round(month_steps / sport_days) if sport_days else 0,
            "max_steps": max((d["steps"] for d in days), default=0),
            "current_streak": current_streak,
        },
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


def get_records(db: Session, user_id: int, page: int = 1, page_size: int = 20) -> Dict:
    """分页运动记录（工作流 A7，新到旧）+ 全局汇总（累计/平均步数，基于全量非当页）。

    仅返回有效记录（steps>0），排除同步失败占位行；avgSteps 按有步数天数取整。
    """
    query = db.query(DailySport).filter(
        DailySport.user_id == user_id, DailySport.steps > 0
    )
    total = query.count()
    rows = (
        query.order_by(DailySport.date.desc())
        .offset((page - 1) * page_size)
        .limit(page_size + 1)
        .all()
    )
    has_more = len(rows) > page_size
    total_steps, active_days = (
        db.query(
            func.coalesce(func.sum(DailySport.steps), 0),
            func.count(DailySport.id),
        )
        .filter(DailySport.user_id == user_id, DailySport.steps > 0)
        .first()
    )
    total_steps = int(total_steps or 0)
    active_days = int(active_days or 0)
    return {
        "items": [
            {
                "date": r.date,
                "text": r.date[5:] if r.date else "",
                "steps": int(r.steps or 0),
                "distance": float(r.distance or 0),
            }
            for r in rows[:page_size]
        ],
        "total": int(total),
        "page": page,
        "page_size": page_size,
        "has_more": has_more,
        "total_steps": total_steps,
        "avg_steps": round(total_steps / active_days) if active_days > 0 else 0,
    }


def add_steps(db: Session, user_id: int, delta: int) -> None:
    """手动补充步数（演示用）：当天累加 delta，并按运动源数据全量修复步行台账。"""
    date = today_str()
    prev_total = get_total_steps(db, user_id)
    is_first_record = db.query(DailySport.id).filter(DailySport.user_id == user_id).first() is None
    db.query(User.id).filter(User.id == user_id).with_for_update().first()
    existing = _lock_day(db, user_id, date)
    value = (existing.steps or 0) + delta if existing is not None else delta
    stride_m = operation_config_service.get_effective(db).stride_m
    record, prev_steps, created, changed = _upsert_day(db, user_id, date, value, "manual", stride_m)
    points_service.recompute_walk(db, user_id)
    db.commit()
    if changed:
        _after_written(db, user_id, date, record, created and is_first_record, prev_steps, prev_total)
