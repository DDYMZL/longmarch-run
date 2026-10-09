# -*- coding: utf-8 -*-
"""
S8 微信身份关联与扫码登录 冒烟脚本（TestClient，不依赖 8010 端口残留进程）

覆盖（批次2 范围）：
  A1 mock 登录不产生身份行；/auth/identities 为空
  A2 创建扫码会话：mock 模式返回 scene 明文、image=None、expires_in=300
  A3 轮询 pending 状态不含 token
  A4 /auth/qr/info 合法场景返回 type=login 并置 scanned；无 token 401；非法场景 400
  A5 无后台角色的用户确认登录 → 403，会话 failed 带原因，轮询无 token
  A6 授权 operator 角色后确认登录 → 轮询返回 token+menus（含 questions、不含 access）
  A7 令牌单次签发：二次轮询不再返回 token；token 可访问 /admin/me（is_super=False）
  A8 用户取消登录 → 会话 cancelled
  A9 过期会话：info 404、轮询置 expired
  A10 绑定确认成功：identities 新增 wx_web 身份；凭证重复使用 400
  A11 同用户同渠道重复绑定 400；openid 已绑他人 400；unionid 已属他人 400
  A12 解绑：非本人身份 400；wx_mini 主身份 400；wx_web 解绑成功并留审计
用法：cd backend && python test/s8_identity_admin.py
"""
import hashlib
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.database import SessionLocal
from app.main import app
from app.models.models import (
    AdminRole,
    AdminUserRole,
    AuditLog,
    BindRequest,
    DailySport,
    LitNode,
    PointsLog,
    QrLoginSession,
    QuizRecord,
    User,
    UserEvent,
    UserIdentity,
    UserMedal,
)

RESULTS = []
SMOKE_PREFIX = "s8-identity-admin"
TEST_APP_ID = "wx-test-s8"


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def smoke_openid(tag):
    return "mock_" + hashlib.md5((SMOKE_PREFIX + "-" + tag).encode("utf-8")).hexdigest()[:24]


def sha256(raw):
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def cleanup():
    """清理冒烟用户及其身份/会话/绑定/审计数据，保证可重复执行。"""
    db = SessionLocal()
    try:
        smoke_openids = {smoke_openid(t) for t in ("u1", "u2", "u3")}
        user_ids = [
            row[0]
            for row in db.query(User.id, User.openid).all()
            if row[1] in smoke_openids
        ]
        if user_ids:
            for model in (UserIdentity, AdminUserRole):
                db.query(model).filter(model.user_id.in_(user_ids)).delete(synchronize_session=False)
            db.query(QrLoginSession).filter(QrLoginSession.user_id.in_(user_ids)).delete(synchronize_session=False)
            db.query(BindRequest).filter(BindRequest.user_id.in_(user_ids)).delete(synchronize_session=False)
            db.query(AuditLog).filter(AuditLog.actor_user_id.in_(user_ids)).delete(synchronize_session=False)
            for model in (PointsLog, DailySport, LitNode, UserMedal, QuizRecord, UserEvent):
                db.query(model).filter(model.user_id.in_(user_ids)).delete(synchronize_session=False)
            db.query(User).filter(User.id.in_(user_ids)).delete(synchronize_session=False)
        db.query(UserIdentity).filter(UserIdentity.app_id == TEST_APP_ID).delete(synchronize_session=False)
        db.query(BindRequest).filter(BindRequest.app_id == TEST_APP_ID).delete(synchronize_session=False)
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


def create_qr(client):
    resp = client.post("/api/admin/wechat/qr")
    assert resp.status_code == 200, f"qr create failed: {resp.status_code} {resp.text}"
    return resp.json()


def grant_operator(db, user_id):
    role = db.query(AdminRole).filter(AdminRole.code == "operator").first()
    db.add(AdminUserRole(user_id=user_id, role_id=role.id, enabled=True, granted_by="s8-test"))
    db.commit()


def poll(client, qr_id):
    resp = client.get(f"/api/admin/wechat/qr/{qr_id}/status")
    assert resp.status_code == 200, f"poll failed: {resp.status_code} {resp.text}"
    return resp.json()


def main():
    client = TestClient(app)
    cleanup()

    # ---- A1 mock 登录不产生身份行 ----
    token_u1 = login_user(client, "u1")
    resp = client.get("/api/auth/identities", headers={"Authorization": "Bearer " + token_u1})
    record("A1", "mock 登录无身份行且列表为空", resp.status_code == 200 and resp.json() == [], resp.text)

    # ---- A2 创建扫码会话 ----
    qr = create_qr(client)
    ok = qr.get("mock") is True and qr.get("image") is None and bool(qr.get("scene", "").startswith("L")) and qr.get("expires_in") == settings.QR_LOGIN_TTL_SECONDS
    record("A2", "创建会话（mock 返回 scene 明文）", ok, qr)
    qr_id, scene = qr["qr_id"], qr["scene"]

    # ---- A3 轮询 pending ----
    status = poll(client, qr_id)
    record("A3", "pending 轮询无 token", status["status"] == "pending" and status.get("token") is None, status)

    # ---- A4 qr/info ----
    resp = client.post("/api/auth/qr/info", json={"scene": scene})
    record("A4a", "qr/info 无 token 401", resp.status_code == 401, resp.text)
    resp = client.post(
        "/api/auth/qr/info",
        json={"scene": scene},
        headers={"Authorization": "Bearer " + token_u1},
    )
    record("A4b", "qr/info 返回 login 并置 scanned", resp.status_code == 200 and resp.json()["type"] == "login", resp.text)
    resp = client.post(
        "/api/auth/qr/info",
        json={"scene": "Xbadtoken"},
        headers={"Authorization": "Bearer " + token_u1},
    )
    record("A4c", "非法场景 400", resp.status_code == 400, resp.text)

    # ---- A5 无角色确认登录被拒 ----
    resp = client.post(
        "/api/auth/qr/confirm",
        json={"scene": scene, "action": "confirm"},
        headers={"Authorization": "Bearer " + token_u1},
    )
    record("A5a", "无角色确认 403", resp.status_code == 403, resp.text)
    status = poll(client, qr_id)
    record("A5b", "会话 failed 带原因且无 token", status["status"] == "failed" and bool(status.get("fail_reason")) and status.get("token") is None, status)

    # ---- A6 授权后确认登录成功 ----
    db = SessionLocal()
    try:
        user1 = db.query(User).filter(User.openid == smoke_openid("u1")).first()
        grant_operator(db, user1.id)
    finally:
        db.close()
    qr2 = create_qr(client)
    scene2 = qr2["scene"]
    client.post(
        "/api/auth/qr/confirm",
        json={"scene": scene2, "action": "confirm"},
        headers={"Authorization": "Bearer " + token_u1},
    )
    status = poll(client, qr2["qr_id"])
    menus = [m["code"] for m in status.get("menus") or []]
    record("A6", "确认后返回 token 与角色菜单", status["status"] == "confirmed" and bool(status.get("token")) and "questions" in menus and "access" not in menus, status)

    # ---- A7 单次签发 + /admin/me ----
    admin_token = status.get("token")
    status2 = poll(client, qr2["qr_id"])
    record("A7a", "二次轮询不再签发 token", status2.get("token") is None, status2)
    resp = client.get("/api/admin/me", headers={"Authorization": "Bearer " + admin_token})
    me = resp.json()
    record("A7b", "关联管理员 /admin/me", resp.status_code == 200 and me["is_super"] is False and me["username"] == "冒烟u1" and "operator" in me["roles"], me)

    # ---- A8 取消登录 ----
    qr3 = create_qr(client)
    resp = client.post(
        "/api/auth/qr/confirm",
        json={"scene": qr3["scene"], "action": "cancel"},
        headers={"Authorization": "Bearer " + token_u1},
    )
    status = poll(client, qr3["qr_id"])
    record("A8", "取消登录置 cancelled", resp.status_code == 200 and status["status"] == "cancelled", status)

    # ---- A9 过期会话 ----
    qr4 = create_qr(client)
    db = SessionLocal()
    try:
        session = db.query(QrLoginSession).filter(QrLoginSession.id == qr4["qr_id"]).first()
        session.expires_at = datetime.utcnow() - timedelta(seconds=10)
        db.commit()
    finally:
        db.close()
    resp = client.post(
        "/api/auth/qr/info",
        json={"scene": qr4["scene"]},
        headers={"Authorization": "Bearer " + token_u1},
    )
    status = poll(client, qr4["qr_id"])
    record("A9", "过期会话 info 404 且轮询置 expired", resp.status_code == 404 and status["status"] == "expired", f"{resp.status_code}/{status['status']}")

    # ---- A10 绑定确认成功 + 凭证重复使用 ----
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        db.add(
            BindRequest(
                token_hash=sha256("btok1"),
                provider="wx_web",
                app_id=TEST_APP_ID,
                openid="o-web-1",
                status="pending",
                expires_at=now + timedelta(seconds=600),
            )
        )
        db.commit()
    finally:
        db.close()
    resp = client.post(
        "/api/auth/qr/info",
        json={"scene": "Bbtok1"},
        headers={"Authorization": "Bearer " + token_u1},
    )
    record("A10a", "绑定 info 返回目标渠道", resp.status_code == 200 and resp.json()["type"] == "bind" and resp.json()["target"]["provider"] == "wx_web", resp.text)
    resp = client.post(
        "/api/auth/qr/confirm",
        json={"scene": "Bbtok1", "action": "confirm"},
        headers={"Authorization": "Bearer " + token_u1},
    )
    record("A10b", "绑定确认成功", resp.status_code == 200, resp.text)
    resp = client.get("/api/auth/identities", headers={"Authorization": "Bearer " + token_u1})
    bound = [i for i in resp.json() if i["appId"] == TEST_APP_ID]
    record("A10c", "身份列表出现 wx_web 行", len(bound) == 1, resp.json())
    resp = client.post(
        "/api/auth/qr/confirm",
        json={"scene": "Bbtok1", "action": "confirm"},
        headers={"Authorization": "Bearer " + token_u1},
    )
    record("A10d", "凭证重复使用 400", resp.status_code == 400, resp.text)

    # ---- A11 重复绑定 / openid 冲突 / unionid 冲突 ----
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        db.add(
            BindRequest(
                token_hash=sha256("btok2"),
                provider="wx_web",
                app_id=TEST_APP_ID,
                openid="o-web-1",
                status="pending",
                expires_at=now + timedelta(seconds=600),
            )
        )
        db.add(
            BindRequest(
                token_hash=sha256("btok3"),
                provider="wx_web",
                app_id=TEST_APP_ID,
                openid="o-web-1",
                status="pending",
                expires_at=now + timedelta(seconds=600),
            )
        )
        db.commit()
    finally:
        db.close()
    resp = client.post(
        "/api/auth/qr/confirm",
        json={"scene": "Bbtok2", "action": "confirm"},
        headers={"Authorization": "Bearer " + token_u1},
    )
    record("A11a", "同用户同渠道重复绑定 400", resp.status_code == 400, resp.text)

    token_u2 = login_user(client, "u2")
    resp = client.post(
        "/api/auth/qr/confirm",
        json={"scene": "Bbtok3", "action": "confirm"},
        headers={"Authorization": "Bearer " + token_u2},
    )
    record(
        "A11b",
        "openid 已绑他人 400",
        resp.status_code == 400 and "其他账号" in resp.json()["detail"],
        resp.text,
    )

    db = SessionLocal()
    try:
        user1 = db.query(User).filter(User.openid == smoke_openid("u1")).first()
        db.query(UserIdentity).filter(
            UserIdentity.app_id == TEST_APP_ID, UserIdentity.user_id == user1.id
        ).update({"unionid": "uni-1"}, synchronize_session=False)
        now = datetime.utcnow()
        db.add(
            BindRequest(
                token_hash=sha256("btok4"),
                provider="wx_web",
                app_id=TEST_APP_ID,
                openid="o-web-3",
                unionid="uni-1",
                status="pending",
                expires_at=now + timedelta(seconds=600),
            )
        )
        db.commit()
    finally:
        db.close()
    resp = client.post(
        "/api/auth/qr/confirm",
        json={"scene": "Bbtok4", "action": "confirm"},
        headers={"Authorization": "Bearer " + token_u2},
    )
    record(
        "A11c",
        "unionid 已属他人 400",
        resp.status_code == 400 and "UnionID" in resp.json()["detail"],
        resp.text,
    )

    # ---- A12 解绑规则 ----
    resp = client.get("/api/auth/identities", headers={"Authorization": "Bearer " + token_u1})
    web_identity = next(i for i in resp.json() if i["appId"] == TEST_APP_ID)
    token_u3 = login_user(client, "u3")
    resp = client.delete(
        f"/api/auth/identities/{web_identity['id']}",
        headers={"Authorization": "Bearer " + token_u3},
    )
    record("A12a", "解绑非本人身份 400", resp.status_code == 400, resp.text)
    db = SessionLocal()
    try:
        user1 = db.query(User).filter(User.openid == smoke_openid("u1")).first()
        db.add(
            UserIdentity(
                user_id=user1.id, provider="wx_mini", app_id="wx-s8-mini",
                openid="o-mini-1", verified_at=datetime.utcnow(),
            )
        )
        db.commit()
    finally:
        db.close()
    resp = client.get("/api/auth/identities", headers={"Authorization": "Bearer " + token_u1})
    mini_identity = next(i for i in resp.json() if i["provider"] == "wx_mini")
    resp = client.delete(
        f"/api/auth/identities/{mini_identity['id']}",
        headers={"Authorization": "Bearer " + token_u1},
    )
    record("A12b", "解绑 wx_mini 主身份 400", resp.status_code == 400, resp.text)
    resp = client.delete(
        f"/api/auth/identities/{web_identity['id']}",
        headers={"Authorization": "Bearer " + token_u1},
    )
    remaining = client.get("/api/auth/identities", headers={"Authorization": "Bearer " + token_u1}).json()
    db = SessionLocal()
    try:
        audited = (
            db.query(AuditLog)
            .filter(AuditLog.action == "identity.unbind", AuditLog.actor_user_id.isnot(None))
            .count()
        )
    finally:
        db.close()
    record("A12c", "解绑 wx_web 成功并留审计", resp.status_code == 200 and all(i["appId"] != TEST_APP_ID for i in remaining) and audited >= 1, remaining)

    cleanup()
    failed = [r for r in RESULTS if not r["ok"]]
    print(f"\nS8 结果：{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
