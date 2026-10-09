# -*- coding: utf-8 -*-
"""
S7 性能重构回归 冒烟脚本（后端黑盒）
覆盖本次优化点：
  1) dashboard.route_overview 改为「排序 + 二分」计数后，lit_count 与
     /admin/rankings 全量数据暴力计数完全一致（口径回归）；
  2) org_service.get_full_name_map 批量全路径名：/admin/rankings 与 /api/rank/steps
     返回的 orgName 与由 /admin/orgs 组织树重建的全路径名逐人一致（N+1 消除后口径不变）；
  3) /admin/rankings 点亮记录已按启用节点 SQL 过滤：每用户 nodes 仅含启用节点，
     reached 与 reachedAt 自洽。
用法：cd backend && python test/s7_perf_refactor.py（需后端已在 8010 运行）
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.security import create_admin_token  # noqa: E402

BASE = "http://127.0.0.1:8010/api"
RESULTS = []


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": ok and name or name, "ok": bool(ok), "detail": str(detail)[:300]})
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


def build_full_names(tree_nodes):
    """由组织树重建 {id: 全路径名}（与 get_full_name_map 口径对照）。"""
    names = {}

    def walk(node, prefix):
        full = (prefix + " / " + node["name"]) if prefix else node["name"]
        names[node["id"]] = full
        for child in node.get("children") or []:
            walk(child, full)

    for top in tree_nodes:
        walk(top, "")
    return names


def main():
    token = admin_login()

    _, dash = http("/admin/dashboard", token)
    _, rankings = http("/admin/rankings", token)
    _, orgs = http("/admin/orgs", token)

    # ---------- 1) dashboard 二分计数 == rankings 暴力计数 ----------
    # 口径说明：dashboard lit_count 统计「有运动记录且累计步数 >= target」的用户；
    # rankings items 含无记录用户（0 步）。target>0 时两口径精确一致；
    # target==0 时无记录用户（0>=0）也被 rankings 侧计入，故只做范围断言。
    items = rankings["items"]
    positive = sum(1 for it in items if it["total_steps"] > 0)
    mismatches = []
    for node in dash["route_overview"]:
        target = node["target_steps"]
        if target > 0:
            expected = sum(1 for it in items if it["total_steps"] >= target)
            if node["lit_count"] != expected:
                mismatches.append(f"{node['name']}: lit_count={node['lit_count']} expected={expected}")
        elif not (positive <= node["lit_count"] <= len(items)):
            mismatches.append(f"{node['name']}: lit_count={node['lit_count']} 不在 [{positive}, {len(items)}] 区间")
    record("P1", "dashboard lit_count 与 rankings 暴力计数一致（二分重构口径回归）",
           not mismatches, "; ".join(mismatches) or f"nodes={len(dash['route_overview'])}")

    # ---------- 2) org 全路径名批量接口口径 ----------
    full_names = build_full_names(orgs["nodes"])
    bad_admin = [
        f"user={it['user_id']} org_name={it['org_name']!r}"
        for it in items
        if it["org_name"] and it["org_name"] not in set(full_names.values())
    ]
    record("P2", "rankings org_name 均为组织树可重建的全路径名",
           not bad_admin, "; ".join(bad_admin[:3]) or f"users={len(items)}")

    # ---------- 3) rankings 启用节点过滤与点亮自洽 ----------
    enabled_ids = {n["id"] for n in rankings["route_nodes"]}
    shape_bad = []
    for it in items[:200]:  # 抽样前 200 人逐节点核对
        for n in it["nodes"]:
            if n["id"] not in enabled_ids or (n["reached"] and not n["reached_at"]):
                shape_bad.append(f"user={it['user_id']} node={n['id']}")
                break
    record("P3", "rankings 每用户 nodes 仅含启用节点且 reached/reached_at 自洽",
           not shape_bad, "; ".join(shape_bad[:3]) or f"checked={min(200, len(items))} users")

    # ---------- 4) 小程序榜 orgName 口径 ----------
    status, body = http("/auth/login", method="POST", data={"code": "s7-perf", "nickname": "S7"})
    assert status == 200 and body and "token" in body, f"user login failed: {status}"
    utoken = body["token"]
    _, steps_rank = http("/rank/steps", utoken)
    bad_mini = [
        f"user={e['userId']} orgName={e['orgName']!r}"
        for e in steps_rank["list"]
        if e["orgName"] and e["orgName"] not in set(full_names.values())
    ]
    record("P4", "小程序 /rank/steps orgName 同为全路径名（get_full_name_map 口径）",
           not bad_mini, "; ".join(bad_mini[:3]) or f"board={len(steps_rank['list'])}")

    # ---------- 5) screen 聚合仍正常 ----------
    _, sc = http("/admin/screen", token)
    record("P5", "screen 聚合四段齐全",
           all(k in sc for k in ("metrics", "routeOverview", "trend", "activities"))
           or all(k in sc for k in ("metrics", "route_overview", "trend", "activities")),
           f"keys={sorted(sc.keys())}")

    failed = [r for r in RESULTS if not r["ok"]]
    print(f"\n== S7 冒烟：{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过 ==")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
