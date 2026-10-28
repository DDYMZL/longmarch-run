# -*- coding: utf-8 -*-
"""
复制导入冒烟（TestClient + SQLite 临时库，不依赖 8010/openGauss）

  P01 一次写入 3 道，分值被改成默认 20，返回连续 id
  P02 与库内重复、批内重复、非法题跳过，合法题仍写入
  P03 超过 500 道拒绝，不写库
  P04 500 道一次写入并一次改分值
  P05 改分值只影响传入的 id
  P06 分值为 0、空 id 列表返回 400
  P07 未登录 401

用法：cd backend && python test/s32_paste_question_import.py
"""
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_smoke_paste.db")
if os.path.exists(_DB_PATH):
    os.remove(_DB_PATH)
os.environ["DATABASE_URL"] = "sqlite:///" + _DB_PATH.replace("\\", "/")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

from app.core.database import Base, SessionLocal, engine
from app.core.security import create_admin_token
from app.main import app
from app.models.models import Question

RESULTS = []


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def question(text, score=99, answer="A"):
    return {
        "type": "single",
        "category": "event",
        "question": text,
        "options": [{"label": "A", "text": "甲"}, {"label": "B", "text": "乙"}],
        "answer": [answer],
        "analysis": "解析",
        "score": score,
    }


def main():
    Base.metadata.create_all(engine)
    client = TestClient(app)
    headers = {"Authorization": "Bearer " + create_admin_token("s32-smoke")}
    try:
        payload = [question("S32起点是哪里？"), question("S32转折点是哪次会议？"), question("S32哪次行动打乱了追剿？")]
        r = client.post("/api/admin/questions/paste-import", headers=headers, json={"questions": payload})
        body = r.json()
        db = SessionLocal()
        try:
            stored = db.query(Question).filter(Question.question.like("S32%")).order_by(Question.id).all()
        finally:
            db.close()
        record(
            "P01",
            "三题一次写入且分值为 20",
            r.status_code == 200
            and body.get("saved") == 3
            and body.get("failed") == 0
            and body.get("ids") == [item.id for item in stored]
            and all(item.score == 20 for item in stored),
            f"status={r.status_code} saved={body.get('saved')} scores={[item.score for item in stored]}",
        )

        dup = [
            question("S32起点是哪里？"),
            question("S32新题一"),
            question("S32新题一"),
            question("S32坏题", answer="Z"),
        ]
        r = client.post("/api/admin/questions/paste-import", headers=headers, json={"questions": dup})
        body = r.json()
        reasons = [item["reason"] for item in body.get("failures", [])]
        record(
            "P02",
            "重复与非法题跳过，合法题写入",
            r.status_code == 200
            and body.get("saved") == 1
            and body.get("failed") == 3
            and any("已有题目" in text for text in reasons)
            and any("其他题目" in text for text in reasons)
            and any("不在选项" in text for text in reasons),
            f"saved={body.get('saved')} reasons={reasons}",
        )

        before = SessionLocal()
        try:
            count_before = before.query(Question).filter(Question.question.like("S32超量%")).count()
        finally:
            before.close()
        too_many = [question(f"S32超量{i}") for i in range(501)]
        r = client.post("/api/admin/questions/paste-import", headers=headers, json={"questions": too_many})
        after = SessionLocal()
        try:
            count_after = after.query(Question).filter(Question.question.like("S32超量%")).count()
        finally:
            after.close()
        record(
            "P03",
            "超过 500 道拒绝且不写库",
            r.status_code == 400 and count_before == count_after == 0,
            f"status={r.status_code} detail={r.json().get('detail')}",
        )

        batch = [question(f"S32批量{i}") for i in range(500)]
        started = time.perf_counter()
        r = client.post("/api/admin/questions/paste-import", headers=headers, json={"questions": batch})
        elapsed = time.perf_counter() - started
        body = r.json()
        ids = body.get("ids") or []
        score_started = time.perf_counter()
        r2 = client.post(
            "/api/admin/questions/batch-score",
            headers=headers,
            json={"ids": ids, "score": 30},
        )
        score_elapsed = time.perf_counter() - score_started
        db = SessionLocal()
        try:
            scores = [row[0] for row in db.query(Question.score).filter(Question.id.in_(ids)).all()] if ids else []
        finally:
            db.close()
        record(
            "P04",
            "500 道一次写入并一次改分",
            r.status_code == 200
            and body.get("saved") == 500
            and len(ids) == 500
            and elapsed < 15
            and r2.status_code == 200
            and r2.json().get("updated") == 500
            and score_elapsed < 5
            and len(scores) == 500
            and set(scores) == {30},
            f"import={elapsed:.2f}s score={score_elapsed:.2f}s saved={body.get('saved')} updated={r2.json().get('updated')}",
        )

        kept = client.post(
            "/api/admin/questions/paste-import",
            headers=headers,
            json={"questions": [question("S32不改分")] },
        ).json()
        client.post(
            "/api/admin/questions/batch-score",
            headers=headers,
            json={"ids": ids[:2], "score": 40},
        )
        db = SessionLocal()
        try:
            untouched = db.query(Question).filter(Question.question == "S32不改分").one()
            changed = db.query(Question).filter(Question.id == ids[0]).one().score
            neighbour = db.query(Question).filter(Question.id == ids[2]).one().score
        finally:
            db.close()
        record(
            "P05",
            "改分值只影响传入 id",
            untouched.score == 20 and changed == 40 and neighbour == 30 and kept.get("saved") == 1,
            f"untouched={untouched.score} changed={changed} neighbour={neighbour}",
        )

        bad_score = client.post(
            "/api/admin/questions/batch-score",
            headers=headers,
            json={"ids": ids[:1], "score": 0},
        )
        empty_ids = client.post(
            "/api/admin/questions/batch-score",
            headers=headers,
            json={"ids": [], "score": 20},
        )
        record(
            "P06",
            "非法分值与空列表被拒绝",
            bad_score.status_code == 400 and empty_ids.status_code == 400,
            f"score={bad_score.status_code} empty={empty_ids.status_code}",
        )

        anon = client.post("/api/admin/questions/paste-import", json={"questions": payload})
        record("P07", "未登录 401", anon.status_code == 401, f"status={anon.status_code}")
    finally:
        db = SessionLocal()
        try:
            db.query(Question).filter(Question.question.like("S32%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        engine.dispose()

    passed = sum(1 for item in RESULTS if item["ok"])
    print(f"\n== S32 复制导入: {passed}/{len(RESULTS)} 通过 ==")
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s32-paste-question-import-results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"results": RESULTS}, f, ensure_ascii=False, indent=2)
    if os.path.exists(_DB_PATH):
        os.remove(_DB_PATH)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
