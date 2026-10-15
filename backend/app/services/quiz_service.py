"""每日答题服务（每题限时作答，V2.0 需求六）。

规则：
  每用户按个人使用历史分轮随机，每日最多 5 题且同日固定；逐题开题，每题 settings.QUIZ_QUESTION_SECONDS（90）秒，计时只认服务器时间；
  每题仅可提交一次，提交即判定；超时不得分且之后不可再提交；全部题目结束后生成当日答题记录。
  答题积分 = 答对数 × 2（单日上限 10，不扣分），每次判定与积分台账同一事务写入（见 points_service）。
安全：
  只下发「当前已开题」的题目（不预先下发整套题，防止提前查答案），且不含 answer / analysis；
  开题时间、截止时间、提交时间、作答内容、判定与超时全部落库（quiz_answers）；
  判定与超时均以 status='answering' 为条件更新，并发重复提交 / 提交与超时竞态只有一个生效；
  截止后 QUIZ_ANSWER_GRACE_SECONDS 内到达的提交视为网络延迟仍受理，被动查询亦按此宽限判定超时；
  主动「开始下一题」视为放弃当前题，截止即判超时。

情报化扩展（功能 8）：
  返回 issue_no（第 N 期，以 Settings.ACTIVITY_START_DATE 为第 1 期）；
  get_knowledge 按题目 category 聚合历史答题正确率（知识画像）。
"""
import logging
import random
import time
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

from sqlalchemy import and_, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.helpers import today_str
from app.models.models import DailyQuestion, PointsLog, Question, QuizAnswer, QuizRecord
from app.services import event_service, points_service

logger = logging.getLogger(__name__)

DAILY_COUNT = 5
SCORE_PER_QUESTION = 20
ANSWERING, ANSWERED, TIMEOUT = "answering", "answered", "timeout"

NOT_STARTED = "该题尚未开始作答"
ALREADY_ANSWERED = "本题已作答，不能重复提交"
ANSWER_TIMEOUT = "本题作答已超时，不能再提交"

# 知识画像分类（key -> 展示名），与 questions.category 取值对应
KNOWLEDGE_CATEGORIES = [
    ("event", "历史事件"),
    ("route", "长征路线"),
    ("figure", "历史人物"),
]


def _issue_no(date: str) -> int:
    """当天为活动第 N 期（起始日为第 1 期，早于起始日按 1 计）。"""
    start = datetime.strptime(settings.ACTIVITY_START_DATE, "%Y-%m-%d").date()
    day = datetime.strptime(date, "%Y-%m-%d").date()
    return max((day - start).days + 1, 1)


def _ms(dt: datetime) -> int:
    """UTC naive 时间 -> 毫秒时间戳。"""
    return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)


def _grace() -> timedelta:
    return timedelta(seconds=settings.QUIZ_ANSWER_GRACE_SECONDS)


def _public_question(q: Question) -> Dict:
    """作答阶段题目结构（不含 answer 与 analysis）。"""
    return {
        "id": q.id,
        "type": q.type,
        "question": q.question,
        "options": q.options,
        "score": q.score,
    }


def _record_out(r: QuizRecord, with_details: bool = True) -> Dict:
    details = r.details or []
    return {
        "date": r.date,
        "total_count": r.total_count,
        "correct_count": r.correct_count,
        "score": r.score,
        "points": r.points,
        "accuracy": round(r.correct_count / r.total_count * 100) if r.total_count else 0,
        "timeout_count": sum(1 for d in details if d.get("timeout")),
        "wrong_list": r.wrong_list or [],
        "details": details if with_details else [],
        "answer_at": r.answer_at,
    }


def _get_record(db: Session, user_id: int, date: str) -> Optional[QuizRecord]:
    return (
        db.query(QuizRecord)
        .filter(QuizRecord.user_id == user_id, QuizRecord.date == date)
        .first()
    )


def _question_usage(db: Session, user_id: int) -> Dict[int, int]:
    """用户各题已使用次数：逐题记录为准，018 之前已完成场次回退 daily_questions。"""
    usage = {
        int(qid): int(count)
        for qid, count in db.query(QuizAnswer.question_id, func.count(QuizAnswer.id))
        .filter(QuizAnswer.user_id == user_id)
        .group_by(QuizAnswer.question_id)
    }
    has_answer = db.query(QuizAnswer.id).filter(
        QuizAnswer.session_id == DailyQuestion.id
    ).exists()
    legacy = (
        db.query(DailyQuestion.question_ids)
        .join(
            QuizRecord,
            and_(
                QuizRecord.user_id == DailyQuestion.user_id,
                QuizRecord.date == DailyQuestion.date,
            ),
        )
        .filter(DailyQuestion.user_id == user_id, ~has_answer)
        .yield_per(500)
    )
    for (question_ids,) in legacy:
        for question_id in question_ids or []:
            usage[question_id] = usage.get(question_id, 0) + 1
    return usage


def _pick_questions(db: Session, user_id: int) -> List[int]:
    """按用户独立轮换随机抽题：先取使用次数最少的一层，不足时依次跨入下一轮补足。"""
    all_ids = [qid for (qid,) in db.query(Question.id).filter(Question.active.is_(True)).all()]
    if not all_ids:
        return []
    usage = _question_usage(db, user_id)
    selected: List[int] = []
    remaining = set(all_ids)
    while remaining and len(selected) < DAILY_COUNT:
        least = min(usage.get(qid, 0) for qid in remaining)
        tier = [qid for qid in remaining if usage.get(qid, 0) == least]
        take = min(DAILY_COUNT - len(selected), len(tier))
        picked = random.sample(tier, take)
        selected.extend(picked)
        remaining.difference_update(picked)
    return selected


def _session(db: Session, user_id: int, date: str, create: bool) -> Optional[DailyQuestion]:
    """当日答题会话（抽题缓存，保证同一天同一套题）；create=True 时不存在则按个人轮次抽题。"""
    query = db.query(DailyQuestion).filter(
        DailyQuestion.user_id == user_id, DailyQuestion.date == date
    )
    cache = query.first()
    if not create or (cache is not None and cache.question_ids):
        return cache
    ids = _pick_questions(db, user_id)
    if len(ids) < DAILY_COUNT:
        logger.warning("quiz bank shortage: user_id=%s date=%s active_questions=%s", user_id, date, len(ids))
    if cache is None:
        db.add(DailyQuestion(user_id=user_id, date=date, question_ids=ids))
    else:
        cache.question_ids = ids
    try:
        db.commit()
    except IntegrityError:
        db.rollback()  # 并发首次获取：以先写入的抽题为准
    return query.first()


def _answers(db: Session, session_id: int) -> List[QuizAnswer]:
    return (
        db.query(QuizAnswer)
        .filter(QuizAnswer.session_id == session_id)
        .order_by(QuizAnswer.seq)
        .populate_existing()
        .all()
    )


def _expire(db: Session, rows: List[QuizAnswer], cutoff: datetime) -> bool:
    """截止时间早于 cutoff 的作答中题目标记超时（条件更新，与提交竞态只有一方生效）。"""
    changed = 0
    for r in rows:
        if r.status == ANSWERING and r.deadline_at < cutoff:
            changed += (
                db.query(QuizAnswer)
                .filter(QuizAnswer.id == r.id, QuizAnswer.status == ANSWERING)
                .update({QuizAnswer.status: TIMEOUT}, synchronize_session=False)
            )
    if changed:
        db.commit()
    return bool(changed)


def _plan(db: Session, session: DailyQuestion, rows: List[QuizAnswer]) -> Tuple[int, Optional[int]]:
    """(本场总题数, 下一道待开题的题目 id)。抽题后被删除的题目不再开题、不计入总数。"""
    done = {r.question_id for r in rows}
    ids = list(session.question_ids or [])
    existing = {qid for (qid,) in db.query(Question.id).filter(Question.id.in_(ids)).all()}
    remaining = [qid for qid in ids if qid in existing and qid not in done]
    return len(rows) + len(remaining), (remaining[0] if remaining else None)


def _detail(r: QuizAnswer, q: Optional[Question]) -> Dict:
    return {
        "index": r.seq,
        "question_id": r.question_id,
        "type": q.type if q else "single",
        "question": q.question if q else "",
        "options": (q.options or []) if q else [],
        "user_answer": r.user_answer or [],
        "correct_answer": sorted(q.answer or []) if q else [],
        "correct": bool(r.is_correct),
        "timeout": r.status == TIMEOUT,
        "score": SCORE_PER_QUESTION if r.is_correct else 0,
        "points": r.points or 0,
        "analysis": (q.analysis or "") if q else "",
    }


def _finalize(db: Session, user_id: int, session: DailyQuestion, rows: List[QuizAnswer]) -> QuizRecord:
    """全部题目结束后生成当日答题记录（user+date 唯一，并发只写一次）并记录事件。"""
    existing = _get_record(db, user_id, session.date)
    if existing is not None:
        return existing
    qmap = {
        q.id: q
        for q in db.query(Question).filter(Question.id.in_([r.question_id for r in rows])).all()
    }
    details = [_detail(r, qmap.get(r.question_id)) for r in rows]
    wrong_list = [
        {
            "index": d["index"],
            "question_id": d["question_id"],
            "category": (qmap[d["question_id"]].category or "") if d["question_id"] in qmap else "",
            "question": d["question"],
            "correct_answer": "".join(d["correct_answer"]),
            "analysis": d["analysis"],
        }
        for d in details
        if not d["correct"]
    ]
    correct_count = sum(1 for r in rows if r.is_correct)
    score = correct_count * SCORE_PER_QUESTION
    record = QuizRecord(
        user_id=user_id,
        date=session.date,
        total_count=len(rows),
        correct_count=correct_count,
        score=score,
        points=points_service.quiz_points(correct_count),
        wrong_list=wrong_list,
        details=details,
        answer_at=int(time.time() * 1000),
    )
    db.add(record)
    try:
        db.flush()
        points_service.sync_quiz_day(db, user_id, session.date, correct_count, session.id)
        db.commit()
    except IntegrityError:
        db.rollback()
        return _get_record(db, user_id, session.date)

    event_service.record(
        db, user_id, "QUIZ_COMPLETE",
        {"date": session.date, "score": score, "correctCount": correct_count},
    )
    if correct_count == record.total_count:
        event_service.record(db, user_id, "QUIZ_FULL_SCORE", {"date": session.date})
    return record


def _state(
    db: Session,
    date: str,
    now: datetime,
    total: int,
    rows: List[QuizAnswer],
    record: Optional[QuizRecord],
) -> Dict:
    """今日答题状态：逐题进度、当前题（含服务器截止时间与剩余毫秒）、已完成记录。"""
    current = next((r for r in rows if r.status == ANSWERING), None)
    current_out = None
    if current is not None and record is None:
        q = db.query(Question).filter(Question.id == current.question_id).first()
        if q is not None:
            current_out = {
                "seq": current.seq,
                "question": _public_question(q),
                "started_at": _ms(current.started_at),
                "deadline_at": _ms(current.deadline_at),
                "remaining_ms": max(0, int((current.deadline_at - now).total_seconds() * 1000)),
            }
    progress = [
        {"seq": r.seq, "status": r.status, "correct": bool(r.is_correct)} for r in rows
    ] + [
        {"seq": seq, "status": "pending", "correct": False}
        for seq in range(len(rows) + 1, total + 1)
    ]
    correct_count = record.correct_count if record else sum(1 for r in rows if r.is_correct)
    return {
        "date": date,
        "issue_no": _issue_no(date),
        "completed": record is not None,
        "total_count": record.total_count if record else total,
        "question_shortage": total < DAILY_COUNT,
        "shortage_message": (
            f"当前题库仅有 {total} 道可用题目，本期按实际题量作答" if total < DAILY_COUNT else ""
        ),
        "time_limit": settings.QUIZ_QUESTION_SECONDS,
        "server_time": _ms(now),
        "progress": progress,
        "current": current_out,
        "correct_count": correct_count,
        "points": points_service.quiz_points(correct_count),
        "record": _record_out(record) if record else None,
    }


def _completed_state(db: Session, record: QuizRecord, now: datetime) -> Dict:
    session = _session(db, record.user_id, record.date, create=False)
    rows = _answers(db, session.id) if session else []
    return _state(db, record.date, now, record.total_count, rows, record)


def get_daily(db: Session, user_id: int) -> Dict:
    """今日答题状态：已过截止+宽限的题目判超时；全部结束则生成记录。

    未开题时 current 为空，需调用 start 开题后才下发题目。
    """
    date, now = today_str(), datetime.utcnow()
    record = _get_record(db, user_id, date)
    if record is not None:
        return _completed_state(db, record, now)
    session = _session(db, user_id, date, create=True)
    rows = _answers(db, session.id)
    if _expire(db, rows, now - _grace()):
        rows = _answers(db, session.id)
    total, next_qid = _plan(db, session, rows)
    if rows and next_qid is None and all(r.status != ANSWERING for r in rows):
        return _state(db, date, now, total, rows, _finalize(db, user_id, session, rows))
    return _state(db, date, now, total, rows, None)


def start(db: Session, user_id: int) -> Dict:
    """开始（或继续）当前题，幂等：作答中且未截止则返回同一题与剩余时间；

    当前题已截止则判超时并开下一题；全部结束则生成记录返回。开题/截止时间取服务器时间。
    """
    date, now = today_str(), datetime.utcnow()
    record = _get_record(db, user_id, date)
    if record is not None:
        return _completed_state(db, record, now)
    session = _session(db, user_id, date, create=True)
    for _ in range(3):
        rows = _answers(db, session.id)
        if _expire(db, rows, now):
            rows = _answers(db, session.id)
        total, next_qid = _plan(db, session, rows)
        if any(r.status == ANSWERING for r in rows):
            return _state(db, date, now, total, rows, None)
        if next_qid is None:
            record = _finalize(db, user_id, session, rows) if rows else None
            return _state(db, date, now, total, rows, record)
        db.add(
            QuizAnswer(
                session_id=session.id,
                user_id=user_id,
                date=date,
                seq=len(rows) + 1,
                question_id=next_qid,
                started_at=now,
                deadline_at=now + timedelta(seconds=settings.QUIZ_QUESTION_SECONDS),
                status=ANSWERING,
            )
        )
        try:
            db.commit()
        except IntegrityError:
            db.rollback()  # 并发开题：以先写入的为准，重新读取
    rows = _answers(db, session.id)
    return _state(db, date, now, _plan(db, session, rows)[0], rows, None)


def answer(db: Session, user_id: int, question_id: int, labels: List[str]) -> Dict:
    """提交当前题答案（每题一次）。服务器时间超过截止+宽限即判超时并拒绝。

    判定与当日答题积分同一事务写入；最后一题提交后生成当日记录。
    """
    date, now = today_str(), datetime.utcnow()
    session = _session(db, user_id, date, create=False)
    row = (
        db.query(QuizAnswer)
        .filter(QuizAnswer.session_id == session.id, QuizAnswer.question_id == question_id)
        .first()
        if session is not None
        else None
    )
    if row is None:
        raise ValueError(NOT_STARTED)
    if row.status == ANSWERED:
        raise ValueError(ALREADY_ANSWERED)
    if row.status == TIMEOUT:
        raise ValueError(ANSWER_TIMEOUT)
    q = db.query(Question).filter(Question.id == question_id).first()
    if q is None:
        raise ValueError("题目已下线")
    user_ans = sorted(set(labels or []))
    if len(user_ans) != 1:
        raise ValueError("请选择一个答案后提交")
    if user_ans[0] not in {o.get("label") for o in (q.options or [])}:
        raise ValueError("答案选项无效")

    right = sorted(q.answer or [])
    is_right = bool(right) and user_ans == right
    prior = (
        db.query(QuizAnswer.id)
        .filter(QuizAnswer.session_id == session.id, QuizAnswer.is_correct.is_(True))
        .count()
    )
    gained = (
        points_service.quiz_points(prior + 1) - points_service.quiz_points(prior) if is_right else 0
    )
    updated = (
        db.query(QuizAnswer)
        .filter(
            QuizAnswer.id == row.id,
            QuizAnswer.status == ANSWERING,
            QuizAnswer.deadline_at >= now - _grace(),
        )
        .update(
            {
                QuizAnswer.status: ANSWERED,
                QuizAnswer.submitted_at: now,
                QuizAnswer.user_answer: user_ans,
                QuizAnswer.is_correct: is_right,
                QuizAnswer.points: gained,
            },
            synchronize_session=False,
        )
    )
    if not updated:
        db.rollback()
        rows = _answers(db, session.id)
        if next(r for r in rows if r.id == row.id).status == ANSWERED:
            raise ValueError(ALREADY_ANSWERED)
        _expire(db, rows, now - _grace())
        raise ValueError(ANSWER_TIMEOUT)
    correct_count = prior + (1 if is_right else 0)
    points_service.sync_quiz_day(db, user_id, date, correct_count, session.id)
    db.commit()

    rows = _answers(db, session.id)
    total, next_qid = _plan(db, session, rows)
    record = _finalize(db, user_id, session, rows) if next_qid is None else None
    return {
        "seq": row.seq,
        "question_id": question_id,
        "status": ANSWERED,
        "correct": is_right,
        "user_answer": user_ans,
        "correct_answer": right,
        "analysis": q.analysis or "",
        "points": gained,
        "correct_count": correct_count,
        "today_points": points_service.quiz_points(correct_count),
        "total_count": total,
        "finished": record is not None,
        "record": _record_out(record) if record else None,
    }


def get_records(db: Session, user_id: int) -> List[Dict]:
    """答题记录列表（从新到旧）；列表不含逐题明细以控制体积。"""
    rows = (
        db.query(QuizRecord)
        .filter(QuizRecord.user_id == user_id)
        .order_by(QuizRecord.date.desc())
        .all()
    )
    return [_record_out(r, with_details=False) for r in rows]


def get_knowledge(db: Session, user_id: int) -> Dict:
    """知识画像（功能 8）：按题目 category 聚合历史正确率。

    分母为每日抽题缓存（DailyQuestion）中该类题目出现次数，分子错误数取自
    答题记录 wrong_list（按 question_id 反查分类，兼容旧记录无 category 的情况）。
    """
    cat_of: Dict[int, str] = {}
    for q in db.query(Question.id, Question.category).all():
        if q[1]:
            cat_of[q[0]] = q[1]

    asked: Dict[str, int] = {key: 0 for key, _name in KNOWLEDGE_CATEGORIES}
    caches = db.query(DailyQuestion.question_ids).filter(
        DailyQuestion.user_id == user_id
    ).all()
    for (ids,) in caches:
        for qid in ids or []:
            cat = cat_of.get(qid)
            if cat in asked:
                asked[cat] += 1

    wrong: Dict[str, int] = {key: 0 for key, _name in KNOWLEDGE_CATEGORIES}
    records = db.query(QuizRecord).filter(QuizRecord.user_id == user_id).all()
    for r in records:
        for item in r.wrong_list or []:
            cat = item.get("category") or cat_of.get(item.get("question_id"))
            if cat in wrong:
                wrong[cat] += 1

    categories: List[Dict] = []
    for key, name in KNOWLEDGE_CATEGORIES:
        total = asked[key]
        rate = round((total - wrong[key]) / total * 100) if total else 0
        categories.append(
            {"key": key, "name": name, "rate": rate, "asked": total, "wrong": wrong[key]}
        )

    answered = sum(r.total_count for r in records)
    correct = sum(r.correct_count for r in records)
    overall_rate = round(correct / answered * 100) if answered else 0
    return {"categories": categories, "overall_rate": overall_rate}


def reset_today(db: Session, user_id: int) -> None:
    """重置今日答题（调试用）：删逐题作答、记录、今日答题积分与题目缓存。"""
    date = today_str()
    for model in (QuizAnswer, QuizRecord, DailyQuestion):
        db.query(model).filter(model.user_id == user_id, model.date == date).delete(
            synchronize_session=False
        )
    db.query(PointsLog).filter(
        PointsLog.user_id == user_id,
        PointsLog.biz_key == points_service.biz_key(points_service.QUIZ, date),
    ).delete(synchronize_session=False)
    db.commit()
