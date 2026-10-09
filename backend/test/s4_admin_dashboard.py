# -*- coding: utf-8 -*-
"""
S4 管理端接口 冒烟脚本（后端黑盒）
覆盖：admin/dashboard（指标+路线总览）、dashboard/trend、activities、screen 聚合、
      route-nodes 内容字段读写回环、questions category 读写与校验。
用法：cd backend && python test/s4_admin_dashboard.py（需后端已在 8010 运行）
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.security import create_admin_token  # noqa: E402

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


def admin_login():
    # 超管令牌直接铸造（与账号登录等价签发）；未配置 ADMIN_PASSWORD 时账号密码登录被禁用
    return create_admin_token("admin")


def main():
    token = admin_login()
    today = datetime.now().strftime("%Y-%m-%d")

    # ---------- dashboard ----------
    _, dash = http("/admin/dashboard", token)
    m = dash["metrics"]
    record("D1", "dashboard 指标字段齐全且非负",
           all(k in m for k in ("total_users", "today_users", "total_steps", "avg_steps",
                                "completion_rate", "quiz_users", "medals_granted"))
           and m["total_users"] >= 1 and m["today_users"] >= 1 and m["total_steps"] > 0
           and 0 <= m["completion_rate"] <= 100,
           f"metrics={json.dumps(m)}")
    ro = dash["route_overview"]
    record("D2", "路线总览：每节点达成人数与完成率",
           len(ro) == 10 and all(
               {"node_id", "name", "target_steps", "lit_count", "completion_rate"} <= set(x)
               for x in ro)
           and ro[0]["lit_count"] >= ro[-1]["lit_count"],
           f"first={json.dumps(ro[0], ensure_ascii=False)} last={json.dumps(ro[-1], ensure_ascii=False)}")

    # ---------- trend ----------
    _, t7 = http("/admin/dashboard/trend?days=7", token)
    today_pt = next((p for p in t7["points"] if p["date"] == today), None)
    record("T1", "trend 7 日：今日点含步数/参与/新增用户/新增点亮",
           t7["days"] == 7 and len(t7["points"]) == 7 and today_pt is not None
           and today_pt["total_steps"] > 0 and today_pt["active_users"] >= 1
           and today_pt["new_users"] >= 1 and today_pt["new_lit"] >= 1,
           f"today={json.dumps(today_pt)}")
    _, t30 = http("/admin/dashboard/trend?days=30", token)
    record("T2", "trend 30 日返回 30 个点", len(t30["points"]) == 30, f"points={len(t30['points'])}")

    # ---------- activities ----------
    _, acts = http("/admin/activities?limit=10", token)
    first = acts["items"][0] if acts["items"] else {}
    record("A1", "实时动态含昵称与文案",
           len(acts["items"]) >= 1 and bool(first.get("nickname"))
           and bool(first.get("text")) and "event_type" in first and "event_time" in first,
           f"first={json.dumps(first, ensure_ascii=False)[:180]}")

    # ---------- screen ----------
    _, sc = http("/admin/screen", token)
    record("S1", "screen 单接口聚合四段",
           all(k in sc for k in ("metrics", "route_overview", "trend", "activities"))
           and len(sc["trend"]) == 7 and len(sc["route_overview"]) == 10
           and 1 <= len(sc["activities"]) <= 20,
           f"trend={len(sc['trend'])} overview={len(sc['route_overview'])} acts={len(sc['activities'])}")

    # ---------- route-nodes 内容字段（读写回环，不留残留） ----------
    _, nodes = http("/admin/route-nodes", token)
    item = nodes["items"][0]
    record("N1", "route-nodes 列表含内容字段",
           all(k in item for k in ("brief", "significance", "figures", "location",
                                   "images", "audio", "keywords")),
           f"keys={sorted(item.keys())}")

    payload = {k: item[k] for k in ("name", "icon", "target_steps", "historical_time",
                                    "description", "latitude", "longitude", "sort_order",
                                    "is_enabled", "brief", "significance", "figures",
                                    "location", "images", "audio", "keywords")}
    marked = dict(payload, keywords="S4MARK", images=["https://example.com/a.jpg"])
    status, updated = http(f"/admin/route-nodes/{item['id']}", token, "PUT", marked)
    record("N2", "route-nodes PUT 写入内容字段并读回",
           status == 200 and updated.get("keywords") == "S4MARK"
           and updated.get("images") == ["https://example.com/a.jpg"],
           f"keywords={updated.get('keywords')} images={updated.get('images')}")
    status, restored = http(f"/admin/route-nodes/{item['id']}", token, "PUT", payload)
    record("N3", "route-nodes 还原后关键词恢复",
           status == 200 and restored.get("keywords") == payload["keywords"],
           f"keywords={restored.get('keywords')}")

    # ---------- questions category（新建后删除，不留残留） ----------
    _, qs = http("/admin/questions", token)
    record("Q1", "questions 列表含 category（种子已补全）",
           len(qs["items"]) >= 15 and all("category" in q for q in qs["items"])
           and any(q["category"] for q in qs["items"]),
           f"total={qs['total']} sample={qs['items'][0].get('category')}")

    new_q = {
        "type": "single", "question": "S4 冒烟临时题：长征出发地？",
        "options": [{"label": "A", "text": "瑞金"}, {"label": "B", "text": "遵义"}],
        "answer": ["A"], "analysis": "临时", "score": 20, "category": "event",
    }
    status, created = http("/admin/questions", token, "POST", new_q)
    record("Q2", "questions POST 含 category 并读回",
           status == 200 and created.get("category") == "event" and created.get("id"),
           f"id={created.get('id')} category={created.get('category')}")
    status, _ = http(f"/admin/questions/{created['id']}", token, "DELETE")
    record("Q3", "临时题删除成功", status == 200, f"status={status}")

    bad_q = dict(new_q, category="bad-cat")
    status, _ = http("/admin/questions", token, "POST", bad_q)
    record("Q4", "非法 category 返回 400", status == 400, f"status={status}")

    failed = [r for r in RESULTS if not r["ok"]]
    print(f"\n== S4 冒烟：{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过 ==")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
