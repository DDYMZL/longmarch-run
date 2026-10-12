# -*- coding: utf-8 -*-
"""
S19-PG 邀请码并发核销 真实 openGauss 验证（使用 backend/.env 的 DATABASE_URL）

SQLite 写入天然串行，无法证明行锁语义；本脚本在真实库上验证：
  P01 12 个不同身份并发抢 max_uses=5 的邀请码 → 恰好 5 人入驻、used_count=5
  P02 同一身份 10 并发入驻（不限次数码）→ 1 个用户、used_count=1、全部 200
  P03 同一身份 10 并发入驻 max_uses=1 的码 → 1 个用户、全部 200（后到者走「已入驻」复用）
测试数据 openid 前缀 o_s19pg_、邀请码名前缀 S19PG，结束后（含失败）全部清理。

用法：cd backend && python test/s19_invite_concurrency_pg.py
"""
import json
import os
import sys
import threading

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient
from sqlalchemy import or_

from app.core import rate_limit
from app.core.config import settings
from app.core.database import SessionLocal, engine
from app.main import app
from app.models.models import AuditLog, InviteCode, Organization, PointsLog, User, UserIdentity
from app.services import auth_service, invite_service

RESULTS = []
PREFIX = "o_s19pg_"


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:400]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:240]) if detail else ""))


def q(fn):
    db = SessionLocal()
    try:
        return fn(db)
    finally:
        db.close()


def make_invite(max_uses):
    def _do(db):
        inv = InviteCode(code=invite_service.generate_code(), name="S19PG 并发", max_uses=max_uses)
        db.add(inv)
        db.commit()
        return inv.id, inv.code
    return q(_do)


def race(client, invite_code, openid_of, n, org_id):
    barrier = threading.Barrier(n)
    statuses, details, lock = [], [], threading.Lock()

    def fake(code):
        barrier.wait(timeout=20)
        return {"openid": openid_of(code), "unionid": None, "session_key": "k"}

    auth_service.code2session = fake
    rate_limit.invite_limiter._hits.clear()

    def worker(i):
        resp = client.post("/api/auth/onboard", json={
            "code": f"{i:02d}", "inviteCode": invite_code, "nickname": f"并发{i}", "orgId": org_id})
        with lock:
            statuses.append(resp.status_code)
            if resp.status_code != 200:
                details.append(resp.json().get("detail"))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    [t.start() for t in threads]
    [t.join(60) for t in threads]
    return sorted(statuses), details


def cleanup():
    def _do(db):
        uids = [u for (u,) in db.query(User.id).filter(User.openid.like(PREFIX + "%")).all()]
        if uids:
            db.query(UserIdentity).filter(UserIdentity.user_id.in_(uids)).delete(synchronize_session=False)
            db.query(PointsLog).filter(PointsLog.user_id.in_(uids)).delete(synchronize_session=False)
            db.query(AuditLog).filter(
                or_(AuditLog.actor_user_id.in_(uids), AuditLog.target_user_id.in_(uids))
            ).delete(synchronize_session=False)
            db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
        db.query(InviteCode).filter(InviteCode.name.like("S19PG%")).delete(synchronize_session=False)
        db.commit()
        return len(uids)
    return q(_do)


def main():
    if not settings.DATABASE_URL.startswith("postgresql"):
        print("DATABASE_URL 不是 openGauss/PostgreSQL，跳过")
        return 1
    client = TestClient(app)
    original = auth_service.code2session
    try:
        cleanup()
        org_id = q(lambda db: db.query(Organization.id).order_by(Organization.id).limit(1).scalar())
        users_of = lambda iid: q(lambda db: db.query(User).filter(User.invite_code_id == iid).count())
        used = lambda iid: q(lambda db: db.query(InviteCode.used_count).filter(InviteCode.id == iid).scalar())

        iid, code = make_invite(5)
        statuses, details = race(client, code, lambda c: PREFIX + "cap_" + c, 12, org_id)
        record("P01", "12 个不同身份并发抢 max_uses=5：恰好 5 人入驻",
               statuses.count(200) == 5 and statuses.count(400) == 7 and set(details) == {"邀请码使用次数已满"}
               and used(iid) == 5 and users_of(iid) == 5,
               f"statuses={statuses} details={set(details)} used={used(iid)} users={users_of(iid)}")

        iid, code = make_invite(None)
        statuses, details = race(client, code, lambda c: PREFIX + "same_a", 10, org_id)
        n_users = q(lambda db: db.query(User).filter(User.openid == PREFIX + "same_a").count())
        record("P02", "同一身份 10 并发入驻（不限次）：1 个用户、仅核销 1 次",
               statuses == [200] * 10 and n_users == 1 and used(iid) == 1,
               f"statuses={statuses} details={details} users={n_users} used={used(iid)}")

        iid, code = make_invite(1)
        statuses, details = race(client, code, lambda c: PREFIX + "same_b", 10, org_id)
        n_users = q(lambda db: db.query(User).filter(User.openid == PREFIX + "same_b").count())
        record("P03", "同一身份 10 并发入驻 max_uses=1：1 个用户、全部成功",
               statuses == [200] * 10 and n_users == 1 and used(iid) == 1,
               f"statuses={statuses} details={details} users={n_users} used={used(iid)}")
    finally:
        auth_service.code2session = original
        removed = cleanup()
        print(f"清理测试用户 {removed} 个")
        engine.dispose()

    passed = sum(1 for x in RESULTS if x["ok"])
    print(f"\n== S19-PG 并发核销（openGauss）: {passed}/{len(RESULTS)} 通过 ==")
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s19-invite-concurrency-pg-results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"results": RESULTS}, f, ensure_ascii=False, indent=2)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
