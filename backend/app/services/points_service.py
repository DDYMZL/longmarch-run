"""积分台账服务（V2.0）：总积分 = 步行积分 + 答题积分，全部由后端按源数据计算。

规则（参数见 Settings.POINTS_*）：
  步行：每自然日 floor(min(当日步数, 20000) / 1000)，单日最高 20；
  答题：每答对 1 题 +2，不扣分，单日最高 10。
台账：每人每来源每自然日一行（biz_key = walk:日期 / quiz:日期，唯一约束），
  业务写入时在同一事务内按源数据重算覆盖（set_daily 不提交，由调用方统一提交），
  重复同步/重放请求/并发只会得到同一结果，不会重复计分。
  V2.0 之前的旧规则流水（source_type=legacy）保留追溯，不计入总积分。
校验：recompute_all 按源数据（daily_sport / quiz_records）全量核对并可修复台账。
"""
from datetime import datetime
from typing import Dict, Iterable, List, Optional, Tuple

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.helpers import today_str
from app.models.models import DailyQuestion, DailySport, PointsLog, QuizRecord, User

WALK = "walk"
QUIZ = "quiz"
SOURCES = (WALK, QUIZ)
REASONS = {WALK: "步行积分", QUIZ: "答题积分"}
RECOMPUTE_BATCH = 500


def walk_points(steps: int) -> int:
    capped = min(max(int(steps or 0), 0), settings.POINTS_WALK_STEP_CAP)
    return capped // settings.POINTS_WALK_STEPS_PER_POINT


def quiz_points(correct_count: int) -> int:
    earned = max(int(correct_count or 0), 0) * settings.POINTS_QUIZ_PER_CORRECT
    return min(earned, settings.POINTS_QUIZ_DAILY_CAP)


def biz_key(source: str, date: str) -> str:
    return f"{source}:{date}"


def set_daily(
    db: Session, user_id: int, source: str, date: str, delta: int, ref_id: Optional[int]
) -> bool:
    """把某来源某日积分设为 delta（行锁内覆盖，不提交）。返回台账是否发生变化。"""
    key = biz_key(source, date)
    row = (
        db.query(PointsLog)
        .filter(PointsLog.user_id == user_id, PointsLog.biz_key == key)
        .with_for_update()
        .first()
    )
    if row is None:
        if delta <= 0:
            return False
        db.add(
            PointsLog(
                user_id=user_id,
                date=date,
                reason=REASONS[source],
                delta=delta,
                source_type=source,
                ref_id=ref_id,
                biz_key=key,
            )
        )
        return True
    if row.delta == delta and row.ref_id == ref_id:
        return False
    row.delta, row.ref_id, row.updated_at = delta, ref_id, datetime.utcnow()
    return True


def sync_walk_day(db: Session, record: DailySport) -> bool:
    """按当日最终步数重算步行积分（调用方需已锁定 daily_sport 行并负责提交）。"""
    return set_daily(db, record.user_id, WALK, record.date, walk_points(record.steps), record.id)


def sync_quiz_day(
    db: Session, user_id: int, date: str, correct_count: int, ref_id: Optional[int]
) -> bool:
    """按当日答对题数重算答题积分（调用方负责提交）。"""
    return set_daily(db, user_id, QUIZ, date, quiz_points(correct_count), ref_id)


def points_subquery(db: Session):
    """每人积分汇总子查询：列 user_id / walk / quiz / total（只统计 walk + quiz）。"""
    walk = func.coalesce(func.sum(case((PointsLog.source_type == WALK, PointsLog.delta), else_=0)), 0)
    quiz = func.coalesce(func.sum(case((PointsLog.source_type == QUIZ, PointsLog.delta), else_=0)), 0)
    return (
        db.query(
            PointsLog.user_id.label("user_id"),
            walk.label("walk"),
            quiz.label("quiz"),
            (walk + quiz).label("total"),
        )
        .filter(PointsLog.source_type.in_(SOURCES))
        .group_by(PointsLog.user_id)
        .subquery()
    )


def _sum_by_source(db: Session, user_id: int, date: Optional[str] = None) -> Dict[str, int]:
    query = db.query(PointsLog.source_type, func.coalesce(func.sum(PointsLog.delta), 0)).filter(
        PointsLog.user_id == user_id, PointsLog.source_type.in_(SOURCES)
    )
    if date is not None:
        query = query.filter(PointsLog.date == date)
    sums = {source: int(total or 0) for source, total in query.group_by(PointsLog.source_type).all()}
    return {WALK: sums.get(WALK, 0), QUIZ: sums.get(QUIZ, 0)}


def get_breakdown(db: Session, user_id: int) -> Dict[str, int]:
    """{total, walk, quiz}：total 恒等于 walk + quiz。"""
    sums = _sum_by_source(db, user_id)
    return {"total": sums[WALK] + sums[QUIZ], "walk": sums[WALK], "quiz": sums[QUIZ]}


def get_total(db: Session, user_id: int) -> int:
    return get_breakdown(db, user_id)["total"]


def get_summary(db: Session, user_id: int) -> Dict:
    """积分概览：累计三项 + 今日两项（含今日步数/答对数，供展示计分依据）。"""
    date = today_str()
    today = _sum_by_source(db, user_id, date)
    sport = (
        db.query(DailySport.steps)
        .filter(DailySport.user_id == user_id, DailySport.date == date)
        .scalar()
    )
    correct = (
        db.query(QuizRecord.correct_count)
        .filter(QuizRecord.user_id == user_id, QuizRecord.date == date)
        .scalar()
    )
    return {
        **get_breakdown(db, user_id),
        "today_walk": today[WALK],
        "today_quiz": today[QUIZ],
        "today_steps": int(sport or 0),
        "today_correct": int(correct or 0),
        "rules": rules(),
    }


def rules() -> Dict[str, int]:
    walk_cap = settings.POINTS_WALK_STEP_CAP // settings.POINTS_WALK_STEPS_PER_POINT
    return {
        "walk_steps_per_point": settings.POINTS_WALK_STEPS_PER_POINT,
        "walk_step_cap": settings.POINTS_WALK_STEP_CAP,
        "walk_daily_cap": walk_cap,
        "quiz_per_correct": settings.POINTS_QUIZ_PER_CORRECT,
        "quiz_daily_cap": settings.POINTS_QUIZ_DAILY_CAP,
    }


def get_daily_details(db: Session, user_id: int, page: int = 1, page_size: int = 20) -> Dict:
    """积分明细（按自然日倒序分页）：每天步行/答题积分及其计分依据。"""
    base = db.query(PointsLog.date).filter(
        PointsLog.user_id == user_id, PointsLog.source_type.in_(SOURCES)
    )
    total_days = base.distinct().count()
    dates = [
        d
        for (d,) in base.distinct()
        .order_by(PointsLog.date.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    ]
    if not dates:
        return {"total": total_days, "items": []}

    by_date: Dict[str, Dict[str, int]] = {d: {WALK: 0, QUIZ: 0} for d in dates}
    updated: Dict[str, datetime] = {}
    for date, source, delta, updated_at in db.query(
        PointsLog.date, PointsLog.source_type, PointsLog.delta, PointsLog.updated_at
    ).filter(
        PointsLog.user_id == user_id,
        PointsLog.source_type.in_(SOURCES),
        PointsLog.date.in_(dates),
    ):
        by_date[date][source] = int(delta or 0)
        if updated_at and (date not in updated or updated_at > updated[date]):
            updated[date] = updated_at
    steps = dict(
        db.query(DailySport.date, DailySport.steps)
        .filter(DailySport.user_id == user_id, DailySport.date.in_(dates))
        .all()
    )
    correct = dict(
        db.query(QuizRecord.date, QuizRecord.correct_count)
        .filter(QuizRecord.user_id == user_id, QuizRecord.date.in_(dates))
        .all()
    )
    items = [
        {
            "date": d,
            "walk": by_date[d][WALK],
            "quiz": by_date[d][QUIZ],
            "total": by_date[d][WALK] + by_date[d][QUIZ],
            "steps": int(steps.get(d) or 0),
            "correct_count": int(correct.get(d) or 0),
            "updated_at": updated.get(d),
        }
        for d in dates
    ]
    return {"total": total_days, "items": items}


# ---------------- 校验 / 重算 ----------------
def _expected_for(db: Session, user_ids: List[int]) -> Dict[Tuple[int, str], Tuple[int, Optional[int]]]:
    """按源数据计算应得积分 {(user_id, biz_key): (delta, ref_id)}。"""
    expected: Dict[Tuple[int, str], Tuple[int, Optional[int]]] = {}
    for sid, uid, date, steps in db.query(
        DailySport.id, DailySport.user_id, DailySport.date, DailySport.steps
    ).filter(DailySport.user_id.in_(user_ids)):
        expected[(uid, biz_key(WALK, date))] = (walk_points(steps), sid)
    sessions = dict(
        ((uid, date), qid)
        for qid, uid, date in db.query(
            DailyQuestion.id, DailyQuestion.user_id, DailyQuestion.date
        ).filter(DailyQuestion.user_id.in_(user_ids))
    )
    for uid, date, correct in db.query(
        QuizRecord.user_id, QuizRecord.date, QuizRecord.correct_count
    ).filter(QuizRecord.user_id.in_(user_ids)):
        expected[(uid, biz_key(QUIZ, date))] = (quiz_points(correct), sessions.get((uid, date)))
    return expected


def _verify_batch(db: Session, user_ids: List[int], fix: bool) -> Tuple[int, List[Dict]]:
    expected = _expected_for(db, user_ids)
    actual = {
        (uid, key): (int(delta or 0), ref_id)
        for uid, key, delta, ref_id in db.query(
            PointsLog.user_id, PointsLog.biz_key, PointsLog.delta, PointsLog.ref_id
        ).filter(PointsLog.user_id.in_(user_ids), PointsLog.source_type.in_(SOURCES))
    }
    diffs: List[Dict] = []
    for key in expected.keys() | actual.keys():
        want, want_ref = expected.get(key, (0, None))
        have, have_ref = actual.get(key, (0, None))
        if want == have and (key not in expected or key not in actual or want_ref == have_ref):
            continue
        uid, bk = key
        source, date = bk.split(":", 1)
        diffs.append({"user_id": uid, "biz_key": bk, "expected": want, "actual": have})
        if fix:
            set_daily(db, uid, source, date, want, want_ref if key in expected else have_ref)
    return len(expected), diffs


def recompute_all(db: Session, fix: bool = False, user_ids: Optional[Iterable[int]] = None) -> Dict:
    """全量（或指定用户）按源数据核对积分台账；fix=True 时修复差异并提交。

    分批处理用户，避免一次性加载全部台账；返回核对天数、差异数与前 50 条差异样例。
    """
    ids = sorted(set(user_ids)) if user_ids is not None else [uid for (uid,) in db.query(User.id).order_by(User.id)]
    checked, mismatches, samples = 0, 0, []
    for start in range(0, len(ids), RECOMPUTE_BATCH):
        batch = ids[start:start + RECOMPUTE_BATCH]
        count, diffs = _verify_batch(db, batch, fix)
        checked += count
        mismatches += len(diffs)
        samples.extend(diffs[: max(0, 50 - len(samples))])
        if fix:
            db.commit()
    return {
        "users": len(ids),
        "checked_days": checked,
        "mismatches": mismatches,
        "fixed": mismatches if fix else 0,
        "samples": samples,
    }
