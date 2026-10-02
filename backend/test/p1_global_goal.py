"""P1-4 全员共同长征目标（后端）黑盒冒烟：GET /api/march/global。

覆盖（需求 §11）：
  P1N-01 结构：targetSteps=2 亿、4 个里程碑名称/步数递增、progressPct 与 totalSteps 自洽
  P1N-02 全员口径：两个新用户跨组织补步后全员累计精确增加（无重复统计）
  P1N-03 里程碑状态自洽：reached == (totalSteps >= steps)；nextMilestone 为首个未达成项且 remain 精确
  P1N-04 未带 token 401

运行：python test/p1_global_goal.py（需后端 8010 运行）
"""
import json
import os
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BASE = "http://127.0.0.1:8010/api"
TARGET = 200_000_000
MILESTONES = [("5000万", 50_000_000), ("1亿", 100_000_000), ("1.5亿", 150_000_000), ("2亿", 200_000_000)]

results = []


def record(cid, name, ok, detail=""):
    results.append((cid, name, bool(ok), str(detail)[:300]))
    print(("PASS" if ok else "FAIL") + " | " + cid + " " + name + (" | " + str(detail) if detail else ""))


def req(path, token=None, method="GET", data=None):
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(
        BASE + path, data=body, method=method,
        headers=dict(
            {"Authorization": "Bearer " + token} if token else {},
            **({"Content-Type": "application/json"} if body else {}),
        ),
    )
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def new_user(nickname, steps=0):
    code = "p1n-%s-%s" % (int(time.time()), uuid.uuid4().hex[:8])
    st, body = req("/auth/login", method="POST", data={"code": code, "nickname": nickname})
    assert st == 200 and body.get("token"), "login failed: %s" % st
    token = body["token"]
    if steps:
        st, _ = req("/sport/add", token, "POST", {"delta": steps})
        assert st == 200, "add steps failed: %s" % st
    return token


def get_global(token):
    st, body = req("/march/global", token)
    assert st == 200, "march/global failed: %s %s" % (st, body)
    return body


def main():
    t = new_user("P1N观察")
    b = get_global(t)

    # P1N-01 结构与自洽
    ms = b.get("milestones") or []
    ok_ms = (
        len(ms) == len(MILESTONES)
        and all(m["name"] == name and m["steps"] == steps for m, (name, steps) in zip(ms, MILESTONES))
        and all(ms[i]["steps"] < ms[i + 1]["steps"] for i in range(len(ms) - 1))
    )
    exp_pct = min(100.0, round(b["totalSteps"] / TARGET * 100, 1))
    record("P1N-01", "目标/里程碑配置与 progressPct 自洽",
           b.get("targetSteps") == TARGET and ok_ms and b.get("progressPct") == exp_pct,
           "target=%s pct=%s exp=%s" % (b.get("targetSteps"), b.get("progressPct"), exp_pct))

    # P1N-02 全员口径（相对增量，跨用户跨组织）
    before = get_global(t)["totalSteps"]
    new_user("P1N甲", 30000)
    new_user("P1N乙", 12000)
    after = get_global(t)["totalSteps"]
    record("P1N-02", "两用户补步 30000+12000 → 全员累计 +42000",
           after - before == 42000,
           "before=%s after=%s" % (before, after))

    # P1N-03 里程碑状态与 nextMilestone 自洽
    b2 = get_global(t)
    total = b2["totalSteps"]
    ok_reached = all(m["reached"] == (total >= m["steps"]) for m in b2["milestones"])
    upcoming = next((m for m in b2["milestones"] if total < m["steps"]), None)
    nm = b2.get("nextMilestone")
    if upcoming is None:
        ok_next = nm is None
        detail = "all reached"
    else:
        ok_next = (
            nm is not None
            and nm["name"] == upcoming["name"]
            and nm["steps"] == upcoming["steps"]
            and nm["remain"] == upcoming["steps"] - total
        )
        detail = "next=%s remain=%s" % (nm and nm.get("name"), nm and nm.get("remain"))
    record("P1N-03", "里程碑 reached 与 nextMilestone/remain 自洽",
           ok_reached and ok_next, "total=%s %s" % (total, detail))

    # P1N-04 未鉴权 401
    st, _ = req("/march/global")
    record("P1N-04", "未带 token 返回 401", st == 401, "status=%s" % st)

    failed = [r for r in results if not r[2]]
    print("\n== 共 %d 用例，失败 %d ==" % (len(results), len(failed)))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
