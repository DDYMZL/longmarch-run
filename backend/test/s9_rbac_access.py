# -*- coding: utf-8 -*-
"""
S9 RBAC 与审计接口 冒烟脚本（TestClient，不依赖 8010 端口残留进程）

覆盖（批次3 范围）：
  A1 超管令牌全放行：users/roles/audit-logs/me（全部 9 个菜单）+ 业务接口
  A2 未授权用户令牌访问被拒：无角色 403；普通小程序令牌 401
  A3 require_menu 强制：operator 角色可用业务接口，users/roles/audit-logs 403
  A4 人员列表：关键词/组织/是否有后台权限筛选
  A5 角色 CRUD：创建/编辑/无效菜单 400/内置禁删/被引用禁删/删除成功
  A6 授权链路：access 角色可管理授权；授权变更写审计（super 与 user 操作人）
  A7 禁用即时生效：禁用角色后同令牌立即 403，重新启用恢复
  A8 错误分支：用户不存在 404、角色不存在 400、未授权角色 404
  A9 审计日志筛选：action/actor_type/date，昵称解析（超级管理员/用户昵称）
  A10 WS 鉴权改造：合法管理员可连、权限撤销 4403、非法令牌 4401

用法：cd backend && python test/s9_rbac_access.py
"""
import hashlib
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import datetime

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.core.database import SessionLocal
from app.core.security import create_admin_token, create_admin_token_for_user
from app.main import app
from app.models.models import (
    AdminRole,
    AdminRoleMenu,
    AdminUserRole,
    AuditLog,
    DailySport,
    LitNode,
    PointsLog,
    QuizRecord,
    User,
    UserEvent,
    UserMedal,
)

RESULTS = []
SMOKE_PREFIX = "s9-rbac-access"
ROLE_NAME_PREFIX = "s9-测试角色"
ACCESS_AUDIT_ACTIONS = (
    "access.role.create",
    "access.role.update",
    "access.role.delete",
    "access.roles.grant",
    "access.roles.revoke",
    "access.role.enable",
    "access.role.disable",
)


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def smoke_openid(tag):
    return "mock_" + hashlib.md5((SMOKE_PREFIX + "-" + tag).encode("utf-8")).hexdigest()[:24]


def cleanup():
    """清理冒烟用户、测试角色及其审计行，保证可重复执行。"""
    db = SessionLocal()
    try:
        smoke_openids = {smoke_openid(t) for t in ("u1", "u2", "u3")}
        user_ids = [
            row[0]
            for row in db.query(User.id, User.openid).all()
            if row[1] in smoke_openids
        ]
        if user_ids:
            db.query(AdminUserRole).filter(AdminUserRole.user_id.in_(user_ids)).delete(
                synchronize_session=False
            )
            db.query(AuditLog).filter(
                (AuditLog.actor_user_id.in_(user_ids))
                | (AuditLog.target_user_id.in_(user_ids))
            ).delete(synchronize_session=False)
            for model in (PointsLog, DailySport, LitNode, UserMedal, QuizRecord, UserEvent):
                db.query(model).filter(model.user_id.in_(user_ids)).delete(synchronize_session=False)
            db.query(User).filter(User.id.in_(user_ids)).delete(synchronize_session=False)
        role_ids = [
            row[0]
            for row in db.query(AdminRole.id, AdminRole.name).all()
            if row[1].startswith(ROLE_NAME_PREFIX)
        ]
        if role_ids:
            db.query(AdminUserRole).filter(AdminUserRole.role_id.in_(role_ids)).delete(
                synchronize_session=False
            )
            db.query(AdminRoleMenu).filter(AdminRoleMenu.role_id.in_(role_ids)).delete(
                synchronize_session=False
            )
            db.query(AdminRole).filter(AdminRole.id.in_(role_ids)).delete(
                synchronize_session=False
            )
        # 本脚本以超管身份写入的授权类审计（actor_user_id 为 NULL），按动作集清理
        db.query(AuditLog).filter(AuditLog.action.in_(ACCESS_AUDIT_ACTIONS)).delete(
            synchronize_session=False
        )
        db.commit()
    finally:
        db.close()


def login_user(client, tag):
    resp = client.post(
        "/api/auth/login",
        json={"code": SMOKE_PREFIX + "-" + tag, "nickname": "冒烟" + tag, "avatar": ""},
    )
    assert resp.status_code == 200, f"login failed: {resp.status_code} {resp.text}"
    return resp.json()["token"]


def user_id_of(tag):
    db = SessionLocal()
    try:
        return db.query(User.id).filter(User.openid == smoke_openid(tag)).scalar()
    finally:
        db.close()


def operator_role_id():
    db = SessionLocal()
    try:
        return db.query(AdminRole.id).filter(AdminRole.code == "operator").scalar()
    finally:
        db.close()


def super_headers():
    return {"Authorization": "Bearer " + create_admin_token("admin")}


def ws_connect(client, token):
    """建连成功返回 ok；服务端拒绝返回 closed:code。"""
    try:
        with client.websocket_connect("/api/ws/updates?token=" + token):
            pass
        return "ok"
    except WebSocketDisconnect as exc:
        return "closed:" + str(exc.code)
    except Exception as exc:  # noqa: BLE001
        return "error:" + type(exc).__name__


def ws_close_code(client, token):
    """期望服务端握手后立即关闭的场景：receive 时拿到关闭码。"""
    try:
        with client.websocket_connect("/api/ws/updates?token=" + token) as ws:
            ws.receive_text()
        return None
    except WebSocketDisconnect as exc:
        return exc.code


def main():
    client = TestClient(app)
    cleanup()

    super_h = super_headers()
    token_u1 = login_user(client, "u1")
    token_u2 = login_user(client, "u2")
    token_u3 = login_user(client, "u3")
    uid1, uid2, uid3 = user_id_of("u1"), user_id_of("u2"), user_id_of("u3")

    # ---- A1 超管全放行 ----
    ok = True
    for path in ("/api/admin/users", "/api/admin/roles", "/api/admin/audit-logs"):
        resp = client.get(path, headers=super_h)
        ok = ok and resp.status_code == 200
    me = client.get("/api/admin/me", headers=super_h).json()
    ok = ok and me["is_super"] is True and len(me["menus"]) == 9
    dash = client.get("/api/admin/dashboard", headers=super_h)
    record("A1", "超管全放行（users/roles/audit-logs/me 九菜单/业务接口）", ok and dash.status_code == 200, f"menus={len(me.get('menus') or [])}")

    # ---- A2 未授权用户令牌被拒 ----
    u1_admin_token = create_admin_token_for_user(uid1)
    h1 = {"Authorization": "Bearer " + u1_admin_token}
    resp = client.get("/api/admin/dashboard", headers=h1)
    record("A2a", "无角色用户令牌 403（授权校验即时生效）", resp.status_code == 403 and "撤销或禁用" in resp.json()["detail"], resp.text)
    resp = client.get("/api/admin/users", headers={"Authorization": "Bearer " + token_u1})
    record("A2b", "普通小程序令牌访问后台接口 401", resp.status_code == 401, resp.text)

    # ---- A3 授权 operator 后 require_menu 强制 ----
    resp = client.post(f"/api/admin/users/{uid2}/roles", json={"role_ids": [operator_role_id()]}, headers=super_h)
    record("A3a", "超管授权 operator 成功", resp.status_code == 200, resp.text)
    u2_admin_token = create_admin_token_for_user(uid2)
    h2 = {"Authorization": "Bearer " + u2_admin_token}
    me2 = client.get("/api/admin/me", headers=h2).json()
    codes = [m["code"] for m in me2["menus"]]
    ok = me2["is_super"] is False and "questions" in codes and "access" not in codes and "audit" not in codes
    record("A3b", "operator 菜单集（含业务、不含 access/audit）", ok, codes)
    ok = client.get("/api/admin/dashboard", headers=h2).status_code == 200
    ok = ok and client.get("/api/admin/users", headers=h2).status_code == 403
    ok = ok and client.get("/api/admin/roles", headers=h2).status_code == 403
    ok = ok and client.get("/api/admin/audit-logs", headers=h2).status_code == 403
    record("A3c", "require_menu 强制（业务放行，access/audit 403）", ok, "")

    # ---- A4 人员列表筛选 ----
    resp = client.get("/api/admin/users", params={"keyword": "冒烟u2"}, headers=super_h)
    data = resp.json()
    item = next((u for u in data["items"] if u["id"] == uid2), None)
    ok = resp.status_code == 200 and data["total"] == 1 and item and item["has_access"] and any(r["code"] == "operator" for r in item["roles"])
    record("A4a", "关键词筛选 + has_access + 角色明细", ok, data)
    resp = client.get("/api/admin/users", params={"has_access": "true"}, headers=super_h)
    ids = [u["id"] for u in resp.json()["items"]]
    resp2 = client.get("/api/admin/users", params={"has_access": "false"}, headers=super_h)
    ids2 = [u["id"] for u in resp2.json()["items"]]
    record("A4b", "has_access 筛选互斥", uid2 in ids and uid2 not in ids2 and uid1 in ids2, f"true:{len(ids)} false:{len(ids2)}")

    # ---- A5 角色 CRUD ----
    resp = client.post("/api/admin/roles", json={"name": ROLE_NAME_PREFIX + "A", "menus": ["screen", "audit"]}, headers=super_h)
    role = resp.json()
    ok = resp.status_code == 200 and role["code"].startswith("r") and role["user_count"] == 0 and role["menus"] == ["screen", "audit"]
    record("A5a", "新建角色（code 自动生成/菜单/人数）", ok, role)
    role_id = role["id"]
    resp = client.post("/api/admin/roles", json={"name": ROLE_NAME_PREFIX + "B", "menus": ["bad-menu"]}, headers=super_h)
    record("A5b", "无效菜单 400", resp.status_code == 400 and "无效菜单" in resp.json()["detail"], resp.text)
    resp = client.put(f"/api/admin/roles/{role_id}", json={"name": ROLE_NAME_PREFIX + "A改", "menus": ["screen"]}, headers=super_h)
    ok = resp.status_code == 200 and resp.json()["name"].endswith("A改") and resp.json()["menus"] == ["screen"]
    record("A5c", "编辑角色全量覆盖菜单", ok, resp.text)
    op_id = operator_role_id()
    resp = client.delete(f"/api/admin/roles/{op_id}", headers=super_h)
    record("A5d", "内置角色禁删 400", resp.status_code == 400 and "内置" in resp.json()["detail"], resp.text)
    client.post(f"/api/admin/users/{uid2}/roles", json={"role_ids": [role_id]}, headers=super_h)
    resp = client.delete(f"/api/admin/roles/{role_id}", headers=super_h)
    record("A5e", "被引用角色禁删 400", resp.status_code == 400 and "已授权" in resp.json()["detail"], resp.text)
    client.post(f"/api/admin/users/{uid2}/roles", json={"role_ids": [op_id]}, headers=super_h)
    resp = client.delete(f"/api/admin/roles/{role_id}", headers=super_h)
    record("A5f", "移除授权后删除成功", resp.status_code == 200, resp.text)

    # ---- A6 授权链路（access 角色 + 用户操作人审计） ----
    resp = client.post("/api/admin/roles", json={"name": ROLE_NAME_PREFIX + "授权管理", "menus": ["access", "audit"]}, headers=super_h)
    mgr_role_id = resp.json()["id"]
    resp = client.post(f"/api/admin/users/{uid2}/roles", json={"role_ids": [op_id, mgr_role_id]}, headers=super_h)
    record("A6a", "授予 operator+access 双角色", resp.status_code == 200, resp.text)
    resp = client.get("/api/admin/users", headers=h2)
    record("A6b", "access 角色可访问人员列表", resp.status_code == 200, resp.text)
    resp = client.post(f"/api/admin/users/{uid3}/roles", json={"role_ids": [op_id]}, headers=h2)
    record("A6c", "用户管理员可授权他人", resp.status_code == 200, resp.text)
    u3_admin_token = create_admin_token_for_user(uid3)
    resp = client.get("/api/admin/dashboard", headers={"Authorization": "Bearer " + u3_admin_token})
    record("A6d", "被授权者即时获得访问权限", resp.status_code == 200, resp.text)
    db = SessionLocal()
    try:
        super_grant = (
            db.query(AuditLog)
            .filter(AuditLog.action == "access.roles.grant", AuditLog.actor_type == "super")
            .first()
        )
        user_grant = (
            db.query(AuditLog)
            .filter(
                AuditLog.action == "access.roles.grant",
                AuditLog.actor_type == "user",
                AuditLog.actor_user_id == uid2,
            )
            .first()
        )
    finally:
        db.close()
    record(
        "A6e",
        "授权变更审计（super=超级管理员 / user=昵称）",
        super_grant is not None and user_grant is not None,
        "",
    )

    # ---- A7 禁用即时生效 ----
    resp = client.patch(f"/api/admin/users/{uid2}/roles/{op_id}/enabled", json={"is_enabled": False}, headers=super_h)
    ok = client.get("/api/admin/dashboard", headers=h2).status_code == 403
    ok = ok and client.get("/api/admin/users", headers=h2).status_code == 200
    record("A7a", "禁用 operator 即时生效（dashboard 403 / access 仍可用）", resp.status_code == 200 and ok, resp.text)
    resp = client.patch(f"/api/admin/users/{uid2}/roles/{op_id}/enabled", json={"is_enabled": True}, headers=super_h)
    ok = client.get("/api/admin/dashboard", headers=h2).status_code == 200
    record("A7b", "重新启用后恢复", resp.status_code == 200 and ok, resp.text)

    # ---- A8 错误分支 ----
    resp = client.post("/api/admin/users/999999/roles", json={"role_ids": []}, headers=super_h)
    record("A8a", "授权给不存在用户 404", resp.status_code == 404, resp.text)
    resp = client.post(f"/api/admin/users/{uid2}/roles", json={"role_ids": [999999]}, headers=super_h)
    record("A8b", "授权不存在角色 400", resp.status_code == 400 and "角色不存在" in resp.json()["detail"], resp.text)
    resp = client.put("/api/admin/roles/999999", json={"name": "x", "menus": []}, headers=super_h)
    record("A8c", "编辑不存在角色 400", resp.status_code == 400, resp.text)
    resp = client.patch(f"/api/admin/users/{uid2}/roles/999999/enabled", json={"is_enabled": False}, headers=super_h)
    record("A8d", "禁用未授权角色 404", resp.status_code == 404, resp.text)

    # ---- A9 审计日志筛选与昵称解析 ----
    resp = client.get("/api/admin/audit-logs", params={"action": "access.roles.grant", "actor_type": "super"}, headers=super_h)
    data = resp.json()
    ok = data["total"] >= 1 and all(i["actor_name"] == "超级管理员" for i in data["items"])
    record("A9a", "审计筛选 action+actor_type（超管昵称）", ok, f"total={data['total']}")
    resp = client.get("/api/admin/audit-logs", params={"actor_type": "user"}, headers=super_h)
    data = resp.json()
    ok = data["total"] >= 1 and all(i["actor_name"] for i in data["items"])
    record("A9b", "用户操作人昵称解析", ok, f"total={data['total']}")
    today = datetime.utcnow().strftime("%Y-%m-%d")
    resp = client.get("/api/admin/audit-logs", params={"date": today}, headers=super_h)
    ok = resp.status_code == 200 and resp.json()["total"] >= 1
    record("A9c", "日期筛选命中今日审计", ok, f"total={resp.json()['total']}")
    resp = client.get("/api/admin/audit-logs", params={"date": "2000-01-01"}, headers=super_h)
    record("A9d", "日期筛选无命中为空", resp.status_code == 200 and resp.json()["total"] == 0, resp.text)

    # ---- A10 WS 鉴权改造 ----
    ok_admin = ws_connect(client, u2_admin_token)
    ok_user = ws_connect(client, token_u1)
    bad = ws_connect(client, "garbage-token")
    client.post(f"/api/admin/users/{uid2}/roles", json={"role_ids": []}, headers=super_h)
    revoked = ws_close_code(client, u2_admin_token)
    record(
        "A10",
        "WS 鉴权（管理员可连/用户可连/坏令牌 4401/撤销后 4403）",
        ok_admin == "ok" and ok_user == "ok" and bad == "closed:4401" and revoked == 4403,
        f"admin={ok_admin} user={ok_user} bad={bad} revoked={revoked}",
    )

    cleanup()
    failed = [r for r in RESULTS if not r["ok"]]
    print(f"\nS9 结果：{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
