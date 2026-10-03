"""每日答题服务（迁移自前端 services/quiz.js）。

规则：
  每日随机 5 题、每题 20 分、满分 100；同一用户同一天仅可完成一次；
  提交后由后端按正确答案判分并发放积分（每日答题 +5，满分额外 +10）。
安全：题目接口不返回 answer，答案仅存于后端。

情报化扩展（功能 8）：
  get_daily 返回 issue_no（第 N 期，以 Settings.ACTIVITY_START_DATE 为第 1 期）；
  get_knowledge 按题目 category 聚合历史答题正确率（知识画像）。
"""
import random
import time
from datetime import datetime
from typing import Dict, List

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.helpers import today_str
from app.models.models import DailyQuestion, PointsLog, Question, QuizRecord
from app.services import event_service, points_service

DAILY_COUNT = 5

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


def check_answer(db: Session, question_id: int, answer: List[str]) -> Dict:
    """单题即时判题（需求 §15 答题连胜反馈）。无状态：不发积分、不写记录，
    最终成绩仍以 submit 判分为准（积分规则不变）。题目不存在返回 None。"""
    q = db.query(Question).filter(Question.id == question_id).first()
    if q is None:
        return None
    return {"question_id": q.id, "correct": sorted(answer or []) == sorted(q.answer or [])}


def get_daily(db: Session, user_id: int) -> Dict:
    """获取今日题目。同一天内多次调用返回同一套题；已完成则返回记录。"""
    date = today_str()
    issue_no = _issue_no(date)
    record = (
        db.query(QuizRecord)
        .filter(QuizRecord.user_id == user_id, QuizRecord.date == date)
        .first()
    )
    if record is not None:
        return {
            "date": date,
            "issue_no": issue_no,
            "completed": True,
            "questions": None,
            "record": _record_out(record),
        }

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
    return {
        "date": date,
        "issue_no": issue_no,
        "completed": False,
        "questions": questions,
        "record": None,
    }


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
                    "question_id": q.id if q else 0,
                    "category": (q.category or "") if q else "",
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
    event_service.record(
        db, user_id, "QUIZ_COMPLETE",
        {"date": date, "score": score, "correctCount": correct_count},
    )
    if score == 100:
        points_service.grant(db, user_id, "答题满分", 10)
        event_service.record(db, user_id, "QUIZ_FULL_SCORE", {"date": date})

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
