"""P1-8 长征人物志 + 答题即时判题（后端）黑盒冒烟。

覆盖（需求 §14/§15）：
  P1Q-01 人物详情三元关联：毛泽东 → 简介非空、相关节点含瑞金/遵义/延安（路线顺序）、
        节点携带历史时间与事件简述
  P1Q-02 节点详情 persons 双向关联：飞夺泸定桥 → 王开湘/杨成武/廖大珠，
        且王开湘详情回链泸定桥节点
  P1Q-03 单题即时判题：今日题目逐选项探测，存在正确选项（correct=true）且
        错误选项返回 correct=false；判题不产生答题记录（无状态）
  P1Q-04 鉴权与边界：人物不存在 404；persons/check 未带 token 401

运行：python test/p1_persons.py（需后端 8010 运行，且已应用 006_persons.sql）
"""
import json
import os
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BASE = "http://127.0.0.1:8010/api"

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
    code = "p1q-%s-%s" % (int(time.time()), uuid.uuid4().hex[:8])
    st, body = req("/auth/login", method="POST", data={"code": code, "nickname": nickname})
    assert st == 200 and body.get("token"), "login failed: %s" % st
    return body["token"]


def main():
    t = new_user("P1Q人物志")

    # P1Q-01 人物详情：毛泽东 → 瑞金/遵义/延安
    st, p = req("/persons/1", t)
    assert st == 200, "person detail failed: %s" % st
    node_names = [n["name"] for n in p.get("nodes") or []]
    ok_nodes = all(name in node_names for name in ("瑞金", "遵义", "延安"))
    ok_order = [n["id"] for n in p.get("nodes") or []] == sorted(n["id"] for n in p.get("nodes") or [])
    ok_fields = all(n.get("historicalTime") and n.get("icon") for n in p.get("nodes") or [])
    record("P1Q-01", "人物详情：毛泽东简介+瑞金/遵义/延安关联（路线顺序、含历史时间）",
           p.get("name") == "毛泽东" and bool(p.get("brief")) and ok_nodes and ok_order and ok_fields,
           "nodes=%s" % node_names)

    # P1Q-02 节点详情 persons 双向关联
    st, nd = req("/march/node/6", t)
    assert st == 200, "node detail failed: %s" % st
    person_names = [pp["name"] for pp in nd.get("persons") or []]
    st, wkx = req("/persons/10", t)  # 王开湘
    assert st == 200
    back = [n["name"] for n in wkx.get("nodes") or []]
    record("P1Q-02", "节点详情人物关联：泸定桥到王开湘/杨成武/廖大珠（双向回链）",
           all(name in person_names for name in ("王开湘", "杨成武", "廖大珠"))
           and "飞夺泸定桥" in back,
           "persons=%s back=%s" % (person_names, back))

    # P1Q-03 单题即时判题：逐选项探测有且仅有正确分支，判题不写记录
    st, daily = req("/quiz/daily", t)
    assert st == 200
    questions = daily.get("questions") or []
    assert questions, "no questions today"
    q0 = questions[0]
    labels = [o["label"] for o in q0.get("options") or []]
    outcomes = {}
    for label in labels:
        st, c = req("/quiz/check", t, "POST", {"questionId": q0["id"], "answer": [label]})
        assert st == 200, "check failed: %s" % st
        outcomes[label] = c.get("correct")
    true_count = sum(1 for v in outcomes.values() if v)
    st, daily2 = req("/quiz/daily", t)
    still_unfinished = daily2.get("completed") is False
    record("P1Q-03", "单题即时判题：首题逐选项探测恰 1 个正确分支，判题不产生答题记录",
           true_count == 1 and still_unfinished,
           "outcomes=%s completed=%s" % (outcomes, daily2.get("completed")))

    # P1Q-04 鉴权与边界
    st404, _ = req("/persons/9999", t)
    st401a, _ = req("/persons/1")
    st401b, _ = req("/quiz/check", None, "POST", {"questionId": 1, "answer": ["A"]})
    record("P1Q-04", "人物不存在 404；persons/check 未带 token 401",
           st404 == 404 and st401a == 401 and st401b == 401,
           "404=%s 401=%s/%s" % (st404, st401a, st401b))

    failed = [r for r in results if not r[2]]
    print("\n== 共 %d 用例，失败 %d ==" % (len(results), len(failed)))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
