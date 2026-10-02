"""P1-6 我的长征足迹（后端）黑盒冒烟：GET /api/march/footprints。

覆盖（需求 §7）：
  P1K-01 未点亮任何节点的用户返回空足迹
  P1K-02 足迹链：同步 8000 步并点亮后返回瑞金/遵义（路线顺序）、litDate=今日、
        当日步数=8000、点亮时刻累计快照=8000
  P1K-03 字段与隐私：节点字段 ⊆ 契约集合，不含 userId 等
  P1K-04 未带 token 401

运行：python test/p1_footprints.py（需后端 8010 运行）
"""
import datetime
import json
import os
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BASE = "http://127.0.0.1:8010/api"
ALLOWED_KEYS = {"id", "name", "icon", "litAt", "litDate", "daySteps", "cumSteps"}

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
    code = "p1k-%s-%s" % (int(time.time()), uuid.uuid4().hex[:8])
    st, body = req("/auth/login", method="POST", data={"code": code, "nickname": nickname})
    assert st == 200 and body.get("token"), "login failed: %s" % st
    return body["token"]


def main():
    # P1K-01 空足迹
    t0 = new_user("P1K空足迹")
    st, b = req("/march/footprints", t0)
    record("P1K-01", "未点亮节点返回空足迹", st == 200 and b.get("nodes") == [],
           "nodes=%s" % b.get("nodes"))

    # P1K-02 足迹链：同步 8000 步 → 点亮 → 瑞金/遵义
    t1 = new_user("P1K足迹")
    st, _ = req("/sport/add", t1, "POST", {"delta": 8000})
    assert st == 200
    st, lit = req("/march/light-up", t1, "POST")
    assert st == 200
    st, b2 = req("/march/footprints", t1)
    assert st == 200
    nodes = b2.get("nodes") or []
    today = datetime.datetime.now().strftime("%Y-%m-%d")
    names = [n["name"] for n in nodes]
    ok_order = [n["id"] for n in nodes] == sorted(n["id"] for n in nodes)
    zunyi = next((n for n in nodes if n["name"] == "遵义"), None)
    record("P1K-02", "足迹链：瑞金/遵义按路线顺序、litDate=今日、当日步数/累计快照=8000",
           names == ["瑞金", "遵义"] and ok_order
           and all(n["litDate"] == today for n in nodes)
           and all(n["daySteps"] == 8000 for n in nodes)
           and zunyi is not None and zunyi["cumSteps"] == 8000,
           "names=%s litDate=%s daySteps=%s cum=%s" % (
               names, [n["litDate"] for n in nodes],
               [n["daySteps"] for n in nodes], zunyi and zunyi["cumSteps"]))

    # P1K-03 字段与隐私
    ok_keys = all(set(n.keys()) <= ALLOWED_KEYS for n in nodes) and len(nodes) > 0
    record("P1K-03", "足迹字段限于契约集合（无 userId 等）",
           ok_keys, "keys=%s" % (sorted(nodes[0].keys()) if nodes else []))

    # P1K-04 未鉴权 401
    st, _ = req("/march/footprints")
    record("P1K-04", "未带 token 返回 401", st == 401, "status=%s" % st)

    failed = [r for r in results if not r[2]]
    print("\n== 共 %d 用例，失败 %d ==" % (len(results), len(failed)))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
