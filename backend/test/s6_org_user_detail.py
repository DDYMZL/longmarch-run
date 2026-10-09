# -*- coding: utf-8 -*-
"""
S6 组织人员明细 冒烟脚本（TestClient，不依赖 8010 端口残留进程）
覆盖：
  A1 admin/orgs/{id}/users 需管理员鉴权（无 token 401）
  A2 scope=direct：total 与组织树 direct_user_count 一致，且逐条 user 的 org_id 均为该组织
  A3 scope=all：total 与组织树 total_user_count 一致，且逐条 user 的 org_id 均落在子树内
  A4 分页：page_size=2 逐页拉取，条数/总数/去重不重不漏
  A5 空组织：total=0、items=[]（找一个无用户组织；若不存在则用冒烟用户所选叶子验证「direct=1 后离开」）
  A6 组织不存在返回 404
  A7 scope 非法值返回 422
用法：cd backend && python test/s6_org_user_detail.py
"""
import hashlib
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

from app.core.database import SessionLocal
from app.core.security import create_admin_token
from app.main import app
from app.models.models import (
    DailySport,
    LitNode,
    Organization,
    PointsLog,
    QuizRecord,
    User,
    UserEvent,
    UserMedal,
)

RESULTS = []
SMOKE_CODE = "s6-org-user-detail-smoke"
SMOKE_OPENID = "mock_" + hashlib.md5(SMOKE_CODE.encode("utf-8")).hexdigest()[:24]


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def walk(nodes):
    for n in nodes:
        yield n
        yield from walk(n.get("children") or [])


def subtree_ids(db, org_id):
    rows = db.query(Organization.id, Organization.parent_id).all()
    children = {}
    for oid, pid in rows:
        children.setdefault(pid, []).append(oid)
    result = []
    queue = [org_id]
    while queue:
        current = queue.pop(0)
        result.append(current)
        queue.extend(children.get(current, []))
    return result


def cleanup_smoke_user():
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
        # 超管令牌直接铸造（与账号登录等价签发；ADMIN_PASSWORD 未配置时账号登录禁用）
        admin_headers = {"Authorization": "Bearer " + create_admin_token("admin")}

        # A1 鉴权
        r = client.get("/api/admin/orgs/1/users")
        record("A1", "无 token 访问人员明细返回 401", r.status_code == 401, str(r.status_code))

        r = client.get("/api/admin/orgs", headers=admin_headers)
        assert r.status_code == 200, r.text
        nodes = list(walk(r.json()["nodes"]))
        by_id = {n["id"]: n for n in nodes}
        # 选一个含下级且人数>0 的组织验证 all；直属验证优先选 direct>0 且有下级的组织
        multi = next((n for n in nodes if n["children"] and n["total_user_count"] > 0), None)
        direct_target = next(
            (n for n in nodes if n["direct_user_count"] > 0 and n["children"]), None
        ) or next((n for n in nodes if n["direct_user_count"] > 0), None) or next(
            (n for n in nodes if not n["children"]), nodes[-1]
        )
        record("A0", "存在含下级组织与直属验证目标组织", multi is not None and direct_target is not None,
               f"multi={multi and multi['name']} direct={direct_target['name']}")

        db = SessionLocal()
        try:
            # A2 direct 口径：total 与树一致 + 条目恰为 org_id==该组织的用户（不混入下级成员）
            org_id = direct_target["id"]
            r = client.get(f"/api/admin/orgs/{org_id}/users", params={"scope": "direct", "page": 1, "page_size": 100}, headers=admin_headers)
            ok_status = r.status_code == 200
            body = r.json() if ok_status else {}
            ok_total = body.get("total") == by_id[org_id]["direct_user_count"]
            db_ids = set(
                row[0] for row in db.query(User.id).filter(User.org_id == org_id).all()
            )
            api_ids = {i["user_id"] for i in body.get("items", [])}
            ok_items = api_ids == db_ids
            record("A2", "scope=direct total/条目与 direct_user_count 口径一致（不含下级成员）",
                   ok_status and ok_total and ok_items,
                   f"tree={by_id[org_id]['direct_user_count']} api={body.get('total')} 条目={len(api_ids)}")

            # A3 all 口径：total 与树一致 + 每条 org_id 落在子树内
            if multi is not None:
                org_id = multi["id"]
                r = client.get(f"/api/admin/orgs/{org_id}/users", params={"scope": "all", "page": 1, "page_size": 100}, headers=admin_headers)
                ok_status = r.status_code == 200
                body = r.json() if ok_status else {}
                ok_total = body.get("total") == by_id[org_id]["total_user_count"]
                sub_ids = set(subtree_ids(db, org_id))
                api_users = {i["user_id"] for i in body.get("items", [])}
                db_all_ids = set(
                    row[0] for row in db.query(User.id).filter(User.org_id.in_(sub_ids)).all()
                )
                api_org_ids = {
                    row[0]: row[1]
                    for row in db.query(User.id, User.org_id).filter(User.id.in_(api_users)).all()
                }
                ok_items = api_users == db_all_ids
                ok_scope = all(org in sub_ids for org in api_org_ids.values())
                record("A3", "scope=all total/条目与 total_user_count 口径一致（子树不重不漏）",
                       ok_status and ok_total and ok_items and ok_scope,
                       f"tree={by_id[org_id]['total_user_count']} api={body.get('total')} 条目={len(api_users)}")

                # A4 分页不重不漏（在 multi 组织上以 page_size=2 逐页拉全量）
                collected = []
                page = 1
                while True:
                    r = client.get(f"/api/admin/orgs/{org_id}/users", params={"scope": "all", "page": page, "page_size": 2}, headers=admin_headers)
                    page_body = r.json()
                    collected.extend(page_body["items"])
                    if len(collected) >= page_body["total"] or not page_body["items"]:
                        break
                    page += 1
                ids = [i["user_id"] for i in collected]
                ok_pages = len(ids) == len(set(ids)) == body.get("total")
                record("A4", "分页逐页拉取不重不漏", ok_pages, f"拉取={len(ids)} 去重={len(set(ids))} total={body.get('total')}")

            # A5 空组织：找一个 direct=0 且 total=0 的组织
            empty = next((n for n in nodes if n["direct_user_count"] == 0 and n["total_user_count"] == 0), None)
            if empty is not None:
                r = client.get(f"/api/admin/orgs/{empty['id']}/users", params={"scope": "all", "page": 1, "page_size": 20}, headers=admin_headers)
                ok_empty = r.status_code == 200 and r.json()["total"] == 0 and r.json()["items"] == []
                record("A5", "无成员组织返回 total=0 且 items 为空", ok_empty,
                       f"{empty['name']} total={r.json().get('total')} items={len(r.json().get('items', []))}")
            else:
                record("A5", "无成员组织返回 total=0 且 items 为空", False, "未找到空组织")

            # A6 组织不存在 404
            r = client.get("/api/admin/orgs/999999/users", headers=admin_headers)
            record("A6", "组织不存在返回 404", r.status_code == 404, str(r.status_code))

            # A7 非法 scope 422
            r = client.get(f"/api/admin/orgs/{direct_target['id']}/users", params={"scope": "bad"}, headers=admin_headers)
            record("A7", "非法 scope 返回 422", r.status_code == 422, str(r.status_code))
        finally:
            db.close()

    failed = [x for x in RESULTS if not x["ok"]]
    print(f"\n== S6 结果：{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过 ==")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
