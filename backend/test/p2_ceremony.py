"""P2-2 长征完成仪式触发标记（后端）黑盒冒烟。

覆盖（需求 §20）：
  P2C-01 未完成路线：/march/route finished=false 且 ceremony_pending=false
  P2C-02 完成路线后：finished=true 且 ceremony_pending=true（首次触发完整仪式）
  P2C-03 标记已观看：POST /march/ceremony 后 ceremony_pending=false；重复调用幂等
  P2C-04 鉴权：/march/ceremony 未带 token 401

运行：python test/p2_ceremony.py（需后端 8010 运行，且已应用 008_route_ceremony.sql）
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
    code = "p2c-%s-%s" % (int(time.time()), uuid.uuid4().hex[:8])
    st, body = req("/auth/login", method="POST", data={"code": code, "nickname": nickname})
    assert st == 200 and body.get("token"), "login failed: %s" % st
    return body["token"]


def main():
    t = new_user("P2C仪式")

    # P2C-01 未完成路线：不下发仪式触发
    st, route = req("/march/route", t)
    ok = (
        st == 200
        and route.get("finished") is False
        and route.get("ceremonyPending") is False
    )
    record("P2C-01", "未完成路线无仪式触发", ok, "finished=%s pending=%s" % (route.get("finished"), route.get("ceremonyPending")))

    # 补足步数点亮全部节点（终点 65000）
    st, _ = req("/sport/add", t, method="POST", data={"delta": 70000})
    assert st == 200, "sport add failed: %s" % st
    st, lit = req("/march/light-up", t, method="POST")
    assert st == 200, "light-up failed: %s" % st

    # P2C-02 完成路线后：下发首次仪式触发
    st, route = req("/march/route", t)
    ok = (
        st == 200
        and route.get("finished") is True
        and route.get("ceremonyPending") is True
        and route.get("litCount") == route.get("totalCount")
    )
    record("P2C-02", "完成路线触发首次仪式", ok, "finished=%s pending=%s lit=%s/%s" % (
        route.get("finished"), route.get("ceremonyPending"), route.get("litCount"), route.get("totalCount")))

    # P2C-03 标记已观看：pending 消失；重复标记幂等
    st, body = req("/march/ceremony", t, method="POST")
    ok1 = st == 200 and body.get("ok") is True
    st, route = req("/march/route", t)
    ok2 = st == 200 and route.get("finished") is True and route.get("ceremonyPending") is False
    st, body = req("/march/ceremony", t, method="POST")
    ok3 = st == 200 and body.get("ok") is True
    st, route = req("/march/route", t)
    ok4 = st == 200 and route.get("ceremonyPending") is False
    record("P2C-03", "标记已观看且幂等", ok1 and ok2 and ok3 and ok4,
           "mark=%s after=%s again=%s final=%s" % (ok1, ok2, ok3, ok4))

    # P2C-04 鉴权
    st, _ = req("/march/ceremony", method="POST")
    record("P2C-04", "仪式标记未带token 401", st == 401, "status=%s" % st)

    passed = sum(1 for r in results if r[2])
    print("== %d/%d 通过 ==" % (passed, len(results)))
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
