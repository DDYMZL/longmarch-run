# -*- coding: utf-8 -*-
"""
S13 V1.0 通用二维码扫码入驻与自动登录 后端冒烟脚本（TestClient + SQLite 临时库）

覆盖（对应需求测试项）：
  L01 新用户首次登录：建用户、默认昵称、签发 Token，/auth/me 校验通过
  L02 重复登录不重复建号（同 openid 复用同一用户）
  L03 有效 Token 直接通过后端校验
  L04 过期 Token 被拒 401，重新登录复用同一用户并签发新 Token
  L05 已配置微信凭证但 code 换取失败 → 502，不建用户、不签发 Token（无假登录）
  L06 真实微信响应：以真实 openid 建号，再次登录复用
  L07 并发首登（8 线程同一 openid）不重复建号且全部成功
  L08 并发竞态分支：首查为空、插入撞唯一约束 → 回滚复用已有用户
  L09 已有步数/答题/勋章/组织/昵称/头像数据不因（静默）登录被覆盖
  L10 全部用户受保护接口：无 Token / 伪造 Token → 401
  L11 普通用户 Token 访问全部管理接口 → 401/403（扫码不获管理权限）
  L12 入驻二维码：仅管理员可取，码内仅页面与渠道标记，不含 OpenID/Token
  L13 WX_LOGIN_ALLOW_MOCK 本地测试开关：已配置凭证时允许回退 mock

用法：cd backend && python test/s13_onboard_login.py
"""
import json
import os
import re
import sys
import threading
from datetime import datetime, timedelta, timezone

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_smoke_onboard.db")
if os.path.exists(_DB_PATH):
    os.remove(_DB_PATH)
os.environ["DATABASE_URL"] = "sqlite:///" + _DB_PATH.replace("\\", "/")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import jwt
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.api import deps
from app.api.routes import (
    admin, auth, broadcast, identity, march, medal, org, persons, points, profile, quiz, quotes, rank, sport,
)
from app.core.config import settings
from app.core.database import Base, SessionLocal, engine
from app.core.security import create_access_token, create_admin_token
from app.main import app
from app.models.models import DailySport, QuizRecord, User, UserMedal
from app.services import auth_service, wechat_service

RESULTS = []
USER_MODULES = [auth, identity, sport, march, quiz, points, medal, org, rank, profile, persons, quotes, broadcast]


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def user_count(openid=None):
    db = SessionLocal()
    try:
        q = db.query(User)
        if openid is not None:
            q = q.filter(User.openid == openid)
        return q.count()
    finally:
        db.close()


def set_wx(appid, secret, allow_mock=False):
    settings.WX_APPID = appid
    settings.WX_SECRET = secret
    settings.WX_LOGIN_ALLOW_MOCK = allow_mock


def depends_on(dependant, target):
    return any(d.call is target or depends_on(d, target) for d in dependant.dependencies)


def iter_routes(modules):
    for module in modules:
        for route in module.router.routes:
            if isinstance(route, APIRoute):
                yield route


def call(client, method, path, headers=None):
    url = "/api" + re.sub(r"\{[^}]+\}", "1", path)
    return client.request(method, url, headers=headers or {}, json={})


def main():
    Base.metadata.create_all(engine)
    client = TestClient(app)
    original_code2session = auth_service.code2session
    original_wx = (settings.WX_APPID, settings.WX_SECRET, settings.WX_LOGIN_ALLOW_MOCK)
    try:
        set_wx("", "")

        # L01 新用户首次登录
        r = client.post("/api/auth/login", json={"code": "s13-new-user"})
        body = r.json() if r.status_code == 200 else {}
        token = body.get("token", "")
        uid = (body.get("user") or {}).get("id")
        me = client.get("/api/auth/me", headers={"Authorization": "Bearer " + token})
        mock_openid = auth_service._mock_openid("s13-new-user")
        record("L01", "新用户首次登录建号并签发 Token",
               r.status_code == 200 and token and body["user"]["nickname"] == auth_service.DEFAULT_NICKNAME
               and body["user"]["orgId"] is None and user_count(mock_openid) == 1
               and me.status_code == 200 and me.json()["id"] == uid,
               f"status={r.status_code} me={me.status_code}")

        # L02 重复登录
        ids = [client.post("/api/auth/login", json={"code": "s13-new-user"}).json()["user"]["id"] for _ in range(3)]
        record("L02", "重复登录不重复建号", set(ids) == {uid} and user_count(mock_openid) == 1,
               f"ids={ids} count={user_count(mock_openid)}")

        # L03 有效 Token
        r = client.get("/api/auth/me", headers={"Authorization": "Bearer " + create_access_token(uid, mock_openid)})
        record("L03", "有效 Token 通过后端校验", r.status_code == 200 and r.json()["id"] == uid, f"status={r.status_code}")

        # L04 过期 Token
        now = datetime.now(timezone.utc)
        expired = jwt.encode({"sub": str(uid), "openid": mock_openid, "iat": now - timedelta(days=8),
                              "exp": now - timedelta(minutes=1)}, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
        r_exp = client.get("/api/auth/me", headers={"Authorization": "Bearer " + expired})
        r_re = client.post("/api/auth/login", json={"code": "s13-new-user"})
        new_token = r_re.json().get("token", "")
        r_me = client.get("/api/auth/me", headers={"Authorization": "Bearer " + new_token})
        record("L04", "过期 Token 401，重新登录复用同一用户",
               r_exp.status_code == 401 and r_re.status_code == 200 and r_re.json()["user"]["id"] == uid
               and r_me.status_code == 200, f"expired={r_exp.status_code} relogin={r_re.status_code} me={r_me.status_code}")

        # L05 已配置凭证但微信换取失败
        set_wx("wx-s13-appid", "wx-s13-secret")
        auth_service.code2session = lambda code: None
        before = user_count()
        r = client.post("/api/auth/login", json={"code": "s13-wx-fail"})
        record("L05", "微信换取失败返回 502 且不建号不签发 Token",
               r.status_code == 502 and "token" not in r.json() and user_count() == before,
               f"status={r.status_code} detail={r.json().get('detail')}")

        # L06 真实微信响应
        real_openid = "o_s13_real_openid_0001"
        auth_service.code2session = lambda code: {"openid": real_openid, "unionid": None, "session_key": "k"}
        r1 = client.post("/api/auth/login", json={"code": "s13-real-1"})
        r2 = client.post("/api/auth/login", json={"code": "s13-real-2"})
        record("L06", "真实 openid 建号且再次登录复用",
               r1.status_code == 200 and r2.status_code == 200
               and r1.json()["user"]["id"] == r2.json()["user"]["id"] and user_count(real_openid) == 1,
               f"s1={r1.status_code} s2={r2.status_code} count={user_count(real_openid)}")

        # L07 并发首登
        race_openid = "o_s13_race_openid_0001"
        barrier = threading.Barrier(8)

        def racing_code2session(code):
            barrier.wait(timeout=10)
            return {"openid": race_openid, "unionid": None, "session_key": "k"}

        auth_service.code2session = racing_code2session
        statuses, race_ids, lock = [], [], threading.Lock()

        def worker(i):
            resp = client.post("/api/auth/login", json={"code": f"s13-race-{i}"})
            with lock:
                statuses.append(resp.status_code)
                if resp.status_code == 200:
                    race_ids.append(resp.json()["user"]["id"])

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        record("L07", "8 并发首登全部成功且仅建 1 个用户",
               statuses == [200] * 8 and len(set(race_ids)) == 1 and user_count(race_openid) == 1,
               f"statuses={sorted(statuses)} ids={sorted(set(race_ids))} count={user_count(race_openid)}")

        # L08 竞态分支：首查返回空（模拟另一请求尚未提交），插入撞唯一约束
        class _EmptyFirst:
            def filter(self, *a, **k):
                return self

            def first(self):
                return None

        class RaceSession:
            def __init__(self, real):
                self.real, self.faked = real, False

            def query(self, *entities):
                if not self.faked and entities == (User,):
                    self.faked = True
                    return _EmptyFirst()
                return self.real.query(*entities)

            def __getattr__(self, name):
                return getattr(self.real, name)

        real_db = SessionLocal()
        try:
            got = auth_service._get_or_create_user(RaceSession(real_db), race_openid, "", "")
            record("L08", "唯一约束冲突回滚后复用已有用户",
                   bool(race_ids) and got.id == race_ids[0] and user_count(race_openid) == 1,
                   f"got={got.id} expect={race_ids[:1]} count={user_count(race_openid)}")
        finally:
            real_db.close()

        # L09 业务数据保留
        db = SessionLocal()
        try:
            u = db.query(User).filter(User.openid == real_openid).one()
            u.org_id, u.nickname, u.avatar = 7, "S13已改名", "https://example.com/a.png"
            u.nickname_changed_at = datetime.utcnow()
            db.add(DailySport(user_id=u.id, date="2026-10-01", steps=12345, distance=8.64, is_goal_completed=True))
            db.add(QuizRecord(user_id=u.id, date="2026-10-01", total_count=5, correct_count=4, score=80, points=5))
            db.add(UserMedal(user_id=u.id, medal_id="first_step"))
            db.commit()
            real_uid = u.id
        finally:
            db.close()
        auth_service.code2session = lambda code: {"openid": real_openid, "unionid": None, "session_key": "k"}
        r = client.post("/api/auth/login", json={"code": "s13-real-3"})
        db = SessionLocal()
        try:
            u = db.query(User).filter(User.id == real_uid).one()
            sport_row = db.query(DailySport).filter(DailySport.user_id == real_uid).one()
            quiz_row = db.query(QuizRecord).filter(QuizRecord.user_id == real_uid).one()
            medals = db.query(UserMedal).filter(UserMedal.user_id == real_uid).count()
            kept = (u.org_id == 7 and u.nickname == "S13已改名" and u.avatar == "https://example.com/a.png"
                    and u.nickname_changed_at is not None and sport_row.steps == 12345
                    and quiz_row.score == 80 and medals == 1)
        finally:
            db.close()
        record("L09", "静默登录不覆盖组织/昵称/头像/步数/答题/勋章", r.status_code == 200 and kept,
               f"status={r.status_code} kept={kept}")

        # L10 用户受保护接口未登录拒绝
        protected = [rt for rt in iter_routes(USER_MODULES) if depends_on(rt.dependant, deps.get_current_user)]
        leaks = []
        for rt in protected:
            for method in rt.methods:
                for hdr in ({}, {"Authorization": "Bearer forged.token.value"}):
                    resp = call(client, method, rt.path, hdr)
                    if resp.status_code != 401:
                        leaks.append(f"{method} {rt.path} {resp.status_code}")
        record("L10", f"{len(protected)} 个用户受保护接口无/伪造 Token 均 401", protected and not leaks, f"leaks={leaks[:5]}")

        # L11 普通用户 Token 访问管理接口
        user_headers = {"Authorization": "Bearer " + create_access_token(real_uid, real_openid)}
        admin_routes = [rt for rt in iter_routes([admin]) if depends_on(rt.dependant, deps.get_current_admin)]
        escalations = []
        for rt in admin_routes:
            for method in rt.methods:
                resp = call(client, method, rt.path, user_headers)
                if resp.status_code not in (401, 403):
                    escalations.append(f"{method} {rt.path} {resp.status_code}")
        record("L11", f"{len(admin_routes)} 个管理接口拒绝普通用户 Token", admin_routes and not escalations,
               f"escalations={escalations[:5]}")

        # L12 入驻二维码
        set_wx("", "")
        wechat_service._onboard_png_cache.clear()
        admin_headers = {"Authorization": "Bearer " + create_admin_token("s13-admin")}
        r_admin = client.get("/api/admin/onboarding-qrcode", headers=admin_headers)
        r_anon = client.get("/api/admin/onboarding-qrcode")
        body = r_admin.json() if r_admin.status_code == 200 else {}
        payload_text = json.dumps(body, ensure_ascii=False)
        record("L12", "入驻码仅管理员可取且不含身份信息",
               r_admin.status_code == 200 and body.get("page") == "pages/launch/launch"
               and body.get("scene") == "src=onboard" and body.get("mock") is True
               and r_anon.status_code == 401 and real_openid not in payload_text and "eyJ" not in payload_text,
               f"admin={r_admin.status_code} anon={r_anon.status_code} body={payload_text[:150]}")

        # L13 本地测试开关
        set_wx("wx-s13-appid", "wx-s13-secret", allow_mock=True)
        auth_service.code2session = lambda code: None
        r = client.post("/api/auth/login", json={"code": "s13-allow-mock"})
        record("L13", "WX_LOGIN_ALLOW_MOCK=true 时回退 mock openid",
               r.status_code == 200 and user_count(auth_service._mock_openid("s13-allow-mock")) == 1,
               f"status={r.status_code}")
    finally:
        auth_service.code2session = original_code2session
        set_wx(*original_wx)
        engine.dispose()

    passed = sum(1 for x in RESULTS if x["ok"])
    print(f"\n== S13 扫码入驻与自动登录: {passed}/{len(RESULTS)} 通过 ==")
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s13-onboard-login-results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"results": RESULTS}, f, ensure_ascii=False, indent=2)
    if os.path.exists(_DB_PATH):
        os.remove(_DB_PATH)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
