"""每日答题服务（迁移自前端 services/quiz.js）。

规则：
  每日随机 5 题、每题 20 分、满分 100；同一用户同一天仅可完成一次；
  提交后由后端按正确答案判分并发放积分（每日答题 +5，满分额外 +10）。
安全：题目接口不返回 answer，答案仅存于后端。
"""
import random
import time
from typing import Dict, List

from sqlalchemy.orm import Session

from app.core.helpers import today_str
from app.models.models import DailyQuestion, PointsLog, Question, QuizRecord
from app.services import points_service

DAILY_COUNT = 5


def _public_question(q: Question) -> Dict:
    """对外题目结构（不含 answer）。"""
    return {
        "id": q.id,
        "type": q.type,
        "question": q.question,
        "options": q.options,
        "analysis": q.analysis,
        "score": q.score,
    }


def _record_out(r: QuizRecord) -> Dict:
    return {
        "date": r.date,
        "total_count": r.total_count,
        "correct_count": r.correct_count,
        "score": r.score,
        "points": r.points,
        "wrong_list": r.wrong_list or [],
        "answer_at": r.answer_at,
    }


def get_daily(db: Session, user_id: int) -> Dict:
    """获取今日题目。同一天内多次调用返回同一套题；已完成则返回记录。"""
    date = today_str()
    record = (
        db.query(QuizRecord)
        .filter(QuizRecord.user_id == user_id, QuizRecord.date == date)
        .first()
    )
    if record is not None:
        return {"date": date, "completed": True, "questions": None, "record": _record_out(record)}

    # 当天题目缓存（保证同一天抽到同一套题）
    cache = (
        db.query(DailyQuestion)
        .filter(DailyQuestion.user_id == user_id, DailyQuestion.date == date)
        .first()
    )
    if cache is None or not cache.question_ids:
        all_q = db.query(Question).all()
        picked = random.sample(all_q, min(DAILY_COUNT, len(all_q)))
        ids = [q.id for q in picked]
        if cache is None:
            db.add(DailyQuestion(user_id=user_id, date=date, question_ids=ids))
        else:
            cache.question_ids = ids
        db.commit()
    else:
        ids = cache.question_ids

    qmap = {q.id: q for q in db.query(Question).filter(Question.id.in_(ids)).all()}
    questions = [_public_question(qmap[i]) for i in ids if i in qmap]
    return {"date": date, "completed": False, "questions": questions, "record": None}


def submit(db: Session, user_id: int, answers: List[Dict]) -> Dict:
    """提交答卷（每日仅一次）。answers: [{question_id, answer: []}]。"""
    date = today_str()
    existing = (
        db.query(QuizRecord)
        .filter(QuizRecord.user_id == user_id, QuizRecord.date == date)
        .first()
    )
    if existing is not None:
        raise ValueError("今日答题已完成")

    qmap = {q.id: q for q in db.query(Question).all()}
    correct_count = 0
    wrong_list: List[Dict] = []

    for idx, a in enumerate(answers):
        q = qmap.get(a.get("question_id"))
        right = sorted((q.answer if q else []) or [])
        user_ans = sorted(a.get("answer") or [])
        if right and user_ans == right:
            correct_count += 1
        else:
            wrong_list.append(
                {
                    "index": idx + 1,
                    "question": q.question if q else "",
                    "correct_answer": "".join(right),
                    "analysis": q.analysis if q else "",
                }
            )

    score = correct_count * 20  # 每题 20 分
    earned = 15 if score == 100 else 5  # 每日答题 +5，满分额外 +10
    record = QuizRecord(
        user_id=user_id,
        date=date,
        total_count=len(answers),
        correct_count=correct_count,
        score=score,
        points=earned,
        wrong_list=wrong_list,
        answer_at=int(time.time() * 1000),
    )
    db.add(record)
    db.commit()

    points_service.grant(db, user_id, "每日答题", 5)
    if score == 100:
        points_service.grant(db, user_id, "答题满分", 10)

    return _record_out(record)


def get_records(db: Session, user_id: int) -> List[Dict]:
    """答题记录列表（从新到旧）。"""
    rows = (
        db.query(QuizRecord)
        .filter(QuizRecord.user_id == user_id)
        .order_by(QuizRecord.date.desc())
        .all()
    )
    return [_record_out(r) for r in rows]


def reset_today(db: Session, user_id: int) -> None:
    """重置今日答题（调试用）：删记录、撤销今日答题相关积分、清题目缓存。"""
    date = today_str()
    db.query(QuizRecord).filter(
        QuizRecord.user_id == user_id, QuizRecord.date == date
    ).delete(synchronize_session=False)
    db.query(DailyQuestion).filter(
        DailyQuestion.user_id == user_id, DailyQuestion.date == date
    ).delete(synchronize_session=False)
    db.query(PointsLog).filter(
        PointsLog.user_id == user_id,
        PointsLog.date == date,
        PointsLog.reason.in_(["每日答题", "答题满分"]),
    ).delete(synchronize_session=False)
    db.commit()
