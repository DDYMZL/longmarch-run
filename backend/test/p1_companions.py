"""P1-2 同组织同行者（后端）黑盒冒烟：GET /api/org/companions。

覆盖（需求 §9）：
  P1C-01 未选组织：org=null / memberCount=0 / companions=[]
  P1C-02 本人入列：isSelf 标记与今日步数
  P1C-03 同行者增量：新同伴加入后 memberCount/todayTotal 精确增加、列表按今日步数倒序
  P1C-04 隐私边界：条目只含 nickname/avatar/todaySteps/isSelf（无 id/openid）
  P1C-05 limit 截断且第一名是步数最高者
  P1C-06 子树口径：选父组织后，兄弟子组织成员计入统计
  P1C-07 未带 token 401

运行：python test/p1_companions.py（需后端 8010 运行）
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
    code = "p1c-%s-%s" % (int(time.time()), uuid.uuid4().hex[:8])
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


def get_companions(token, limit=None):
    q = ("?limit=%s" % limit) if limit else ""
    st, body = req("/org/companions" + q, token)
    assert st == 200, "companions failed: %s %s" % (st, body)
    return body


def main():
    # P1C-01 未选组织
    t0 = new_user("P1C未选组")
    b = get_companions(t0)
    record("P1C-01", "未选组织返回空概况",
           b.get("org") is None and b.get("memberCount") == 0 and b.get("companions") == [],
           json.dumps(b, ensure_ascii=False)[:120])

    # 本人（华北技术部 9）3000 步
    me = new_user("P1C本人", ORG_HB_TECH, 3000)
    before = get_companions(me)

    # P1C-02 本人入列
    mine = [c for c in before.get("companions", []) if c.get("isSelf")]
    record("P1C-02", "本人入列且 isSelf/今日步数正确",
           len(mine) == 1 and mine[0].get("nickname") == "P1C本人" and mine[0].get("todaySteps") == 3000,
           "mine=" + json.dumps(mine[:1], ensure_ascii=False))

    # 同伴 B（同组织 9）4000 步
    new_user("P1C同伴B", ORG_HB_TECH, 4000)
    after_b = get_companions(me)
    dc = after_b["memberCount"] - before["memberCount"]
    ds = after_b["todayTotalSteps"] - before["todayTotalSteps"]
    ordered = [c["nickname"] for c in after_b["companions"]]
    record("P1C-03", "同伴加入：人数+1/总量+4000/列表倒序",
           dc == 1 and ds == 4000 and ordered[0] == "P1C同伴B",
           "dc=%s ds=%s top=%s" % (dc, ds, ordered[:3]))

    # P1C-04 隐私边界
    allowed = {"nickname", "avatar", "todaySteps", "isSelf"}
    leak = [set(c.keys()) - allowed for c in after_b["companions"] if set(c.keys()) - allowed]
    record("P1C-04", "同行者条目无 id/openid 等敏感字段", not leak,
           "leak=%s" % (leak[:2] if leak else "[]"))

    # P1C-05 limit=1 截断，第一名为步数最高者
    top1 = get_companions(me, limit=1)
    record("P1C-05", "limit=1 截断且为第一名为最高步数",
           len(top1["companions"]) == 1 and top1["companions"][0]["nickname"] == "P1C同伴B"
           and top1["companions"][0]["todaySteps"] == 4000,
           json.dumps(top1["companions"], ensure_ascii=False)[:120])

    # P1C-06 子树口径：同伴 C 在兄弟组织 8；我在 9 时不计入，改选父组织 3 后计入
    new_user("P1C同伴C", ORG_HB_MARKET, 2000)
    b9 = get_companions(me, limit=50)
    names9 = [c["nickname"] for c in b9["companions"]]
    st, _ = req("/org/select", me, "POST", {"orgId": ORG_HUABEI})
    assert st == 200
    b3 = get_companions(me, limit=50)
    names3 = [c["nickname"] for c in b3["companions"]]
    record("P1C-06", "子树口径：选父组织后兄弟子组织成员计入",
           ("P1C同伴C" not in names9
            and "P1C同伴C" in names3
            and b3["memberCount"] - b9["memberCount"] >= 1
            and b3["todayTotalSteps"] - b9["todayTotalSteps"] >= 2000
            and b3["org"]["orgName"] == "华北分公司"),
           "dc=%s ds=%s org=%s" % (b3["memberCount"] - b9["memberCount"],
                                    b3["todayTotalSteps"] - b9["todayTotalSteps"],
                                    b3["org"]["orgName"]))

    # P1C-07 未鉴权 401
    st, _ = req("/org/companions")
    record("P1C-07", "未带 token 返回 401", st == 401, "status=%s" % st)

    failed = [r for r in results if not r[2]]
    print("\n== 共 %d 用例，失败 %d ==" % (len(results), len(failed)))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
