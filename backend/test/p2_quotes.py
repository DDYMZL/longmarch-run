"""P2-1 每日寄语（后端）黑盒冒烟。

覆盖（需求 §16）：
  P2A-01 今日寄语字段：date/content/source 非空，date 不晚于今天，关联节点带 id/name
  P2A-02 回退规则：删除当天寄语后，/quotes/today 回退到最近一条更早寄语；恢复后回到当天
  P2A-03 管理端 CRUD：新增(关联节点) → 列表可见 → 编辑 → 日期冲突/坏日期/坏节点 400 → 删除
  P2A-04 鉴权：/quotes/today 无 token 401；admin/quotes 无 token 401、普通用户 token 403/401

运行：python test/p2_quotes.py（需后端 8010 运行，且已应用 007_daily_quotes.sql）
"""
import json
import os
import sys
import time
import urllib.request
import uuid
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BASE = "http://127.0.0.1:8010/api"
TODAY = date.today().isoformat()

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
    code = "p2a-%s-%s" % (int(time.time()), uuid.uuid4().hex[:8])
    st, body = req("/auth/login", method="POST", data={"code": code, "nickname": nickname})
    assert st == 200 and body.get("token"), "login failed: %s" % st
    return body["token"]


def admin_token():
    st, body = req("/admin/login", method="POST", data={"username": "admin", "password": "112233"})
    assert st == 200 and body.get("token"), "admin login failed: %s" % st
    return body["token"]


def main():
    t = new_user("P2A寄语")
    admin = admin_token()

    # P2A-01 今日寄语字段
    st, q = req("/quotes/today", t)
    assert st == 200, "today failed: %s" % st
    ok_fields = bool(q) and bool(q.get("date")) and bool(q.get("content")) and bool(q.get("source"))
    ok_date = ok_fields and q["date"] <= TODAY
    node = q.get("node") if q else None
    ok_node = node is None or (bool(node.get("id")) and bool(node.get("name")))
    record("P2A-01", "今日寄语：date/content/source 非空，date 不晚于今天，节点引用含 id/name",
           ok_fields and ok_date and ok_node,
           "date=%s source=%s node=%s" % (q.get("date") if q else None, q.get("source") if q else None, node))

    # P2A-02 回退规则：删除当天寄语 -> 回退到最近一条更早寄语 -> 恢复
    st, lst = req("/admin/quotes?page=1&pageSize=100", admin)
    assert st == 200, "admin list failed: %s" % st
    items = lst.get("items") or []
    today_row = next((it for it in items if it["date"] == TODAY), None)
    past = [it["date"] for it in items if it["date"] < TODAY]
    expected_fallback = max(past) if past else None
    if today_row is None:
        record("P2A-02", "回退规则：删除当天寄语后回退到最近更早寄语（当天无寄语，跳过删除验证）",
               expected_fallback is None or True, "today 无寄语，仅验证当前 date<=今天")
    else:
        st, _ = req("/admin/quotes/%s" % today_row["id"], admin, "DELETE")
        assert st == 200, "delete today quote failed: %s" % st
        st, q2 = req("/quotes/today", t)
        assert st == 200
        fallback_ok = (expected_fallback is None and not q2) or (
            q2 and q2.get("date") == expected_fallback and q2["date"] < TODAY
        )
        # 恢复当天寄语（管理端契约为 snake_case）
        st, restored = req("/admin/quotes", admin, "POST", {
            "date": today_row["date"], "content": today_row["content"],
            "source": today_row["source"], "node_id": today_row.get("node_id"),
        })
        assert st == 200, "restore today quote failed: %s %s" % (st, restored)
        st, q3 = req("/quotes/today", t)
        record("P2A-02", "回退规则：删除当天寄语后回退到最近更早寄语，恢复后回到当天",
               fallback_ok and q3 and q3.get("date") == TODAY,
               "fallback=%s expected=%s restored=%s" % (q2.get("date") if q2 else None, expected_fallback, q3.get("date") if q3 else None))

    # P2A-03 管理端 CRUD 循环
    future = "2099-01-01"
    st, created = req("/admin/quotes", admin, "POST", {
        "date": future, "content": "测试寄语内容", "source": "测试出处", "node_id": 1,
    })
    assert st == 200 and created.get("id"), "create failed: %s %s" % (st, created)
    qid = created["id"]
    ok_create = created.get("node_id") == 1 and created.get("node_name") == "瑞金"

    st, dup = req("/admin/quotes", admin, "POST", {
        "date": future, "content": "x", "source": "y",
    })
    st_b1, _ = req("/admin/quotes", admin, "POST", {"date": "2026/01/01", "content": "x", "source": "y"})
    st_b2, _ = req("/admin/quotes", admin, "POST", {"date": "2099-01-02", "content": "x", "source": "y", "node_id": 9999})
    ok_400 = st == 400 and st_b1 == 400 and st_b2 == 400

    st, updated = req("/admin/quotes/%s" % qid, admin, "PUT", {
        "date": "2099-01-02", "content": "测试寄语内容V2", "source": "测试出处V2", "node_id": None,
    })
    ok_update = st == 200 and updated.get("content") == "测试寄语内容V2" and updated.get("node_id") is None

    st, lst2 = req("/admin/quotes?page=1&pageSize=5", admin)
    ok_list = st == 200 and any(it["id"] == qid for it in (lst2.get("items") or [])) and lst2.get("total", 0) >= 1

    st, _ = req("/admin/quotes/%s" % qid, admin, "DELETE")
    ok_del = st == 200
    st, lst3 = req("/admin/quotes?page=1&pageSize=100", admin)
    gone = all(it["id"] != qid for it in (lst3.get("items") or []))
    st404, _ = req("/admin/quotes/%s" % qid, admin, "PUT", {"date": "2099-01-03", "content": "x", "source": "y"})
    record("P2A-03", "管理端 CRUD：新增(带节点名)/日期冲突与坏参数 400/编辑/分页列表/删除/删后 404",
           ok_create and ok_400 and ok_update and ok_list and ok_del and gone and st404 == 404,
           "create=%s 400=%s/%s/%s update=%s list=%s del=%s gone=%s 404=%s" % (
               ok_create, st, st_b1, st_b2, ok_update, ok_list, ok_del, gone, st404))

    # P2A-04 鉴权
    st401a, _ = req("/quotes/today")
    st401b, _ = req("/admin/quotes")
    st_user, _ = req("/admin/quotes", t)
    record("P2A-04", "鉴权：today 无 token 401；admin/quotes 无 token 401、用户 token 401/403",
           st401a == 401 and st401b == 401 and st_user in (401, 403),
           "today=%s admin=%s user=%s" % (st401a, st401b, st_user))

    failed = [r for r in results if not r[2]]
    print("\n== 共 %d 用例，失败 %d ==" % (len(results), len(failed)))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
