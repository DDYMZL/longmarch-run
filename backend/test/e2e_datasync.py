# -*- coding: utf-8 -*-
"""
数据联动功能端到端验收脚本（后端黑盒）
覆盖：小程序数据接口 / 管理端聚合接口 / WebSocket 实时推送
用法：cd backend && python test/e2e_datasync.py
结果：stdout PASS/FAIL + test/e2e-results.json 证据文件
"""
import asyncio
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.database import SessionLocal  # noqa: E402
from app.core.security import create_access_token, create_admin_token  # noqa: E402
from app.models.models import User  # noqa: E402

BASE = "http://127.0.0.1:8010/api"
WS_BASE = "ws://127.0.0.1:8010/api/ws/updates"

# 题库全量答案映射（id -> 正确选项 label）
ANSWERS = {1: "B", 2: "A", 3: "A", 4: "A", 5: "A", 6: "A", 7: "A", 8: "A",
           9: "B", 10: "A", 11: "C", 12: "A", 13: "A", 14: "A", 15: "A"}

RESULTS = []
TEST_USER_ID = 5  # 孙三：无今日答题记录，作为变更类用例对象


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:500]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def http(path, token=None, method="GET", data=None):
    headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        BASE + path,
        headers=headers,
        data=json.dumps(data).encode() if data is not None else None,
        method=method,
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


def main():
    print("== 数据联动后端端到端验收 ==")

    # ---------- 0. 令牌准备（并重置今日答题，保证脚本可重复执行） ----------
    user_token = create_access_token(TEST_USER_ID, "e2e-datasync")
    admin_token = create_admin_token("admin")
    http("/quiz/reset", user_token, "POST")

    # ---------- 1. 管理端聚合接口 ----------
    st, data = http("/admin/rankings", admin_token)
    record("B01", "管理端排名总览", st == 200 and len(data.get("items", [])) >= 5,
           "users=%d totalSteps=%d" % (len(data.get("items", [])), data.get("total_steps", -1)))

    st, ov = http("/admin/users/%d/overview" % TEST_USER_ID, admin_token)
    ok = st == 200 and all(k in ov for k in ("user", "sport", "quiz_records", "medals", "march", "points"))
    record("B02", "人员详情聚合（五模块齐全）", ok,
           "keys=%s march.nodes=%d medals=%d points.total=%d" % (
               sorted(ov.keys()) if st == 200 else [], len((ov.get("march") or {}).get("nodes", [])),
               len(ov.get("medals", [])), (ov.get("points") or {}).get("total")))

    st, _ = http("/admin/users/99999/overview", admin_token)
    record("B03", "人员详情-不存在用户返回404", st == 404, "status=%d" % st)

    # ---------- 2. 小程序数据接口 ----------
    st, data = http("/sport/today", user_token)
    record("M01", "运动-今日步数", st == 200 and set(data) == {"date", "steps", "target", "totalSteps"},
           json.dumps(data, ensure_ascii=False))

    st, data = http("/sport/recent?n=30", user_token)
    record("M02", "运动-最近30天", st == 200 and len(data) == 30 and all({"date", "steps", "text"} <= set(r) for r in data),
           "days=%d" % (len(data) if isinstance(data, list) else -1))

    st, data = http("/march/route", user_token)
    ok = st == 200 and data.get("nodes") and all(
        {"latitude", "longitude", "description", "historicalTime", "status"} <= set(n) for n in data["nodes"])
    record("M03", "长征-路线节点含经纬度/史料", ok,
           "nodes=%d lit=%d/%d" % (len(data.get("nodes", [])), data.get("litCount"), data.get("totalCount")))

    st, data = http("/march/node/1", user_token)
    record("M04", "长征-节点详情", st == 200 and {"targetSteps", "currentSteps", "status"} <= set(data),
           "status=%s remain=%d" % (data.get("status"), data.get("remain", -1)))

    st, data = http("/quiz/daily", user_token)
    ok = st == 200 and len(data.get("questions") or []) == 5 and data.get("completed") is False \
        and all("answer" not in q for q in data["questions"])
    record("M05", "答题-每日5题且不泄露答案", ok,
           "questions=%d completed=%s" % (len(data.get("questions") or []), data.get("completed")))

    st, data = http("/medal/list", user_token)
    record("M06", "勋章-列表自动评估", st == 200 and len(data.get("medals", [])) == 6 and "ownedCount" in data,
           "owned=%d/6" % data.get("ownedCount", -1))

    st, data = http("/points", user_token)
    record("M07", "积分-总额与流水", st == 200 and "total" in data and isinstance(data.get("logs"), list),
           "total=%d" % data.get("total", -1))

    st, data = http("/rank/steps", user_token)
    record("M08", "排名-全员步数榜", st == 200 and data.get("list") and "myRank" in data and "total" in data,
           "total=%d myRank=%d" % (data.get("total"), data.get("myRank")))

    st, data = http("/org/children", user_token)
    record("M09", "组织-顶级列表", st == 200 and data.get("nodes") and all({"hasChildren", "childCount"} <= set(n) for n in data["nodes"]),
           "nodes=%d" % len(data.get("nodes", [])))

    # 组织选择：读当前组织后原样回选（无副作用变更）
    with SessionLocal() as db:
        u = db.query(User).filter(User.id == TEST_USER_ID).first()
        org_id = u.org_id if u else None
    if org_id:
        st, data = http("/org/select", user_token, "POST", {"orgId": org_id})
        record("M10", "组织-选定回写", st == 200 and data.get("orgId") == org_id,
               "orgId=%s fullName=%s" % (data.get("orgId"), data.get("fullName")))
    else:
        record("M10", "组织-选定回写", False, "测试用户无组织")

    # ---------- 3. 变更链路（运动同步 + 点亮 + 勋章刷新） ----------
    st, data = http("/sport/add", user_token, "POST", {"delta": 1500})
    record("M11", "运动-补充步数", st == 200 and data.get("steps", 0) >= 38000 + 1500,
           "steps=%d" % data.get("steps", -1))

    st, data = http("/march/light-up", user_token, "POST")
    record("M12", "长征-点亮达标节点", st == 200 and isinstance(data.get("newlyLit"), list),
           "newly=%d" % len(data.get("newlyLit", [])))

    st, data = http("/medal/check", user_token, "POST")
    record("M13", "勋章-主动评估发放", st == 200 and isinstance(data.get("newly"), list),
           "newly=%s" % json.dumps(data.get("newly"), ensure_ascii=False))

    # ---------- 4. 答题提交（重置 -> 判分 + 积分 + 广播） ----------
    st, _ = http("/quiz/reset", user_token, "POST")
    st, daily = http("/quiz/daily", user_token)
    ok = st == 200 and daily.get("completed") is False and len(daily.get("questions") or []) == 5
    record("M13b", "答题-重置今日答题", ok, "completed=%s questions=%d" % (
        daily.get("completed"), len(daily.get("questions") or [])))

    payload = [{"questionId": q["id"], "answer": [ANSWERS[q["id"]]]} for q in daily["questions"]]
    st, rec = http("/quiz/submit", user_token, "POST", {"answers": payload})
    ok = st == 200 and rec.get("score") == 100 and rec.get("correctCount") == 5
    record("M14", "答题-提交判分满分", ok, "score=%s correct=%s/%s" % (
        rec.get("score"), rec.get("correctCount"), rec.get("totalCount")))

    st, records = http("/quiz/records", user_token)
    record("M15", "答题-记录列表", st == 200 and len(records) == 1 and records[0].get("score") == 100,
           "records=%d" % len(records))

    st, pts = http("/points", user_token)
    has_quiz = any("答题" in (l.get("reason") or "") for l in pts.get("logs", []))
    record("M16", "积分-答题积分入账", has_quiz, "logs=%s" % json.dumps(pts.get("logs"), ensure_ascii=False)[:200])

    # ---------- 5. WebSocket 实时推送 ----------
    asyncio.run(ws_tests(user_token, admin_token))

    # ---------- 落盘 ----------
    out = Path(__file__).parent / "e2e-results.json"
    out.write_text(json.dumps({
        "date": time.strftime("%Y-%m-%d %H:%M:%S"),
        "backend": BASE,
        "testUser": TEST_USER_ID,
        "results": RESULTS,
        "passed": sum(1 for r in RESULTS if r["ok"]),
        "failed": sum(1 for r in RESULTS if not r["ok"]),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n== 结果：%d 通过 / %d 失败，证据 -> %s" % (
        sum(1 for r in RESULTS if r["ok"]), sum(1 for r in RESULTS if not r["ok"]), out))


async def ws_tests(user_token, admin_token):
    import websockets

    # 5.1 有效用户令牌可连接，数据变更后收到广播
    try:
        async with websockets.connect(WS_BASE + "?token=" + user_token) as ws:
            st, _ = http("/sport/add", user_token, "POST", {"delta": 100})
            evt = await asyncio.wait_for(ws.recv(), timeout=8)
            evt = json.loads(evt)
            ok = evt.get("type") == "data_changed" and evt.get("reason") == "sport.add" and evt.get("user_id") == TEST_USER_ID
            record("W01", "WS-用户令牌连接并接收运动变更广播", ok, json.dumps(evt, ensure_ascii=False))
    except Exception as e:
        record("W01", "WS-用户令牌连接并接收运动变更广播", False, repr(e)[:200])

    # 5.2 管理端令牌同样可连接（排名洞察实时刷新链路）
    try:
        async with websockets.connect(WS_BASE + "?token=" + admin_token) as ws:
            st, _ = http("/sport/add", user_token, "POST", {"delta": 100})
            evt = json.loads(await asyncio.wait_for(ws.recv(), timeout=8))
            ok = evt.get("type") == "data_changed"
            record("W02", "WS-管理端令牌连接并接收广播", ok, json.dumps(evt, ensure_ascii=False))
    except Exception as e:
        record("W02", "WS-管理端令牌连接并接收广播", False, repr(e)[:200])

    # 5.3 无效令牌被拒绝（握手失败）
    try:
        async with websockets.connect(WS_BASE + "?token=bad.token.here") as ws:
            await asyncio.wait_for(ws.recv(), timeout=8)
        record("W03", "WS-无效令牌拒绝", False, "连接意外保持")
    except websockets.exceptions.InvalidStatus as e:
        record("W03", "WS-无效令牌拒绝", "403" in str(e), str(e)[:120])
    except Exception as e:
        record("W03", "WS-无效令牌拒绝", True, repr(e)[:120])


if __name__ == "__main__":
    main()
