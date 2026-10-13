# -*- coding: utf-8 -*-
"""
S18 V1.2 答题提交后统一反馈 后端冒烟脚本（TestClient + SQLite 临时库）

覆盖：
  Q01 今日题目 5 题、每题 20 分，题目不含 answer / analysis
  Q02 同日多次获取为同一套题
  Q03 单题判题接口 /api/quiz/check 已移除（404/405）
  Q04 未作答完整（缺题 / 空答案）提交被拒 400，且不写记录
  Q05 提交不属于今日抽题的题目被拒 400
  Q06 重复同一道题伪造满分被拒 400
  Q07 非法选项被拒 400
  Q08 正常提交：后端判分，返回逐题 details（我的答案/正确答案/对错/每题得分）与 wrongList
  Q09 每日仅一次：重复提交 400，积分不重复发放
  Q10 已完成后 /quiz/daily 返回记录含 details；/quiz/records 不含 details
  Q11 满分提交：100 分、积分 10（5 题 × 2，单日上限 10）、全部 details correct
  Q12 并发提交（8 线程）仅 1 个成功、仅 1 次积分
  Q13 历史记录（无 details）不重算，原样返回 score / wrongList，details 为空
  Q14 未登录访问答题接口 401

用法：cd backend && python test/s18_quiz_submit_feedback.py
"""
import json
import os
import sys
import threading

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_smoke_quiz_feedback.db")
if os.path.exists(_DB_PATH):
    os.remove(_DB_PATH)
os.environ["DATABASE_URL"] = "sqlite:///" + _DB_PATH.replace("\\", "/")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

from app.core.database import Base, SessionLocal, engine
from app.core.security import create_access_token
from app.main import app
from app.models.models import PointsLog, Question, QuizRecord, User

RESULTS = []


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def seed():
    db = SessionLocal()
    try:
        for i in range(1, 11):
            if i % 2:
                options = [{"label": "A", "text": f"选项A{i}"}, {"label": "B", "text": f"选项B{i}"},
                           {"label": "C", "text": f"选项C{i}"}, {"label": "D", "text": f"选项D{i}"}]
                qtype, answer = "single", ["ABCD"[i % 4]]
            else:
                options = [{"label": "A", "text": "正确"}, {"label": "B", "text": "错误"}]
                qtype, answer = "judge", ["A" if i % 4 else "B"]
            db.add(Question(id=i, type=qtype, question=f"S18 题目 {i}", options=options, answer=answer,
                            analysis=f"解析 {i}", score=20, category="event"))
        users = []
        for n in range(4):
            u = User(openid=f"o_s18_user_{n}", nickname=f"S18用户{n}")
            db.add(u)
            users.append(u)
        db.commit()
        return {q.id: q.answer for q in db.query(Question).all()}, [(u.id, u.openid) for u in users]
    finally:
        db.close()


def headers(uid, openid):
    return {"Authorization": "Bearer " + create_access_token(uid, openid)}


def quiz_points(uid):
    db = SessionLocal()
    try:
        rows = db.query(PointsLog).filter(PointsLog.user_id == uid, PointsLog.source_type == "quiz").all()
        return sum(r.delta for r in rows), len(rows)
    finally:
        db.close()


def record_count(uid):
    db = SessionLocal()
    try:
        return db.query(QuizRecord).filter(QuizRecord.user_id == uid).count()
    finally:
        db.close()


def wrong_label(q, answer_map):
    right = answer_map[q["id"]][0]
    return next(o["label"] for o in q["options"] if o["label"] != right)


def main():
    Base.metadata.create_all(engine)
    answer_map, users = seed()
    client = TestClient(app)
    try:
        (u1, o1), (u2, o2), (u3, o3), (u4, o4) = users
        h1 = headers(u1, o1)

        # Q01
        r = client.get("/api/quiz/daily", headers=h1)
        body = r.json()
        qs = body.get("questions") or []
        leaked = [k for q in qs for k in ("answer", "analysis") if k in q]
        record("Q01", "今日 5 题每题 20 分，不下发答案与解析",
               r.status_code == 200 and len(qs) == 5 and all(q["score"] == 20 for q in qs) and not leaked
               and body["completed"] is False, f"status={r.status_code} n={len(qs)} leaked={leaked}")

        # Q02
        r2 = client.get("/api/quiz/daily", headers=h1)
        record("Q02", "同日多次获取同一套题",
               [q["id"] for q in r2.json()["questions"]] == [q["id"] for q in qs])

        # Q03
        r = client.post("/api/quiz/check", headers=h1, json={"questionId": qs[0]["id"], "answer": ["A"]})
        record("Q03", "/api/quiz/check 已移除", r.status_code in (404, 405), f"status={r.status_code}")

        # Q04
        partial = [{"questionId": q["id"], "answer": answer_map[q["id"]]} for q in qs[:4]]
        r_a = client.post("/api/quiz/submit", headers=h1, json={"answers": partial})
        empty = partial + [{"questionId": qs[4]["id"], "answer": []}]
        r_b = client.post("/api/quiz/submit", headers=h1, json={"answers": empty})
        record("Q04", "缺题/空答案提交 400 且不写记录",
               r_a.status_code == 400 and r_b.status_code == 400 and record_count(u1) == 0
               and "完成全部题目" in r_a.json().get("detail", ""),
               f"missing={r_a.status_code} empty={r_b.status_code} detail={r_a.json().get('detail')}")

        # Q05
        today_ids = {q["id"] for q in qs}
        outsider = next(i for i in answer_map if i not in today_ids)
        forged = partial + [{"questionId": outsider, "answer": answer_map[outsider]}]
        r = client.post("/api/quiz/submit", headers=h1, json={"answers": forged})
        record("Q05", "非今日题目提交 400", r.status_code == 400 and record_count(u1) == 0,
               f"status={r.status_code} detail={r.json().get('detail')}")

        # Q06
        dup = [{"questionId": qs[0]["id"], "answer": answer_map[qs[0]["id"]]}] * 5
        r = client.post("/api/quiz/submit", headers=h1, json={"answers": dup})
        record("Q06", "重复同题伪造满分 400", r.status_code == 400 and record_count(u1) == 0,
               f"status={r.status_code} detail={r.json().get('detail')}")

        # Q07
        bad = [{"questionId": q["id"], "answer": answer_map[q["id"]]} for q in qs[:4]]
        bad.append({"questionId": qs[4]["id"], "answer": ["Z"]})
        r = client.post("/api/quiz/submit", headers=h1, json={"answers": bad})
        record("Q07", "非法选项 400", r.status_code == 400 and record_count(u1) == 0,
               f"status={r.status_code} detail={r.json().get('detail')}")

        # Q08：前 3 题答对、后 2 题答错，乱序提交验证按抽题顺序判分
        payload = [{"questionId": q["id"], "answer": answer_map[q["id"]]} for q in qs[:3]]
        payload += [{"questionId": q["id"], "answer": [wrong_label(q, answer_map)]} for q in qs[3:]]
        r = client.post("/api/quiz/submit", headers=h1, json={"answers": list(reversed(payload))})
        res = r.json()
        det = res.get("details") or []
        det_ok = (
            len(det) == 5
            and [d["questionId"] for d in det] == [q["id"] for q in qs]
            and [d["index"] for d in det] == [1, 2, 3, 4, 5]
            and [d["correct"] for d in det] == [True, True, True, False, False]
            and [d["score"] for d in det] == [20, 20, 20, 0, 0]
            and all(d["correctAnswer"] == answer_map[d["questionId"]] for d in det)
            and det[3]["userAnswer"] == [wrong_label(qs[3], answer_map)]
            and all(d["question"] and d["options"] and d["analysis"] for d in det)
        )
        record("Q08", "后端判分返回逐题结果（60 分 3 对 2 错）",
               r.status_code == 200 and res["score"] == 60 and res["correctCount"] == 3 and res["totalCount"] == 5
               and res["points"] == 6 and det_ok and [w["index"] for w in res["wrongList"]] == [4, 5],
               f"status={r.status_code} score={res.get('score')} det_ok={det_ok}")

        # Q09
        r = client.post("/api/quiz/submit", headers=h1, json={"answers": payload})
        pts, rows = quiz_points(u1)
        record("Q09", "重复提交 400 且积分不重复",
               r.status_code == 400 and r.json().get("detail") == "今日答题已完成" and record_count(u1) == 1
               and (pts, rows) == (6, 1), f"status={r.status_code} points={pts} rows={rows}")

        # Q10
        d = client.get("/api/quiz/daily", headers=h1).json()
        recs = client.get("/api/quiz/records", headers=h1).json()
        record("Q10", "已完成 daily 含 details，records 不含 details",
               d["completed"] is True and d["questions"] is None and len(d["record"]["details"]) == 5
               and len(recs) == 1 and recs[0]["details"] == [] and recs[0]["score"] == 60,
               f"daily_details={len(d['record']['details'])} records_details={recs[0].get('details') if recs else None}")

        # Q11 满分
        h2 = headers(u2, o2)
        qs2 = client.get("/api/quiz/daily", headers=h2).json()["questions"]
        r = client.post("/api/quiz/submit", headers=h2,
                        json={"answers": [{"questionId": q["id"], "answer": answer_map[q["id"]]} for q in qs2]})
        res = r.json()
        pts, rows = quiz_points(u2)
        record("Q11", "满分 100 分、积分 10、逐题全对",
               r.status_code == 200 and res["score"] == 100 and res["points"] == 10 and res["wrongList"] == []
               and all(x["correct"] and x["score"] == 20 for x in res["details"]) and (pts, rows) == (10, 1),
               f"status={r.status_code} score={res.get('score')} points={pts}/{rows}")

        # Q12 并发提交
        h3 = headers(u3, o3)
        qs3 = client.get("/api/quiz/daily", headers=h3).json()["questions"]
        body3 = {"answers": [{"questionId": q["id"], "answer": answer_map[q["id"]]} for q in qs3]}
        barrier = threading.Barrier(8)
        statuses, lock = [], threading.Lock()

        def worker():
            barrier.wait(timeout=10)
            resp = client.post("/api/quiz/submit", headers=h3, json=body3)
            with lock:
                statuses.append(resp.status_code)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        pts, rows = quiz_points(u3)
        record("Q12", "8 并发提交仅 1 成功、积分仅发一次",
               statuses.count(200) == 1 and statuses.count(400) == 7 and record_count(u3) == 1 and (pts, rows) == (10, 1),
               f"statuses={sorted(statuses)} records={record_count(u3)} points={pts}/{rows}")

        # Q13 历史记录不重算
        db = SessionLocal()
        try:
            from app.core.helpers import today_str
            db.add(QuizRecord(user_id=u4, date=today_str(), total_count=5, correct_count=2, score=40, points=5,
                              wrong_list=[{"index": 1, "question_id": 1, "question": "旧题", "correct_answer": "B",
                                           "analysis": "旧解析"}], answer_at=1))
            db.commit()
        finally:
            db.close()
        d = client.get("/api/quiz/daily", headers=headers(u4, o4)).json()
        rec = d["record"]
        record("Q13", "历史无 details 记录原样返回不重算",
               d["completed"] is True and rec["score"] == 40 and rec["correctCount"] == 2 and rec["details"] == []
               and rec["wrongList"][0]["correctAnswer"] == "B", f"record={json.dumps(rec, ensure_ascii=False)[:160]}")

        # Q14
        codes = [client.get("/api/quiz/daily").status_code,
                 client.post("/api/quiz/submit", json={"answers": []}).status_code]
        record("Q14", "未登录访问答题接口 401", codes == [401, 401], f"codes={codes}")
    finally:
        engine.dispose()

    passed = sum(1 for x in RESULTS if x["ok"])
    print(f"\n== S18 答题提交后统一反馈: {passed}/{len(RESULTS)} 通过 ==")
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s18-quiz-feedback-results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"results": RESULTS}, f, ensure_ascii=False, indent=2)
    if os.path.exists(_DB_PATH):
        os.remove(_DB_PATH)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
