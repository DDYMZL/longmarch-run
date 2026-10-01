# -*- coding: utf-8 -*-
"""
S2 事件系统与连续行军 冒烟脚本（后端黑盒 + 数据库核验）
覆盖：FIRST_STEP / DAILY_GOAL / STEP_10000 / NODE_UNLOCK / BADGE_UNLOCK / STREAK_3 事件、
      连续行军推进与里程碑积分、点亮步数快照、WS activity 动态推送。
用法：cd backend && python test/s2_streak_events.py（需后端已在 8010 运行）
"""
import asyncio
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.database import SessionLocal  # noqa: E402
from app.models.models import DailySport, LitNode, User, UserEvent  # noqa: E402

BASE = "http://127.0.0.1:8010/api"
WS_BASE = "ws://127.0.0.1:8010/api/ws/updates"
RESULTS = []


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def http(path, token=None, method="GET", data=None):
    headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        BASE + path, headers=headers,
        data=json.dumps(data).encode() if data is not None else None, method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode()
            return resp.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, None


def login(code, nickname):
    status, body = http("/auth/login", method="POST", data={"code": code, "nickname": nickname})
    assert status == 200 and body and "token" in body, f"login failed: {status} {body}"
    return body["token"], body["user"]["id"]


def event_types_of(user_id):
    db = SessionLocal()
    try:
        rows = (
            db.query(UserEvent.event_type)
            .filter(UserEvent.user_id == user_id)
            .order_by(UserEvent.id.asc())
            .all()
        )
        return [r[0] for r in rows]
    finally:
        db.close()


def streak_of(user_id):
    db = SessionLocal()
    try:
        u = db.query(User).filter(User.id == user_id).first()
        return (u.continuous_days, u.max_continuous_days) if u else (None, None)
    finally:
        db.close()


def seed_history_sport(user_id, days_ago_list, steps=6000):
    """直接落库历史达标记录（模拟老用户历史），is_goal_completed 置真。"""
    db = SessionLocal()
    try:
        for n in days_ago_list:
            d = (datetime.now().date() - timedelta(days=n)).strftime("%Y-%m-%d")
            exists = (
                db.query(DailySport)
                .filter(DailySport.user_id == user_id, DailySport.date == d)
                .first()
            )
            if exists is None:
                db.add(DailySport(user_id=user_id, date=d, steps=steps,
                                  distance=round(steps * 0.7 / 1000, 2), is_goal_completed=True))
        db.commit()
    finally:
        db.close()


def main():
    suffix = datetime.now().strftime("%H%M%S")

    # ---------- 用户 A：当日事件链 ----------
    token_a, uid_a = login("s2-a-" + suffix, "S2A")

    http("/sport/add", token_a, "POST", {"delta": 3000})
    ev = event_types_of(uid_a)
    record("A1", "首次运动写 FIRST_STEP，未达标无 DAILY_GOAL",
           "FIRST_STEP" in ev and "DAILY_GOAL" not in ev and streak_of(uid_a) == (0, 0),
           f"events={ev} streak={streak_of(uid_a)}")

    http("/sport/add", token_a, "POST", {"delta": 3000})
    ev = event_types_of(uid_a)
    record("A2", "当日达 5000 写 DAILY_GOAL，连续行军=1",
           "DAILY_GOAL" in ev and streak_of(uid_a) == (1, 1), f"events={ev} streak={streak_of(uid_a)}")

    http("/sport/add", token_a, "POST", {"delta": 5000})
    ev = event_types_of(uid_a)
    record("A3", "单日破万写 STEP_10000", "STEP_10000" in ev, f"events={ev}")

    _, medals = http("/medal/list", token_a)
    owned = {m["id"] for m in medals["medals"] if m["owned"]}
    ev = event_types_of(uid_a)
    record("A4", "勋章 first-step/day-10k 发放且写 BADGE_UNLOCK",
           {"first-step", "day-10k"} <= owned and ev.count("BADGE_UNLOCK") >= 2,
           f"owned={sorted(owned)} badge_events={ev.count('BADGE_UNLOCK')}")

    _, lit = http("/march/light-up", token_a, "POST", {})
    lit_ids = [n["id"] for n in lit["newlyLit"]]
    ev = event_types_of(uid_a)
    db = SessionLocal()
    snap = [r[0] for r in db.query(LitNode.step_snapshot).filter(LitNode.user_id == uid_a).all()]
    db.close()
    record("A5", "点亮节点 1/2/3 写 NODE_UNLOCK 且记录步数快照 11000",
           lit_ids == [1, 2, 3] and ev.count("NODE_UNLOCK") == 3
           and sorted(snap) == [11000, 11000, 11000],
           f"litIds={lit_ids} node_events={ev.count('NODE_UNLOCK')} snap={snap}")

    # ---------- 用户 B：历史 2 天达标 + 今日达标 → 连续 3 天里程碑 ----------
    token_b, uid_b = login("s2-b-" + suffix, "S2B")
    seed_history_sport(uid_b, [2, 1])
    http("/sport/add", token_b, "POST", {"delta": 6000})
    ev = event_types_of(uid_b)
    _, pts = http("/points", token_b)
    streak_points = [l for l in pts["logs"] if l["reason"] == "连续行军3天"]
    record("B1", "连续 3 天：DAILY_GOAL streak=3 + STREAK_3 + 里程碑积分 +5",
           "STREAK_3" in ev and streak_of(uid_b) == (3, 3) and len(streak_points) == 1
           and streak_points[0]["delta"] == 5,
           f"events={ev} streak={streak_of(uid_b)} logs={streak_points}")

    # 重复同步不再产生里程碑（一次性成就）
    http("/sport/add", token_b, "POST", {"delta": 100})
    ev2 = event_types_of(uid_b)
    record("B2", "同日再写不重复产生 DAILY_GOAL/STREAK_3",
           ev2.count("STREAK_3") == 1 and ev2.count("DAILY_GOAL") == 1,
           f"goal={ev2.count('DAILY_GOAL')} streak3={ev2.count('STREAK_3')}")

    # ---------- WS activity 动态推送 ----------
    async def ws_check():
        import websockets
        token_c, uid_c = login("s2-c-" + suffix, "S2C")
        async with websockets.connect(WS_BASE + "?token=" + token_c) as ws:
            http("/sport/add", token_c, "POST", {"delta": 6000})
            got = None
            for _ in range(5):
                evt = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
                if evt.get("type") == "activity" and evt.get("userId") == uid_c:
                    got = evt
                    break
            return got

    try:
        activity = asyncio.run(ws_check())
        record("C1", "WS 推送 activity 动态（含文案与昵称）",
               activity is not None and activity.get("nickname") == "S2C" and activity.get("text"),
               f"activity={activity}")
    except Exception as e:  # noqa: BLE001
        record("C1", "WS 推送 activity 动态", False, f"exception: {e}")

    failed = [r for r in RESULTS if not r["ok"]]
    print(f"\n== S2 冒烟：{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过 ==")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
