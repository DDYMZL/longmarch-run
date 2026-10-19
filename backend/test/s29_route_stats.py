# -*- coding: utf-8 -*-
"""S29 全员路线抵达统计 /march/route-stats 冒烟（SQLite + TestClient）。

背景：星空长征 HUD 数据叠加层需要「各节点全员抵达人数/完成率」，该口径原先只存在于
管理端 dashboard_service.get_dashboard 内部。本次抽为 march_service.compute_route_stats
供两端共用，并对小程序侧加 60s 进程内 TTL 缓存（全量步数聚合成本高、march 为 tab 页）。

覆盖：
  R01 未带 token 访问 /march/route-stats 返回 401
  R02 响应为 camelCase 契约（totalUsers / nodes[].nodeId|litCount|completionRate）
  R03 抵达人数按累计步数二分计数正确，完成率 = round(lit/totalUsers*100)
  R04 仅含启用节点，且按 sort_order 升序
  R05 与 admin/dashboard 的 route_overview 逐项一致；metrics 汇总口径不变
  R06 TTL 缓存命中：连续三次请求只触发一次全量聚合
  R07 invalidate_route_stats_cache() 后重新聚合，数值随数据更新
  R08 管理端 dashboard 不走缓存（实时口径未被破坏），march 侧仍返回缓存值
  R09 管理端 PUT route-nodes 自动失效小程序侧统计缓存

用法：cd backend && python test/s29_route_stats.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_smoke_s29.db")
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)
os.environ["DATABASE_URL"] = "sqlite:///" + DB_PATH.replace("\\", "/")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

from app.core.database import Base, SessionLocal, engine
from app.core.helpers import now_utc, recent_dates
from app.core.security import create_access_token, create_admin_token
from app.main import app
from app.models.models import DailySport, RouteNode, User
from app.services import march_service

RESULTS = []

# 4 个用户有步数记录（跨两日写入，验证聚合为 sum），第 5 个用户无记录（累计 0）
STEP_PLAN = [500, 1500, 6000, 25000]
TOTAL_USERS = 5
TOTAL_STEPS = sum(STEP_PLAN)  # 33000
# 3 个启用节点（目标步数严格递增）+ 1 个停用节点（sort_order 更大，验证被过滤）
NODE_PLAN = [("甲站", 1000, 1, True), ("乙站", 5000, 2, True),
             ("丙站", 20000, 3, True), ("停用站", 30000, 4, False)]
LAST_NODE_NAME = "丙站"
# 期望抵达人数：≥1000 有 3 人、≥5000 有 2 人、≥20000 有 1 人
EXPECT_LIT = [3, 2, 1]
EXPECT_RATE = [60, 40, 20]


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:400]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name
          + ((" | " + str(detail)[:240]) if detail else ""))


def H(account):
    """account 为 {id, openid} 纯字典（session 关闭后 ORM 实例已 detached，不可回传对象）。"""
    return {"Authorization": "Bearer " + create_access_token(account["id"], account["openid"])}


def lit_of(body):
    return [n["litCount"] for n in body["nodes"]]


def seed():
    """建 5 个用户（前 4 个有跨两步数记录）+ 4 个节点（3 启用 1 停用）。"""
    db = SessionLocal()
    try:
        users = []
        for i in range(TOTAL_USERS):
            u = User(openid="s29-u%d" % i, nickname="S29战士%d" % i,
                     status="active", created_at=now_utc())
            db.add(u)
            db.flush()
            users.append({"id": u.id, "openid": u.openid})
        for (name, target, order, enabled) in NODE_PLAN:
            db.add(RouteNode(name=name, target_steps=target, sort_order=order,
                             is_enabled=enabled, icon="🚩", historical_time="1934年",
                             description="S29 冒烟节点", latitude=27.0 + order,
                             longitude=106.0 + order))
        # seed 占用「昨天/今天」两个日期，后续追加步数一律用更早的独立日期避免唯一约束冲突
        d0, d1 = recent_dates(2)
        for steps, u in zip(STEP_PLAN, users):
            half = steps // 2
            db.add(DailySport(user_id=u["id"], date=d0, steps=half, source="mock"))
            db.add(DailySport(user_id=u["id"], date=d1, steps=steps - half, source="mock"))
        db.commit()
        return users
    finally:
        db.close()


def add_steps(uid, steps):
    """给指定用户追加一条独立日期的步数记录（不与 seed 的日期冲突）。"""
    db = SessionLocal()
    try:
        db.add(DailySport(user_id=uid, date=recent_dates(6)[0], steps=steps, source="mock"))
        db.commit()
    finally:
        db.close()


def main():
    Base.metadata.create_all(engine)
    users = seed()
    u0, u4 = users[0], users[4]
    client = TestClient(app)
    admin_h = {"Authorization": "Bearer " + create_admin_token("s29-smoke")}
    original = march_service._sorted_user_total_steps

    try:
        # ---------- R01 鉴权 ----------
        no_auth = client.get("/api/march/route-stats")
        record("R01", "未带 token 返回 401", no_auth.status_code == 401,
               "status=%s" % no_auth.status_code)

        # ---------- R02 camelCase 契约 ----------
        march_service.invalidate_route_stats_cache()
        resp = client.get("/api/march/route-stats", headers=H(u0))
        body = resp.json()
        item = (body.get("nodes") or [{}])[0]
        record("R02", "响应为 camelCase 且无 snake_case 泄漏",
               resp.status_code == 200 and set(body) == {"totalUsers", "nodes"}
               and set(item) == {"nodeId", "litCount", "completionRate"},
               "body_keys=%s item_keys=%s" % (sorted(body), sorted(item)))

        # ---------- R03 二分计数与完成率 ----------
        record("R03", "抵达人数二分计数与完成率正确",
               body["totalUsers"] == TOTAL_USERS and lit_of(body) == EXPECT_LIT
               and [n["completionRate"] for n in body["nodes"]] == EXPECT_RATE,
               "lit=%s rate=%s totalUsers=%s"
               % (lit_of(body), [n["completionRate"] for n in body["nodes"]],
                  body["totalUsers"]))

        # ---------- R04 仅启用节点 + 排序 ----------
        names = [n["name"] for n in client.get("/api/admin/route-nodes",
                                               headers=admin_h).json()["items"]]
        record("R04", "仅含 3 个启用节点且抵达人数按 sort_order 递减",
               len(body["nodes"]) == 3 and lit_of(body) == sorted(lit_of(body), reverse=True)
               and "停用站" in names and len(names) == 4,
               "nodes=%d lit=%s admin_nodes=%s" % (len(body["nodes"]), lit_of(body), names))

        # ---------- R05 与 admin dashboard 口径一致 ----------
        dash = client.get("/api/admin/dashboard", headers=admin_h).json()
        overview, m = dash["route_overview"], dash["metrics"]
        same = len(overview) == len(body["nodes"]) and all(
            o["node_id"] == n["nodeId"] and o["lit_count"] == n["litCount"]
            and o["completion_rate"] == n["completionRate"]
            for o, n in zip(overview, body["nodes"])
        )
        record("R05", "与 admin/dashboard route_overview 逐项一致，metrics 口径不变",
               same and m["total_users"] == TOTAL_USERS and m["total_steps"] == TOTAL_STEPS
               and m["avg_steps"] == round(TOTAL_STEPS / TOTAL_USERS)
               and m["completion_rate"] == 20,
               "metrics=%s overview_last=%s" % (json.dumps(m), overview[-1]))

        # ---------- R06 TTL 缓存命中 ----------
        calls = {"n": 0}

        def counted(db):
            calls["n"] += 1
            return original(db)

        march_service._sorted_user_total_steps = counted
        march_service.invalidate_route_stats_cache()
        for _ in range(3):
            client.get("/api/march/route-stats", headers=H(u0))
        record("R06", "TTL 缓存命中：3 次请求只聚合 1 次", calls["n"] == 1,
               "aggregations=%d" % calls["n"])

        # ---------- R07 失效后重算 ----------
        add_steps(u0["id"], 20000)  # u0 累计 500 → 20500，跨过 20000 节点
        stale = client.get("/api/march/route-stats", headers=H(u0)).json()
        march_service.invalidate_route_stats_cache()
        fresh = client.get("/api/march/route-stats", headers=H(u0)).json()
        record("R07", "invalidate 后重新聚合，数值随数据更新",
               lit_of(stale) == EXPECT_LIT and lit_of(fresh) == [4, 3, 2] and calls["n"] == 2,
               "stale=%s fresh=%s aggregations=%d" % (lit_of(stale), lit_of(fresh), calls["n"]))

        # ---------- R08 admin 实时 vs march 缓存 ----------
        march_service._sorted_user_total_steps = original
        march_service.invalidate_route_stats_cache()
        cached_once = lit_of(client.get("/api/march/route-stats", headers=H(u0)).json())
        add_steps(u4["id"], 30000)  # 原本无记录的 u4 累计 30000，三节点全抵达
        dash2 = client.get("/api/admin/dashboard", headers=admin_h).json()
        cached_again = client.get("/api/march/route-stats", headers=H(u0)).json()
        record("R08", "admin dashboard 立即反映新数据，march 侧仍返回缓存值",
               cached_once == [4, 3, 2]
               and [o["lit_count"] for o in dash2["route_overview"]] == [5, 4, 3]
               and dash2["metrics"]["total_steps"] == TOTAL_STEPS + 50000
               and lit_of(cached_again) == cached_once,
               "cached=%s admin=%s admin_total=%s march_again=%s"
               % (cached_once, [o["lit_count"] for o in dash2["route_overview"]],
                  dash2["metrics"]["total_steps"], lit_of(cached_again)))

        # ---------- R09 管理端改节点自动失效缓存 ----------
        items = client.get("/api/admin/route-nodes", headers=admin_h).json()["items"]
        target = next(i for i in items if i["name"] == LAST_NODE_NAME)
        payload = {k: target[k] for k in ("name", "icon", "target_steps", "historical_time",
                                          "description", "latitude", "longitude", "sort_order",
                                          "is_enabled", "brief", "significance", "figures",
                                          "location", "images", "audio", "keywords")}
        march_service.invalidate_route_stats_cache()
        before = lit_of(client.get("/api/march/route-stats", headers=H(u0)).json())
        payload["target_steps"] = 60000  # 末节点目标提到无人可达（仍满足严格递增）
        put = client.put("/api/admin/route-nodes/%d" % target["id"],
                         headers=admin_h, json=payload)
        after = lit_of(client.get("/api/march/route-stats", headers=H(u0)).json())
        record("R09", "管理端 PUT route-nodes 后小程序统计缓存自动失效",
               put.status_code == 200 and before == [5, 4, 3] and after == [5, 4, 0],
               "put=%s before=%s after=%s" % (put.status_code, before, after))
    finally:
        march_service._sorted_user_total_steps = original
        engine.dispose()
        if os.path.exists(DB_PATH):
            os.remove(DB_PATH)

    passed = sum(1 for r in RESULTS if r["ok"])
    print("\nS29 完成：%d/%d 通过" % (passed, len(RESULTS)))
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "s29-route-stats-results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"total": len(RESULTS), "passed": passed, "results": RESULTS},
                  f, ensure_ascii=False, indent=2)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
