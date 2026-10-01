# -*- coding: utf-8 -*-
"""
S3 小程序聚合接口 冒烟脚本（后端黑盒）
覆盖：profile/summary、profile/timeline、sport/today 连续行军字段、sport/calendar、
      march/light-up 扩展（gainedPoints/litAt/nextNode）、march/node 详情内容字段、
      broadcast/today、quiz/daily issueNo、quiz/knowledge、medal/list 扩展字段。
用法：cd backend && python test/s3_aggregates.py（需后端已在 8010 运行）
"""
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:8010/api"
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


def expected_issue_no():
    start = datetime(2026, 9, 1).date()
    return (datetime.now().date() - start).days + 1


def main():
    suffix = datetime.now().strftime("%H%M%S")
    token, uid = login("s3-a-" + suffix, "S3A")
    today = datetime.now().strftime("%Y-%m-%d")
    month = datetime.now().strftime("%Y-%m")

    # ---------- 准备行为数据：6000 步 + 全错答卷 + 点亮 ----------
    http("/sport/add", token, "POST", {"delta": 6000})

    _, daily = http("/quiz/daily", token)
    record("Q1", "quiz/daily 返回 issueNo（第 N 期）",
           daily.get("issueNo") == expected_issue_no(),
           f"issueNo={daily.get('issueNo')} expect={expected_issue_no()}")

    answers = [{"questionId": q["id"], "answer": ["Z"]} for q in daily["questions"]]
    _, sub = http("/quiz/submit", token, "POST", {"answers": answers})
    wrong0 = sub["wrongList"][0] if sub["wrongList"] else {}
    record("Q2", "submit wrongList 元素含 questionId/category",
           len(sub["wrongList"]) == 5 and "questionId" in wrong0 and "category" in wrong0,
           f"wrong={len(sub['wrongList'])} keys={sorted(wrong0.keys())}")

    _, lit = http("/march/light-up", token, "POST", {})
    newly = lit["newlyLit"]
    first = newly[0] if newly else {}
    record("M1", "light-up 返回 gainedPoints/litAt/nextNode",
           len(newly) > 0 and first.get("gainedPoints") == 10 and bool(first.get("litAt"))
           and first.get("nextNode") is not None and "remain" in (first.get("nextNode") or {}),
           f"newly={len(newly)} first={json.dumps(first, ensure_ascii=False)[:160]}")

    node_id = first.get("id", 1)
    _, detail = http(f"/march/node/{node_id}", token)
    record("M2", "node 详情含历史事件卡内容字段",
           all(k in detail for k in ("brief", "significance", "figures", "location", "images", "audio", "keywords"))
           and isinstance(detail["images"], list) and bool(detail["brief"]),
           f"brief={(detail.get('brief') or '')[:30]} location={detail.get('location')}")

    # ---------- sport/today 连续行军字段 ----------
    _, st = http("/sport/today", token)
    record("S1", "sport/today 连续行军字段",
           st["currentStreak"] == 1 and st["maxStreak"] == 1 and st["streakGoal"] == 5000
           and st["todayGoalCompleted"] is True and st["nextStreakMilestone"] == 3
           and st["streakRemain"] == 2,
           f"today={json.dumps({k: st[k] for k in ('currentStreak','maxStreak','streakGoal','todayGoalCompleted','nextStreakMilestone','streakRemain')})}")

    # ---------- sport/calendar ----------
    _, cal = http(f"/sport/calendar?month={month}", token)
    day_today = next((d for d in cal["days"] if d["date"] == today), None)
    lit_names = [n["name"] for n in newly]
    record("C1", "calendar 当日格子：步数/档位/达标/答题/点亮",
           day_today is not None and day_today["steps"] == 6000 and day_today["level"] == 2
           and day_today["goalCompleted"] is True and day_today["quizDone"] is True
           and day_today["quizScore"] == 0 and sorted(day_today["litNodes"]) == sorted(lit_names),
           f"day={json.dumps(day_today, ensure_ascii=False)[:200]}")
    record("C2", "calendar 月度统计",
           len(cal["days"]) >= 28 and cal["stats"]["monthSteps"] == 6000
           and cal["stats"]["sportDays"] == 1 and cal["stats"]["avgSteps"] == 6000
           and cal["stats"]["maxSteps"] == 6000 and cal["stats"]["currentStreak"] == 1,
           f"stats={json.dumps(cal['stats'])} days={len(cal['days'])}")

    status, bad = http("/sport/calendar?month=2026/10", token)
    record("C3", "calendar month 格式校验 400", status == 400, f"status={status}")

    # ---------- quiz/knowledge ----------
    _, kn = http("/quiz/knowledge", token)
    keys = [c["key"] for c in kn["categories"]]
    asked_sum = sum(c["asked"] for c in kn["categories"])
    wrong_sum = sum(c["wrong"] for c in kn["categories"])
    record("Q3", "knowledge 分类正确率（全错：asked=wrong=5，overallRate=0）",
           keys == ["event", "route", "figure"] and asked_sum == 5 and wrong_sum == 5
           and kn["overallRate"] == 0 and all(c["rate"] == 0 for c in kn["categories"]),
           f"cats={json.dumps(kn['categories'], ensure_ascii=False)} overall={kn['overallRate']}")

    # ---------- medal/list 扩展字段 ----------
    _, ml = http("/medal/list", token)
    medals = {m["id"]: m for m in ml["medals"]}
    first_step = medals.get("first-step", {})
    fearless = medals.get("fearless", {})
    record("D1", "medal/list 扩展字段（category/sortOrder/grantedAt/conditionDesc）",
           len(ml["medals"]) == 12 and first_step.get("owned") is True
           and first_step.get("category") == "starter" and bool(first_step.get("grantedAt"))
           and fearless.get("hidden") is True and fearless.get("owned") is False
           and fearless.get("conditionDesc") == "获得条件暂未公布"
           and first_step.get("conditionDesc") == first_step.get("desc"),
           f"first={json.dumps(first_step, ensure_ascii=False)[:150]} fearless.conditionDesc={fearless.get('conditionDesc')}")

    # ---------- profile/summary ----------
    _, ps = http("/profile/summary", token)
    u, s, q, m, p = ps["user"], ps["stats"], ps["quiz"], ps["medals"], ps["points"]
    record("P1", "summary 用户与运动统计",
           u["nickname"] == "S3A" and u["joinDays"] == 1
           and s["totalSteps"] == 6000 and s["sportDays"] == 1 and s["avgDailySteps"] == 6000
           and s["maxDaySteps"] == 6000 and s["currentStreak"] == 1 and s["maxStreak"] == 1
           and s["litCount"] == len(newly) and s["totalCount"] == 10
           and s["currentNode"] is not None and s["nextNode"] is not None
           and s["nextNode"]["remain"] > 0 and s["progress"] == round(len(newly) / 10 * 100),
           f"stats={json.dumps(s, ensure_ascii=False)[:220]}")
    record("P2", "summary 答题/勋章/积分",
           q["totalCount"] == 1 and q["correctRate"] == 0 and q["fullScoreCount"] == 0
           and m["ownedCount"] >= 1 and m["totalCount"] == 12 and p["total"] > 0,
           f"quiz={json.dumps(q)} medals={json.dumps(m)} points={json.dumps(p)}")

    # ---------- profile/timeline ----------
    _, tl = http("/profile/timeline?limit=50", token)
    types = [i["eventType"] for i in tl["items"]]
    node_evt = next((i for i in tl["items"] if i["eventType"] == "NODE_UNLOCK"), None)
    record("T1", "timeline 足迹含关键事件且文案后端生成",
           {"FIRST_STEP", "DAILY_GOAL", "NODE_UNLOCK", "QUIZ_COMPLETE", "BADGE_UNLOCK"} <= set(types)
           and node_evt is not None and node_evt["text"].startswith("点亮")
           and all(i.get("text") for i in tl["items"]),
           f"types={types[:8]} nodeText={node_evt['text'] if node_evt else None}")

    # ---------- broadcast/today ----------
    _, bc = http("/broadcast/today", token)
    g, per, mem = bc["global"], bc["personal"], bc["memory"]
    record("B1", "broadcast 全局与个人播报",
           g["todayUsers"] >= 1 and g["todaySteps"] >= 6000 and g["todayLitCount"] >= len(newly)
           and g["todayQuizUsers"] >= 1 and g["totalUsers"] >= 1
           and per["todaySteps"] == 6000 and 1 <= per["beatPercent"] <= 100
           and per["remainToNext"] > 0 and bool(per["nextNodeName"]),
           f"global={json.dumps(g)} personal={json.dumps(per, ensure_ascii=False)}")
    record("B2", "broadcast 长征记忆（节点匹配或轮转推荐）",
           mem is not None and bool(mem.get("title")) and "nodeId" in mem,
           f"memory={json.dumps(mem, ensure_ascii=False) if mem else None}")

    failed = [r for r in RESULTS if not r["ok"]]
    print(f"\n== S3 冒烟：{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过 ==")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
