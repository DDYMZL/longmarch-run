"""P1-7 数据画像（后端）黑盒冒烟：GET /api/profile/summary 的 portrait 字段。

覆盖（需求 §17）：
  P1O-01 画像五维齐全且均在 0~100；全新用户行军/坚持/知识/成就为 0，
        路线维度与瑞金（目标 0 步）天然完成的进度一致
  P1O-02 同步 8000 步并点亮后：行军/路线提升，知识=0；
        五维取值与 summary 自身统计按公式交叉验证一致
  P1O-03 未带 token 401

公式（与 profile_service._portrait 对齐，满分参照：运动天数/连续天数 30、答题次数 50）：
  行军 = 累计步数/路线全程*70 + min(运动天数,30)/30*30
  坚持 = min(最长连续,30)/30*60 + min(当前连续,30)/30*40
  知识 = min(答题次数,50)/50*50 + 正确率*0.5
  路线 = 节点完成比例
  成就 = 勋章完成比例*70 + 连续里程碑档数(3/7/14/30/60)/5*30

运行：python test/p1_portrait.py（需后端 8010 运行）
"""
import json
import os
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BASE = "http://127.0.0.1:8010/api"
DIMS = ["march", "persistence", "knowledge", "route", "achievement"]
STREAK_MILESTONES = [3, 7, 14, 30, 60]

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


def new_user(nickname):
    code = "p1o-%s-%s" % (int(time.time()), uuid.uuid4().hex[:8])
    st, body = req("/auth/login", method="POST", data={"code": code, "nickname": nickname})
    assert st == 200 and body.get("token"), "login failed: %s" % st
    return body["token"]


def expected_portrait(summary, route_total_steps):
    s, q, m = summary["stats"], summary["quiz"], summary["medals"]
    steps_ref = route_total_steps if route_total_steps > 0 else 1
    march_v = s["totalSteps"] / steps_ref * 70 + min(s["sportDays"], 30) / 30 * 30
    persistence_v = min(s["maxStreak"], 30) / 30 * 60 + min(s["currentStreak"], 30) / 30 * 40
    knowledge_v = min(q["totalCount"], 50) / 50 * 50 + q["correctRate"] * 0.5
    route_v = round(s["litCount"] / s["totalCount"] * 100) if s["totalCount"] else 0
    medal_ratio = m["ownedCount"] / m["totalCount"] if m["totalCount"] else 0
    streak_ms = sum(1 for ms in STREAK_MILESTONES if s["maxStreak"] >= ms)
    achievement_v = medal_ratio * 70 + streak_ms / len(STREAK_MILESTONES) * 30
    return {
        "march": min(100, round(march_v)),
        "persistence": min(100, round(persistence_v)),
        "knowledge": min(100, round(knowledge_v)),
        "route": min(100, route_v),
        "achievement": min(100, round(achievement_v)),
    }


def main():
    # P1O-01 全新用户：五维齐全、取值域 0~100；行军/坚持/知识/成就为 0，
    # 路线维度 = 瑞金（目标 0 步）天然完成 → litCount/totalCount
    t0 = new_user("P1O画像")
    st, b = req("/profile/summary", t0)
    assert st == 200, "summary failed: %s" % st
    st, route0 = req("/march/route", t0)
    assert st == 200
    p = b.get("portrait") or {}
    exp0 = expected_portrait(b, route0.get("totalSteps") or 0)
    record("P1O-01", "画像五维齐全（值域 0~100），全新用户行军/坚持/知识/成就为 0 且路线=天然进度",
           sorted(p.keys()) == sorted(DIMS)
           and all(isinstance(p[d], int) and 0 <= p[d] <= 100 for d in DIMS)
           and all(p[d] == 0 for d in ["march", "persistence", "knowledge", "achievement"])
           and all(p[d] == exp0[d] for d in DIMS),
           "portrait=%s expected=%s" % (p, exp0))

    # P1O-02 同步 8000 步并点亮：行军/路线 >0、知识=0，且与公式交叉一致
    t1 = new_user("P1O画像行军")
    st, _ = req("/sport/add", t1, "POST", {"delta": 8000})
    assert st == 200
    st, _ = req("/march/light-up", t1, "POST")
    assert st == 200
    st, b2 = req("/profile/summary", t1)
    assert st == 200
    st, route = req("/march/route", t1)
    assert st == 200
    p2 = b2.get("portrait") or {}
    exp = expected_portrait(b2, route.get("totalSteps") or 0)
    record("P1O-02", "8000步点亮后行军/路线>0、知识=0，五维与公式交叉一致",
           p2.get("march", 0) > 0 and p2.get("route", 0) > 0 and p2.get("knowledge") == 0
           and all(p2.get(d) == exp[d] for d in DIMS),
           "portrait=%s expected=%s" % (p2, exp))

    # P1O-03 未鉴权 401
    st, _ = req("/profile/summary")
    record("P1O-03", "未带 token 返回 401", st == 401, "status=%s" % st)

    failed = [r for r in results if not r[2]]
    print("\n== 共 %d 用例，失败 %d ==" % (len(results), len(failed)))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
