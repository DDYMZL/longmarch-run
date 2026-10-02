# -*- coding: utf-8 -*-
"""
S5 组织人数统计 冒烟脚本（TestClient，不依赖 8010 端口残留进程）
覆盖：
  O1 admin/orgs 返回 200
  O2 每个节点含 direct_user_count / total_user_count
  O3 全树不变量：total == direct + Σ(下级 total)
  O4 新用户（mock openid）登录并选定组织成功
  O5 目标组织 direct +1
  O6 父组织 total +1（含下级累计沿祖先链生效）
  O7 Σ direct == 库内已选组织用户数
脚本幂等：运行前清理 code=s5-org-count-smoke 派生的 mock 用户。
用法：cd backend && python test/s5_org_user_counts.py
"""
import hashlib
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

from app.core.database import SessionLocal
from app.main import app
from app.models.models import (
    DailySport,
    LitNode,
    PointsLog,
    QuizRecord,
    User,
    UserEvent,
    UserMedal,
)

RESULTS = []
SMOKE_CODE = "s5-org-count-smoke"
SMOKE_OPENID = "mock_" + hashlib.md5(SMOKE_CODE.encode("utf-8")).hexdigest()[:24]


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def walk(nodes):
    for n in nodes:
        yield n
        yield from walk(n.get("children") or [])


def cleanup_smoke_user():
    # 冒烟用户在历次运行中会产生积分/运动等业务行，需先清子表再删用户（FK 约束）
    db = SessionLocal()
    try:
        user_ids = [
            row[0]
            for row in db.query(User.id).filter(User.openid == SMOKE_OPENID).all()
        ]
        if user_ids:
            for model in (PointsLog, DailySport, LitNode, UserMedal, QuizRecord, UserEvent):
                db.query(model).filter(model.user_id.in_(user_ids)).delete(
                    synchronize_session=False
                )
            db.query(User).filter(User.id.in_(user_ids)).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def main():
    cleanup_smoke_user()
    with TestClient(app) as client:
        r = client.post("/api/admin/login", json={"username": "admin", "password": "112233"})
        assert r.status_code == 200, r.text
        admin_headers = {"Authorization": "Bearer " + r.json()["token"]}

        r = client.get("/api/admin/orgs", headers=admin_headers)
        record("O1", "admin/orgs 返回 200", r.status_code == 200, str(r.status_code))
        nodes = list(walk(r.json()["nodes"]))
        record("O2", "每个节点含 direct_user_count/total_user_count",
               bool(nodes) and all("direct_user_count" in n and "total_user_count" in n for n in nodes),
               f"节点数={len(nodes)}")

        def check(node):
            child_ok = [check(c) for c in node["children"]]
            ok = node["total_user_count"] == node["direct_user_count"] + sum(t for _, t in child_ok)
            return ok and all(o for o, _ in child_ok), node["total_user_count"]

        bad = [n["id"] for n in nodes if not check(n)[0]]
        record("O3", "total == direct + Σ(下级 total) 全树成立", not bad, f"异常节点={bad}")

        by_id = {n["id"]: n for n in nodes}
        leaf = next((n for n in nodes if not n["children"] and n["parent_id"] in by_id), nodes[-1])
        before_direct = leaf["direct_user_count"]
        parent_before = by_id[leaf["parent_id"]]["total_user_count"] if leaf["parent_id"] in by_id else None

        r = client.post("/api/auth/login", json={"code": SMOKE_CODE, "nickname": "S5冒烟"})
        assert r.status_code == 200, r.text
        user_headers = {"Authorization": "Bearer " + r.json()["token"]}
        r = client.post("/api/org/select", json={"orgId": leaf["id"]}, headers=user_headers)
        record("O4", "新用户登录并选定组织成功", r.status_code == 200,
               f"org={leaf['name']} status={r.status_code}")

        r = client.get("/api/admin/orgs", headers=admin_headers)
        by_id2 = {n["id"]: n for n in walk(r.json()["nodes"])}
        leaf2 = by_id2[leaf["id"]]
        record("O5", "目标组织 direct +1", leaf2["direct_user_count"] == before_direct + 1,
               f"{before_direct} -> {leaf2['direct_user_count']}")
        if parent_before is not None:
            record("O6", "父组织 total +1（含下级累计）",
                   by_id2[leaf["parent_id"]]["total_user_count"] == parent_before + 1,
                   f"{parent_before} -> {by_id2[leaf['parent_id']]['total_user_count']}")

        db = SessionLocal()
        try:
            expected = db.query(User).filter(User.org_id.isnot(None)).count()
        finally:
            db.close()
        total_direct = sum(n["direct_user_count"] for n in by_id2.values())
        record("O7", "Σ direct == 库内已选组织用户数", total_direct == expected,
               f"Σdirect={total_direct} db={expected}")

    failed = [x for x in RESULTS if not x["ok"]]
    print(f"\n== S5 结果：{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过 ==")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
