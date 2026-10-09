"""P1-3 组织共同长征目标（后端）黑盒冒烟：GET /api/org/march。

覆盖（需求 §10）：
  P1M-01 未选组织：org=null / totalSteps=0 / nodes=[]
  P1M-02 累计口径：成员补步后组织累计精确增加（子树成员累计有效步数之和）
  P1M-03 路线计算：节点状态/pct/当前到达/下一站/进度百分比与响应 totalSteps 自洽
  P1M-04 子树口径：选父组织后兄弟子组织成员累计步数计入
  P1M-05 完成态边界：未走完全程时 finished=false 且 litCount 与目标阈值一致
  P1M-06 未带 token 401

运行：python test/p1_org_march.py（需后端 8010 运行）
"""
import json
import os
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BASE = "http://127.0.0.1:8010/api"
ORG_HUABEI = 3   # 华北分公司（子：8 市场部、9 技术部）
ORG_HB_MARKET = 8
ORG_HB_TECH = 9

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


def new_user(nickname, org_id=None, steps=0):
    code = "p1m-%s-%s" % (int(time.time()), uuid.uuid4().hex[:8])
    st, body = req("/auth/login", method="POST", data={"code": code, "nickname": nickname})
    assert st == 200 and body.get("token"), "login failed: %s" % st
    token = body["token"]
    if org_id:
        st, _ = req("/org/select", token, "POST", {"orgId": org_id})
        assert st == 200, "select org failed: %s" % st
    if steps:
        st, _ = req("/sport/add", token, "POST", {"delta": steps})
        assert st == 200, "add steps failed: %s" % st
    return token


def get_org_march(token):
    st, body = req("/org/march", token)
    assert st == 200, "org/march failed: %s %s" % (st, body)
    return body


def main():
    # P1M-01 未选组织
    t0 = new_user("P1M未选组")
    b = get_org_march(t0)
    record("P1M-01", "未选组织返回空组织长征",
           b.get("org") is None and b.get("totalSteps") == 0 and b.get("nodes") == [],
           json.dumps({k: b.get(k) for k in ("org", "totalSteps", "memberCount")}, ensure_ascii=False))

    # P1M-02 累计口径（相对增量）
    me = new_user("P1M本人", ORG_HB_TECH)
    before = get_org_march(me)
    st, _ = req("/sport/add", me, "POST", {"delta": 8000})
    assert st == 200
    after = get_org_march(me)
    record("P1M-02", "成员补步 8000 → 组织累计 +8000",
           after["totalSteps"] - before["totalSteps"] == 8000,
           "before=%s after=%s" % (before["totalSteps"], after["totalSteps"]))

    # P1M-03 路线计算自洽（以响应 totalSteps 反推预期，验证全链路口径）
    total = after["totalSteps"]
    nodes = after["nodes"]
    exp_lit = sum(1 for n in nodes if total >= n["targetSteps"])
    cur = next((i for i, n in enumerate(nodes) if total < n["targetSteps"]), None)
    ok_status = all(
        (n["status"] == "completed") == (total >= n["targetSteps"]) for n in nodes
    )
    ok_pct = True
    for i, n in enumerate(nodes):
        want = 100 if total >= n["targetSteps"] else (
            min(100, round(total / n["targetSteps"] * 100)) if i == cur else 0)
        if n["pct"] != want:
            ok_pct = False
            break
    exp_current = nodes[cur]["name"] if cur is not None else nodes[-1]["name"]
    exp_next = nodes[cur + 1]["name"] if cur is not None and cur + 1 < len(nodes) else ""
    exp_progress = round(min(1.0, total / 65000) * 100)
    record("P1M-03", "节点状态/pct/当前到达/下一站/进度 与 totalSteps 自洽",
           ok_status and ok_pct
           and after["currentNodeName"] == exp_current
           and after["nextNodeName"] == exp_next
           and after["progressPct"] == exp_progress,
           "total=%s current=%s next=%s pct=%s" % (total, after["currentNodeName"], after["nextNodeName"], after["progressPct"]))

    # P1M-04 子树口径：兄弟组织成员计入（选父组织后）
    new_user("P1M同伴", ORG_HB_MARKET, 6000)
    b9 = get_org_march(me)
    st, _ = req("/org/select", me, "POST", {"orgId": ORG_HUABEI})
    assert st == 200
    b3 = get_org_march(me)
    record("P1M-04", "子树口径：选父组织后兄弟组织累计步数计入",
           b3["totalSteps"] - b9["totalSteps"] >= 6000
           and b3["memberCount"] - b9["memberCount"] >= 1,
           "ds=%s dc=%s" % (b3["totalSteps"] - b9["totalSteps"], b3["memberCount"] - b9["memberCount"]))

    # P1M-05 完成态边界：b9 未走完全程（finished 与 litCount 自洽）；
    # 显式把子树累计推过延安目标（不依赖历史测试数据累积，DB 重建后仍可复现），
    # 再验证全程完成态字段（finished=true / pct=100 / 当前到达=延安 / 下一站空）
    ok_b9 = (b9["finished"] == (b9["litCount"] == b9["totalCount"] and b9["totalCount"] > 0)
             and b9["litCount"] == sum(1 for n in b9["nodes"] if b9["totalSteps"] >= n["targetSteps"]))
    if b3["totalSteps"] < 65000:
        st, _ = req("/sport/add", me, "POST", {"delta": 65000 + 1000 - b3["totalSteps"]})
        assert st == 200
        b3 = get_org_march(me)
    ok_b3 = (b3["totalSteps"] >= 65000 and b3["finished"] is True
             and b3["litCount"] == b3["totalCount"] and b3["progressPct"] == 100
             and b3["currentNodeName"] == "延安" and b3["nextNodeName"] == "")
    record("P1M-05", "完成态边界：未完成自洽 + 全程完成态字段",
           ok_b9 and ok_b3,
           "b9 lit=%s/%s finished=%s | b3 total=%s finished=%s current=%s" % (
               b9["litCount"], b9["totalCount"], b9["finished"],
               b3["totalSteps"], b3["finished"], b3["currentNodeName"]))

    # P1M-06 未鉴权 401
    st, _ = req("/org/march")
    record("P1M-06", "未带 token 返回 401", st == 401, "status=%s" % st)

    failed = [r for r in results if not r[2]]
    print("\n== 共 %d 用例，失败 %d ==" % (len(results), len(failed)))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
