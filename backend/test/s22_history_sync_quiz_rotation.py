# -*- coding: utf-8 -*-
"""S22 近 7 日步数补录/结余积分/用户独立题目轮换（SQLite）。"""
import json
import os
import sys
from datetime import datetime, timedelta

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
DB_PATH = os.path.join(os.path.dirname(__file__), "_smoke_s22.db")
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)
os.environ["DATABASE_URL"] = "sqlite:///" + DB_PATH.replace("\\", "/")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

from app.core.database import Base, SessionLocal, engine
from app.core.helpers import recent_dates, today_str
from app.core.security import create_access_token
from app.main import app
from app.models.models import DailyQuestion, DailySport, PointsLog, Question, QuizAnswer, User
from app.services import admin_service, points_service, quiz_service, sport_service

RESULTS = []


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:400]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:240]) if detail else ""))


def make_user(db, suffix):
    user = User(openid="mock_s22_" + suffix, nickname="S22" + suffix, original_nickname="S22" + suffix)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def mark_session_answered(db, session):
    now = datetime.utcnow()
    for seq, qid in enumerate(session.question_ids, 1):
        db.add(QuizAnswer(
            session_id=session.id, user_id=session.user_id, date=session.date, seq=seq,
            question_id=qid, started_at=now, deadline_at=now + timedelta(seconds=90),
            submitted_at=now, user_answer=["A"], is_correct=True, status="answered", points=2,
        ))
    db.commit()


def main():
    Base.metadata.create_all(engine)
    db = SessionLocal()
    original_resolve = sport_service._resolve_steps
    try:
        user = make_user(db, "sport")
        days = recent_dates(7)
        snapshots = {day: 1000 for day in days}
        snapshots[days[-2]] = 5800
        snapshots[days[-1]] = 200
        sport_service._resolve_steps = lambda *args, **kwargs: dict(snapshots)

        out = sport_service.sync_today(db, user.id, openid=user.openid)
        rows = db.query(DailySport).filter(DailySport.user_id == user.id).order_by(DailySport.date).all()
        record("S01", "一次同步处理最近 7 个北京时间自然日", out["processed_dates"] == days and len(rows) == 7,
               f"processed={out['processed_dates']} rows={len(rows)}")
        record("S02", "响应与前端当前区域只返回今天步数", out["date"] == days[-1] and out["steps"] == 200,
               f"date={out['date']} steps={out['steps']}")
        y_points = points_service.walk_on(db, user.id, days[-2])
        t_points = points_service.walk_on(db, user.id, days[-1])
        record("S03", "5800 步余 800 结转，次日 200 步再得 1 分", y_points == 5 and t_points == 1 and out["walk_carry"] == 0,
               f"yesterday={y_points} today={t_points} carry={out['walk_carry']}")

        total_before = points_service.get_total(db, user.id)
        repeat = sport_service.sync_today(db, user.id, openid=user.openid)
        record("S04", "重复同步幂等且不重复加分", not repeat["synced"] and repeat["points_change"] == 0
               and points_service.get_total(db, user.id) == total_before,
               f"change={repeat['points_change']} total={total_before}")

        snapshots[days[-2]] = 4800
        corrected = sport_service.sync_today(db, user.id, openid=user.openid)
        db.refresh(user)
        record("S05", "历史步数变化会修正后续结余积分与连续行军缓存", corrected["points_change"] == -1
               and points_service.walk_on(db, user.id, days[-2]) == 4
               and points_service.walk_on(db, user.id, days[-1]) == 1
               and user.continuous_days == 0,
               f"change={corrected['points_change']} points={points_service.walk_on(db, user.id, days[-2])}/{points_service.walk_on(db, user.id, days[-1])} streak={user.continuous_days}")

        keep = snapshots[days[-3]]
        missing = dict(snapshots)
        missing.pop(days[-3])
        sport_service._resolve_steps = lambda *args, **kwargs: dict(missing)
        partial = sport_service.sync_today(db, user.id, openid=user.openid)
        saved = db.query(DailySport.steps).filter(DailySport.user_id == user.id, DailySport.date == days[-3]).scalar()
        record("S06", "缺失日期不写 0、不覆盖旧值并返回可重试状态", partial["status"] == "partial"
               and partial["failed_dates"] == [{"date": days[-3], "reason": "微信运动本次未返回该日数据，可稍后重试"}]
               and saved == keep, f"failed={partial['failed_dates']} saved={saved}")
        record("S07", "每日记录保存来源、同步时间和处理状态", all(r.source == "mock" and r.synced_at and r.sync_status == "processed" for r in rows))

        for i in range(1, 9):
            db.add(Question(id=i, type="single", question=f"题目{i}", options=[{"label": "A", "text": "是"}], answer=["A"], active=True))
        qa = make_user(db, "quiz-a")
        qb = make_user(db, "quiz-b")
        first = quiz_service._session(db, qa.id, "2026-10-01", True)
        again = quiz_service._session(db, qa.id, "2026-10-01", True)
        record("Q01", "同用户同日固定 5 道且不重复", first.question_ids == again.question_ids
               and len(first.question_ids) == len(set(first.question_ids)) == 5, first.question_ids)
        mark_session_answered(db, first)

        second = quiz_service._session(db, qa.id, "2026-10-02", True)
        new_count = len(set(second.question_ids) - set(first.question_ids))
        record("Q02", "未答题不足 5 时先用完剩余 3 题再跨轮补 2 题", new_count == 3
               and len(second.question_ids) == len(set(second.question_ids)) == 5,
               f"day1={first.question_ids} day2={second.question_ids}")

        other = quiz_service._session(db, qb.id, "2026-10-02", True)
        record("Q03", "A 用户历史不影响 B 用户选题", len(other.question_ids) == 5
               and all(count == 0 for count in quiz_service._question_usage(db, qb.id).values()), other.question_ids)

        mark_session_answered(db, second)
        third = quiz_service._session(db, qa.id, "2026-10-03", True)
        record("Q04", "全部题目用过后自动进入下一轮且当天不重复", len(third.question_ids) == len(set(third.question_ids)) == 5,
               third.question_ids)

        retained_id = third.question_ids[0]
        admin_service.delete_question(db, retained_id)
        retained = db.query(Question).filter(Question.id == retained_id).first()
        planned_total, _ = quiz_service._plan(db, third, [])
        later = quiz_service._session(db, qb.id, "2026-10-03", True)
        record("Q05", "停用题保留既有当天任务但不参与后续抽题", retained.active is False
               and planned_total == 5 and retained_id not in later.question_ids,
               f"retained={retained_id} later={later.question_ids}")

        for q in db.query(Question).filter(Question.active.is_(True)).order_by(Question.id).all()[3:]:
            admin_service.delete_question(db, q.id)
        qc = make_user(db, "quiz-c")
        token = create_access_token(qc.id, qc.openid)
        response = TestClient(app).get("/api/quiz/daily", headers={"Authorization": "Bearer " + token})
        body = response.json()
        record("Q06", "题库不足 5 道时不重复并返回明确状态", response.status_code == 200
               and body["totalCount"] == 3 and body["questionShortage"] is True
               and len(db.query(DailyQuestion).filter(DailyQuestion.user_id == qc.id).first().question_ids) == 3,
               body)
    finally:
        sport_service._resolve_steps = original_resolve
        db.close()

    passed = sum(1 for item in RESULTS if item["ok"])
    print(f"\n== S22 历史同步与题目轮换: {passed}/{len(RESULTS)} 通过 ==")
    result_path = os.path.join(os.path.dirname(__file__), "s22-history-sync-quiz-rotation-results.json")
    with open(result_path, "w", encoding="utf-8") as file:
        json.dump({"results": RESULTS}, file, ensure_ascii=False, indent=2)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
