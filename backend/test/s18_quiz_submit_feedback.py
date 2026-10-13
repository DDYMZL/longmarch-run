# -*- coding: utf-8 -*-
"""
S18 V2.0 每题限时作答 后端冒烟脚本（TestClient + SQLite 临时库）

覆盖：
  T01 未开题时 /quiz/daily 不下发题目：current 为空、5 题 pending、timeLimit=90、含服务器时间
  T02 开题只下发当前一道题，不含 answer / analysis，截止 = 开题 + 90 秒（服务器时间）
  T03 重复开题幂等：同一题、同一截止时间
  T04 提交未开题的题目 400
  T05 非法选项 / 多选 / 空答案 400，且不影响作答状态
  T06 答对即时判定：返回对错、正确答案、解析，积分 +2 并写入台账
  T07 同一题重复提交 400，积分不变
  T08 作答后 daily 不自动开下一题，进度显示第 1 题已答对
  T09 超时（截止 + 宽限之后）提交 400，判超时不得分，之后再提交仍 400
  T10 截止后宽限期内到达的提交仍受理
  T11 被动查询 daily 时已过截止 + 宽限的题目判超时
  T12 最后一题提交后生成记录：正确数/积分/正确率/超时数/逐题明细（含超时标记）
  T13 完成后 start 返回记录、再提交 400；records 列表不含明细
  T14 全对：积分 10（单日上限），正确率 100
  T15 同一题 8 并发提交仅 1 次成功、积分只发一次
  T16 8 并发开题只生成 1 条作答行
  T17 截止后（宽限内）主动开下一题：当前题判超时并开新题
  T18 未完成会话的答题积分计入概览与明细，全量核对无差异
  T19 历史记录（无逐题明细）原样返回
  T20 旧整卷提交 /quiz/submit 与单题判题 /quiz/check 已移除
  T21 未登录访问答题接口 401

用法：cd backend && python test/s18_quiz_submit_feedback.py
"""
import json
import os
import sys
import threading
from datetime import datetime, timedelta

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_smoke_quiz_feedback.db")
if os.path.exists(_DB_PATH):
    os.remove(_DB_PATH)
os.environ["DATABASE_URL"] = "sqlite:///" + _DB_PATH.replace("\\", "/")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

from app.core.database import Base, SessionLocal, engine
from app.core.helpers import today_str
from app.core.security import create_access_token
from app.main import app
from app.models.models import PointsLog, Question, QuizAnswer, QuizRecord, User
from app.services import points_service

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
        for n in range(6):
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


def answer_rows(uid):
    db = SessionLocal()
    try:
        return [(r.seq, r.status) for r in db.query(QuizAnswer).filter(QuizAnswer.user_id == uid)
                .order_by(QuizAnswer.seq)]
    finally:
        db.close()


def shift_deadline(uid, seq, seconds_ago):
    """把某题截止时间改到 seconds_ago 秒前，模拟服务器时间流逝。"""
    db = SessionLocal()
    try:
        row = db.query(QuizAnswer).filter(QuizAnswer.user_id == uid, QuizAnswer.seq == seq).one()
        row.deadline_at = datetime.utcnow() - timedelta(seconds=seconds_ago)
        db.commit()
    finally:
        db.close()


def wrong_label(q, answer_map):
    right = answer_map[q["id"]][0]
    return next(o["label"] for o in q["options"] if o["label"] != right)


def run_parallel(n, fn):
    barrier = threading.Barrier(n)
    out, lock = [], threading.Lock()

    def worker():
        barrier.wait(timeout=10)
        resp = fn()
        with lock:
            out.append(resp)

    threads = [threading.Thread(target=worker) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    return out


def main():
    Base.metadata.create_all(engine)
    answer_map, users = seed()
    client = TestClient(app)
    try:
        (u1, o1), (u2, o2), (u3, o3), (u4, o4), (u5, o5), (u6, o6) = users
        h1 = headers(u1, o1)

        def start(h):
            return client.post("/api/quiz/start", headers=h)

        def submit(h, qid, labels):
            return client.post("/api/quiz/answer", headers=h, json={"questionId": qid, "answer": labels})

        # T01
        r = client.get("/api/quiz/daily", headers=h1)
        d = r.json()
        record("T01", "未开题不下发题目，5 题 pending，限时 90 秒",
               r.status_code == 200 and d["current"] is None and d["completed"] is False
               and d["totalCount"] == 5 and [p["status"] for p in d["progress"]] == ["pending"] * 5
               and d["timeLimit"] == 90 and d["serverTime"] > 0 and "questions" not in d,
               f"status={r.status_code} body={json.dumps(d, ensure_ascii=False)[:160]}")

        # T02
        r = start(h1)
        s = r.json()
        cur = s.get("current") or {}
        q1 = cur.get("question") or {}
        leaked = [k for k in ("answer", "analysis") if k in q1]
        record("T02", "开题仅下发当前题、不含答案，截止 = 开题 + 90 秒",
               r.status_code == 200 and cur.get("seq") == 1 and q1.get("id") and not leaked
               and cur["deadlineAt"] - cur["startedAt"] == 90000 and 85000 <= cur["remainingMs"] <= 90000
               and s["progress"][0]["status"] == "answering",
               f"status={r.status_code} cur={json.dumps(cur, ensure_ascii=False)[:160]} leaked={leaked}")

        # T03
        s2 = start(h1).json()
        record("T03", "重复开题幂等",
               s2["current"]["seq"] == 1 and s2["current"]["question"]["id"] == q1["id"]
               and s2["current"]["deadlineAt"] == cur["deadlineAt"] and len(answer_rows(u1)) == 1,
               f"rows={answer_rows(u1)}")

        # T04
        other = next(i for i in answer_map if i != q1["id"])
        r = submit(h1, other, answer_map[other])
        record("T04", "提交未开题的题目 400", r.status_code == 400 and r.json()["detail"] == "该题尚未开始作答",
               f"status={r.status_code} detail={r.json().get('detail')}")

        # T05
        codes = [submit(h1, q1["id"], ["Z"]).status_code, submit(h1, q1["id"], ["A", "B"]).status_code,
                 submit(h1, q1["id"], []).status_code]
        record("T05", "非法选项/多选/空答案 400 且状态不变",
               codes == [400, 400, 400] and answer_rows(u1) == [(1, "answering")] and quiz_points(u1) == (0, 0),
               f"codes={codes} rows={answer_rows(u1)}")

        # T06
        r = submit(h1, q1["id"], answer_map[q1["id"]])
        a = r.json()
        record("T06", "答对即时判定，积分 +2 写入台账",
               r.status_code == 200 and a["correct"] is True and a["points"] == 2 and a["todayPoints"] == 2
               and a["correctAnswer"] == answer_map[q1["id"]] and a["analysis"] and a["seq"] == 1
               and a["finished"] is False and quiz_points(u1) == (2, 1),
               f"status={r.status_code} body={json.dumps(a, ensure_ascii=False)[:160]} pts={quiz_points(u1)}")

        # T07
        r = submit(h1, q1["id"], answer_map[q1["id"]])
        record("T07", "同一题重复提交 400，积分不变",
               r.status_code == 400 and r.json()["detail"] == "本题已作答，不能重复提交" and quiz_points(u1) == (2, 1),
               f"status={r.status_code} detail={r.json().get('detail')}")

        # T08
        d = client.get("/api/quiz/daily", headers=h1).json()
        record("T08", "作答后 daily 不自动开下一题",
               d["current"] is None and d["progress"][0] == {"seq": 1, "status": "answered", "correct": True}
               and d["progress"][1]["status"] == "pending" and d["correctCount"] == 1 and d["points"] == 2
               and len(answer_rows(u1)) == 1, f"progress={d['progress'][:2]}")

        # T09
        q2 = start(h1).json()["current"]["question"]
        shift_deadline(u1, 2, 10)
        r = submit(h1, q2["id"], answer_map[q2["id"]])
        r_again = submit(h1, q2["id"], answer_map[q2["id"]])
        record("T09", "超时提交 400 不得分，之后再提交仍 400",
               r.status_code == 400 and r.json()["detail"] == "本题作答已超时，不能再提交"
               and r_again.status_code == 400 and r_again.json()["detail"] == "本题作答已超时，不能再提交"
               and answer_rows(u1)[1] == (2, "timeout") and quiz_points(u1) == (2, 1),
               f"status={r.status_code}/{r_again.status_code} rows={answer_rows(u1)} pts={quiz_points(u1)}")

        # T10
        q3 = start(h1).json()["current"]["question"]
        shift_deadline(u1, 3, 1)
        r = submit(h1, q3["id"], answer_map[q3["id"]])
        record("T10", "截止后宽限期内提交仍受理",
               r.status_code == 200 and r.json()["correct"] is True and quiz_points(u1) == (4, 1),
               f"status={r.status_code} pts={quiz_points(u1)}")

        # T11
        start(h1)
        shift_deadline(u1, 4, 10)
        d = client.get("/api/quiz/daily", headers=h1).json()
        record("T11", "被动查询时超时题判超时",
               d["current"] is None and d["progress"][3]["status"] == "timeout" and answer_rows(u1)[3] == (4, "timeout"),
               f"progress={d['progress']}")

        # T12
        q5 = start(h1).json()["current"]["question"]
        r = submit(h1, q5["id"], [wrong_label(q5, answer_map)])
        a = r.json()
        rec = a.get("record") or {}
        det = rec.get("details") or []
        record("T12", "最后一题后生成记录（2 对 1 错 2 超时，积分 4，正确率 40%）",
               r.status_code == 200 and a["finished"] is True and a["correct"] is False and a["points"] == 0
               and rec.get("totalCount") == 5 and rec.get("correctCount") == 2 and rec.get("points") == 4
               and rec.get("score") == 40 and rec.get("accuracy") == 40 and rec.get("timeoutCount") == 2
               and [x["timeout"] for x in det] == [False, True, False, True, False]
               and [x["correct"] for x in det] == [True, False, True, False, False]
               and [x["points"] for x in det] == [2, 0, 2, 0, 0]
               and [w["index"] for w in rec.get("wrongList", [])] == [2, 4, 5]
               and det[4]["userAnswer"] == [wrong_label(q5, answer_map)] and quiz_points(u1) == (4, 1),
               f"status={r.status_code} rec={json.dumps(rec, ensure_ascii=False)[:200]}")

        # T13
        s = start(h1).json()
        r = submit(h1, q5["id"], answer_map[q5["id"]])
        recs = client.get("/api/quiz/records", headers=h1).json()
        record("T13", "完成后 start 返回记录、再提交 400；records 无明细",
               s["completed"] is True and s["current"] is None and len(s["record"]["details"]) == 5
               and r.status_code == 400 and len(recs) == 1 and recs[0]["details"] == []
               and recs[0]["accuracy"] == 40 and len(answer_rows(u1)) == 5,
               f"completed={s['completed']} answer={r.status_code} recs={recs[:1]}")

        # T14
        h2 = headers(u2, o2)
        res = None
        for _ in range(5):
            q = start(h2).json()["current"]["question"]
            res = submit(h2, q["id"], answer_map[q["id"]]).json()
        rec = res["record"] or {}
        record("T14", "全对积分 10、正确率 100",
               res["finished"] and rec["score"] == 100 and rec["points"] == 10 and rec["accuracy"] == 100
               and rec["wrongList"] == [] and quiz_points(u2) == (10, 1),
               f"rec={json.dumps(rec, ensure_ascii=False)[:160]} pts={quiz_points(u2)}")

        # T15
        h3 = headers(u3, o3)
        q = start(h3).json()["current"]["question"]
        resps = run_parallel(8, lambda: submit(h3, q["id"], answer_map[q["id"]]))
        codes = sorted(x.status_code for x in resps)
        record("T15", "同题 8 并发提交仅 1 成功、积分只发一次",
               codes.count(200) == 1 and codes.count(400) == 7 and quiz_points(u3) == (2, 1),
               f"codes={codes} pts={quiz_points(u3)}")

        # T16
        h4 = headers(u4, o4)
        resps = run_parallel(8, lambda: start(h4))
        seqs = {x.json()["current"]["seq"] for x in resps if x.status_code == 200}
        record("T16", "8 并发开题只生成 1 条作答行",
               all(x.status_code == 200 for x in resps) and seqs == {1} and answer_rows(u4) == [(1, "answering")],
               f"codes={[x.status_code for x in resps]} seqs={seqs} rows={answer_rows(u4)}")

        # T17
        start(h3)
        shift_deadline(u3, 2, 1)
        s = start(h3).json()
        record("T17", "截止后主动开下一题：当前题判超时并开新题",
               s["current"]["seq"] == 3 and answer_rows(u3)[1] == (2, "timeout"),
               f"rows={answer_rows(u3)}")

        # T18
        summary = client.get("/api/points", headers=h3).json()
        details = client.get("/api/points/daily", headers=h3).json()["items"]
        db = SessionLocal()
        try:
            check = points_service.recompute_all(db)
        finally:
            db.close()
        record("T18", "未完成会话积分计入概览与明细，全量核对无差异",
               summary["quiz"] == 2 and summary["todayQuiz"] == 2 and summary["todayCorrect"] == 1
               and details[0]["correctCount"] == 1 and details[0]["quiz"] == 2 and check["mismatches"] == 0,
               f"summary={summary.get('todayCorrect')}/{summary.get('quiz')} check={check}")

        # T19
        db = SessionLocal()
        try:
            db.add(QuizRecord(user_id=u5, date=today_str(), total_count=5, correct_count=2, score=40, points=4,
                              wrong_list=[{"index": 1, "question_id": 1, "question": "旧题", "correct_answer": "B",
                                           "analysis": "旧解析"}], answer_at=1))
            db.commit()
        finally:
            db.close()
        d = client.get("/api/quiz/daily", headers=headers(u5, o5)).json()
        rec = d["record"]
        record("T19", "历史无明细记录原样返回",
               d["completed"] is True and rec["score"] == 40 and rec["correctCount"] == 2 and rec["details"] == []
               and rec["accuracy"] == 40 and rec["wrongList"][0]["correctAnswer"] == "B",
               f"record={json.dumps(rec, ensure_ascii=False)[:160]}")

        # T20
        h6 = headers(u6, o6)
        codes = [client.post("/api/quiz/submit", headers=h6, json={"answers": []}).status_code,
                 client.post("/api/quiz/check", headers=h6, json={"questionId": 1, "answer": ["A"]}).status_code]
        record("T20", "/quiz/submit 与 /quiz/check 已移除", all(c in (404, 405) for c in codes), f"codes={codes}")

        # T21
        codes = [client.get("/api/quiz/daily").status_code, client.post("/api/quiz/start").status_code,
                 client.post("/api/quiz/answer", json={"questionId": 1, "answer": ["A"]}).status_code]
        record("T21", "未登录访问答题接口 401", codes == [401, 401, 401], f"codes={codes}")
    finally:
        engine.dispose()

    passed = sum(1 for x in RESULTS if x["ok"])
    print(f"\n== S18 每题限时作答: {passed}/{len(RESULTS)} 通过 ==")
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s18-quiz-feedback-results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"results": RESULTS}, f, ensure_ascii=False, indent=2)
    if os.path.exists(_DB_PATH):
        os.remove(_DB_PATH)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
