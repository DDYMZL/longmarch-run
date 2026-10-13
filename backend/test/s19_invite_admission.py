# -*- coding: utf-8 -*-
"""
S19 邀请码准入 后端测试脚本（TestClient + SQLite 临时库；取代 S13 的「首登自动建号」口径）

覆盖：
  I01 未入驻用户登录：status=unregistered，不建号、不签发 Token
  I02 无邀请码入驻 → 400/422，不建号
  I03 无效邀请码（不存在/格式非法/超长）校验与入驻均 400「邀请码无效」
  I04 已过期邀请码 → 400「邀请码已过期」
  I05 已停用邀请码 → 400「邀请码已停用」
  I06 已用满邀请码 → 400「邀请码使用次数已满」
  I07 校验接口：有效码返回名称/组织且不核销，不回显邀请码与次数
  I08 正常入驻：建号（姓名/组织/邀请码/入驻时间/active）、核销 +1、审计、Token 可用、随后登录 active
  I09 专属码组织范围：越界组织/不存在组织 400 且不核销不建号；范围内下级组织成功
  I10 幂等：已入驻身份重复提交（即使所带邀请码已无效）返回同一用户、created=false、不再核销
  I11 已入驻用户原邀请码过期/停用/用满后登录仍 active
  I12 并发：同一身份 8 线程同时入驻 → 全部成功、仅 1 个用户、仅核销 1 次
  I13 并发：8 个不同身份抢 max_uses=3 的邀请码 → 恰好 3 个成功、used_count=3
  I14 竞态分支：建号撞 openid 唯一约束 → 回滚（核销撤销）并复用已有用户
  I15 停用用户：登录 disabled 无 Token；旧 Token 访问全部受保护接口 403 + X-Account-Status；入驻接口 403；WebSocket 4403；重新启用恢复
  I16 历史用户（invite_code_id 为空）登录 active，已有组织改选 403 锁定
  I17 专属码用户首次 /org/select 越界 400、范围内 200、再选 403；/org/mine 返回 scopeOrgId 与 locked
  I18 已配置微信凭证但 code 换取失败：登录/入驻均 502，不建号
  I19 全部用户受保护接口无/伪造 Token → 401
  I20 普通用户 Token 访问全部管理接口 → 401/403
  I21 管理端邀请码：鉴权、生成、列表、编辑、启停、上限不得低于已用、小程序码（mock）不含身份信息、有效期按 UTC 存储
  I22 管理端用户状态：仅 access 菜单可改，审计 user.disable/user.enable，人员列表含状态/邀请码名并可筛选
  I23 敏感信息：登录/入驻响应不含 openid/session_key/邀请码；日志不含 wx code、session_key、邀请码
  I24 WX_LOGIN_ALLOW_MOCK=true 时已配置凭证可回退 mock openid（仅登录识别，不建号）
  I25 过期 Token → 401；重新登录 active 并复用同一用户

用法：cd backend && python test/s19_invite_admission.py
"""
import json
import logging
import os
import re
import sys
import threading
from datetime import datetime, timedelta, timezone

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_smoke_invite.db")
if os.path.exists(_DB_PATH):
    os.remove(_DB_PATH)
os.environ["DATABASE_URL"] = "sqlite:///" + _DB_PATH.replace("\\", "/")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import jwt
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api import deps
from app.api.routes import (
    admin, auth, broadcast, identity, march, medal, org, persons, points, profile, quiz, quotes, rank, sport,
)
from app.core import rate_limit
from app.core.config import settings
from app.core.database import Base, SessionLocal, engine
from app.core.security import create_access_token, create_admin_token, create_admin_token_for_user
from app.main import app
from app.models.models import (
    AdminMenu, AdminRole, AdminRoleMenu, AdminUserRole, AuditLog, InviteCode, Organization, PointsLog, User,
)
from app.services import auth_service, wechat_service

RESULTS = []
USER_MODULES = [auth, identity, sport, march, quiz, points, medal, org, rank, profile, persons, quotes, broadcast]
ADMIN_H = {"Authorization": "Bearer " + create_admin_token("s19-admin")}


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:400]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:240]) if detail else ""))


def set_wx(appid, secret, allow_mock=False):
    settings.WX_APPID = appid
    settings.WX_SECRET = secret
    settings.WX_LOGIN_ALLOW_MOCK = allow_mock


def wx_as(openid):
    auth_service.code2session = lambda code: {"openid": openid, "unionid": None, "session_key": "SK_SECRET_s19"}


def reset_limits():
    rate_limit.invite_limiter._hits.clear()


def q(fn):
    db = SessionLocal()
    try:
        return fn(db)
    finally:
        db.close()


def users_with(openid):
    return q(lambda db: db.query(User).filter(User.openid == openid).count())


def used(invite_id):
    return q(lambda db: db.query(InviteCode.used_count).filter(InviteCode.id == invite_id).scalar())


def make_invite(**kw):
    def _do(db):
        fields = {"code": kw.pop("code", None) or auth_service.invite_service.generate_code(), "name": "S19 码"}
        fields.update(kw)
        inv = InviteCode(**fields)
        db.add(inv)
        db.commit()
        db.refresh(inv)
        return inv.id, inv.code
    return q(_do)


def onboard(client, code, nickname="张三", org_id=11, wx_code="wx-c"):
    reset_limits()
    return client.post("/api/auth/onboard", json={
        "code": wx_code, "inviteCode": code, "nickname": nickname, "orgId": org_id,
    })


def login(client, wx_code="wx-c"):
    return client.post("/api/auth/login", json={"code": wx_code})


def bearer(token):
    return {"Authorization": "Bearer " + token}


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


def seed_orgs():
    def _do(db):
        db.add_all([
            Organization(id=1, name="总部", parent_id=None, level=1),
            Organization(id=11, name="华东分公司", parent_id=1, level=2),
            Organization(id=111, name="技术部", parent_id=11, level=3),
            Organization(id=2, name="西南分公司", parent_id=None, level=1),
        ])
        db.commit()
    q(_do)


class LogCapture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.lines = []

    def emit(self, rec):
        try:
            self.lines.append(rec.getMessage())
        except Exception:
            self.lines.append(str(rec.msg))


def main():
    Base.metadata.create_all(engine)
    seed_orgs()
    client = TestClient(app)
    original_code2session = auth_service.code2session
    original_wx = (settings.WX_APPID, settings.WX_SECRET, settings.WX_LOGIN_ALLOW_MOCK)
    capture = LogCapture()
    logging.getLogger().addHandler(capture)
    logging.getLogger().setLevel(logging.DEBUG)
    try:
        set_wx("wx-s19-appid", "wx-s19-secret")
        now = datetime.utcnow()

        # I01 未入驻用户登录
        wx_as("o_s19_new_0001")
        r = login(client)
        body = r.json()
        record("I01", "未入驻登录返回 unregistered 且不建号不签发 Token",
               r.status_code == 200 and body.get("status") == "unregistered" and body.get("token") is None
               and body.get("user") is None and users_with("o_s19_new_0001") == 0, f"{r.status_code} {body}")

        # I02 无邀请码
        reset_limits()
        r_missing = client.post("/api/auth/onboard", json={"code": "c", "nickname": "张三", "orgId": 11})
        r_empty = onboard(client, "")
        record("I02", "无邀请码入驻被拒且不建号",
               r_missing.status_code == 422 and r_empty.status_code == 400
               and r_empty.json()["detail"] == "邀请码无效" and users_with("o_s19_new_0001") == 0,
               f"missing={r_missing.status_code} empty={r_empty.status_code} {r_empty.json()}")

        # I03 无效邀请码
        bad = ["NOPE0000NOPE0000", "../../etc", "a" * 40]
        res = []
        for code in bad:
            reset_limits()
            v = client.post("/api/auth/invite/verify", json={"inviteCode": code})
            o = onboard(client, code)
            res.append((v.status_code, v.json().get("detail"), o.status_code, o.json().get("detail")))
        record("I03", "无效/非法/超长邀请码校验与入驻均拒绝",
               all(x[2] in (400, 422) and x[0] in (400, 422) for x in res)
               and all(x[1] == "邀请码无效" and x[3] == "邀请码无效" for x in res[:2])
               and users_with("o_s19_new_0001") == 0, res)

        # I04/I05/I06 过期/停用/用满
        exp_id, exp_code = make_invite(expires_at=now - timedelta(minutes=1))
        dis_id, dis_code = make_invite(is_enabled=False)
        full_id, full_code = make_invite(max_uses=1, used_count=1)
        for cid, name, code, inv_id, msg in (
            ("I04", "已过期邀请码拒绝", exp_code, exp_id, "邀请码已过期"),
            ("I05", "已停用邀请码拒绝", dis_code, dis_id, "邀请码已停用"),
            ("I06", "已用满邀请码拒绝", full_code, full_id, "邀请码使用次数已满"),
        ):
            reset_limits()
            v = client.post("/api/auth/invite/verify", json={"inviteCode": code})
            o = onboard(client, code)
            record(cid, name,
                   v.status_code == 400 and v.json()["detail"] == msg and o.status_code == 400
                   and o.json()["detail"] == msg and users_with("o_s19_new_0001") == 0
                   and used(inv_id) == (1 if inv_id == full_id else 0),
                   f"verify={v.status_code}/{v.json()} onboard={o.status_code}/{o.json()}")

        # I07 校验不核销
        gen_id, gen_code = make_invite(name="通用码", max_uses=10)
        scoped_id, scoped_code = make_invite(name="华东专属码", org_id=11)
        reset_limits()
        v1 = client.post("/api/auth/invite/verify", json={"inviteCode": gen_code})
        v2 = client.post("/api/auth/invite/verify", json={"inviteCode": scoped_code})
        text = v1.text + v2.text
        record("I07", "校验有效码返回名称与组织范围、不核销、不回显码与次数",
               v1.status_code == 200 and v1.json() == {"name": "通用码", "orgId": None, "orgName": None}
               and v2.status_code == 200 and v2.json() == {"name": "华东专属码", "orgId": 11, "orgName": "华东分公司"}
               and used(gen_id) == 0 and gen_code not in text and scoped_code not in text and "usedCount" not in text,
               f"{v1.json()} {v2.json()}")

        # I08 正常入驻
        r = onboard(client, gen_code, nickname="  李四  ", org_id=111)
        body = r.json()
        token = body.get("token", "")
        u = q(lambda db: db.query(User).filter(User.openid == "o_s19_new_0001").first())
        me = client.get("/api/auth/me", headers=bearer(token))
        relog = login(client)
        audit = q(lambda db: db.query(AuditLog).filter(AuditLog.action == "user.onboard").all())
        pts = q(lambda db: db.query(PointsLog).filter(PointsLog.user_id == (u.id if u else -1)).count())
        record("I08", "持有效码入驻建号、核销+1、审计、Token 可用、再次登录 active",
               r.status_code == 200 and body.get("created") is True and u is not None
               and u.nickname == "李四" and u.original_nickname == "李四" and u.org_id == 111
               and u.invite_code_id == gen_id and u.onboarded_at is not None and u.status == "active"
               and used(gen_id) == 1 and me.status_code == 200 and me.json()["orgId"] == 111
               and relog.json().get("status") == "active" and relog.json().get("token")
               and len(audit) == 1 and gen_code not in (audit[0].detail or "") and pts == 0,
               f"{r.status_code} created={body.get('created')} used={used(gen_id)} audit={[a.detail for a in audit]} pts={pts}")
        uid_li = u.id if u else None

        # I09 组织范围
        wx_as("o_s19_scope_0001")
        before = used(scoped_id)
        r_out = onboard(client, scoped_code, org_id=2)
        r_none = onboard(client, scoped_code, org_id=9999)
        r_gen_none = onboard(client, gen_code, org_id=9999)
        mid_used = used(scoped_id)
        r_in = onboard(client, scoped_code, org_id=111)
        record("I09", "专属码越界/不存在组织拒绝且不核销，范围内下级组织成功",
               r_out.status_code == 400 and r_out.json()["detail"] == "所选组织不在邀请码允许的范围内"
               and r_none.status_code == 400 and r_none.json()["detail"] == "所选组织不存在"
               and r_gen_none.status_code == 400 and mid_used == before and used(gen_id) == 1
               and r_in.status_code == 200 and used(scoped_id) == before + 1
               and users_with("o_s19_scope_0001") == 1,
               f"out={r_out.json()} none={r_none.json()} in={r_in.status_code}")
        scoped_token = r_in.json().get("token", "")

        # I10 幂等
        wx_as("o_s19_new_0001")
        r_again = onboard(client, gen_code, nickname="王五", org_id=2)
        r_badcode = onboard(client, "NOPE0000NOPE0000")
        u2 = q(lambda db: db.query(User).filter(User.id == uid_li).first())
        record("I10", "已入驻身份重复入驻返回同一用户、不再核销、不覆盖资料",
               r_again.status_code == 200 and r_again.json()["created"] is False
               and r_again.json()["user"]["id"] == uid_li and r_badcode.status_code == 200
               and r_badcode.json()["user"]["id"] == uid_li and used(gen_id) == 1
               and u2.nickname == "李四" and u2.org_id == 111 and users_with("o_s19_new_0001") == 1,
               f"again={r_again.status_code} bad={r_badcode.status_code} used={used(gen_id)}")

        # I11 原邀请码失效不影响已入驻用户
        def _expire(db):
            inv = db.query(InviteCode).filter(InviteCode.id == gen_id).one()
            inv.expires_at, inv.is_enabled, inv.max_uses = now - timedelta(days=1), False, 1
            db.commit()
        q(_expire)
        r = login(client)
        me = client.get("/api/auth/me", headers=bearer(r.json().get("token") or ""))
        record("I11", "原邀请码过期/停用/用满后已入驻用户登录仍 active",
               r.json().get("status") == "active" and me.status_code == 200, f"{r.json().get('status')} me={me.status_code}")

        # I12 同一身份并发入驻
        race_id, race_code = make_invite(name="并发码")
        same_openid = "o_s19_same_race"
        barrier = threading.Barrier(8)

        def racing(code):
            barrier.wait(timeout=10)
            return {"openid": same_openid, "unionid": None, "session_key": "SK_SECRET_s19"}

        auth_service.code2session = racing
        reset_limits()
        statuses, ids, lock = [], [], threading.Lock()

        def worker_same(i):
            resp = client.post("/api/auth/onboard", json={
                "code": f"race-{i}", "inviteCode": race_code, "nickname": "并发", "orgId": 11})
            with lock:
                statuses.append(resp.status_code)
                if resp.status_code == 200:
                    ids.append(resp.json()["user"]["id"])

        threads = [threading.Thread(target=worker_same, args=(i,)) for i in range(8)]
        [t.start() for t in threads]
        [t.join(30) for t in threads]
        record("I12", "同一身份 8 并发入驻：全部成功、1 个用户、仅核销 1 次",
               statuses == [200] * 8 and len(set(ids)) == 1 and users_with(same_openid) == 1 and used(race_id) == 1,
               f"statuses={sorted(statuses)} users={users_with(same_openid)} used={used(race_id)}")

        # I13 不同身份并发抢有限次数
        cap_id, cap_code = make_invite(name="限量码", max_uses=3)
        barrier2 = threading.Barrier(8)

        def racing_distinct(code):
            barrier2.wait(timeout=10)
            return {"openid": "o_s19_cap_" + code, "unionid": None, "session_key": "SK_SECRET_s19"}

        auth_service.code2session = racing_distinct
        reset_limits()
        cap_status, cap_detail = [], []

        def worker_cap(i):
            resp = client.post("/api/auth/onboard", json={
                "code": f"{i:02d}", "inviteCode": cap_code, "nickname": f"抢{i}", "orgId": 11})
            with lock:
                cap_status.append(resp.status_code)
                if resp.status_code != 200:
                    cap_detail.append(resp.json().get("detail"))

        threads = [threading.Thread(target=worker_cap, args=(i,)) for i in range(8)]
        [t.start() for t in threads]
        [t.join(30) for t in threads]
        cap_users = q(lambda db: db.query(User).filter(User.invite_code_id == cap_id).count())
        record("I13", "8 个不同身份并发抢 max_uses=3：恰好 3 个成功且 used_count=3",
               cap_status.count(200) == 3 and cap_status.count(400) == 5
               and set(cap_detail) == {"邀请码使用次数已满"} and used(cap_id) == 3 and cap_users == 3,
               f"statuses={sorted(cap_status)} details={set(cap_detail)} used={used(cap_id)} users={cap_users}")

        # I14 竞态分支：首查为空、建号撞唯一约束
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

        branch_id, branch_code = make_invite(name="竞态码")
        wx_as(same_openid)
        real_db = SessionLocal()
        try:
            _tok, got, created = auth_service.onboard(RaceSession(real_db), "c", branch_code, "竞态", 11)
            record("I14", "建号撞唯一约束：回滚撤销核销并复用已有用户",
                   created is False and got.id == ids[0] and used(branch_id) == 0 and users_with(same_openid) == 1,
                   f"got={got.id} expect={ids[:1]} created={created} used={used(branch_id)}")
        finally:
            real_db.close()

        # I15 停用用户
        wx_as("o_s19_new_0001")
        li_token = create_access_token(uid_li, "o_s19_new_0001")
        r_dis = client.patch(f"/api/admin/users/{uid_li}/status", headers=ADMIN_H, json={"status": "disabled"})
        r_login = login(client)
        r_onb = onboard(client, race_code)
        protected = [rt for rt in iter_routes(USER_MODULES) if depends_on(rt.dependant, deps.get_current_user)]
        leaks = []
        for rt in protected:
            for method in rt.methods:
                resp = call(client, method, rt.path, bearer(li_token))
                if resp.status_code != 403 or resp.headers.get("x-account-status") != "disabled":
                    leaks.append(f"{method} {rt.path} {resp.status_code}")
        ws_code = None
        try:
            with client.websocket_connect("/api/ws/updates?token=" + li_token) as ws:
                ws.receive_text()
        except WebSocketDisconnect as exc:
            ws_code = exc.code
        r_en = client.patch(f"/api/admin/users/{uid_li}/status", headers=ADMIN_H, json={"status": "active"})
        r_back = client.get("/api/auth/me", headers=bearer(li_token))
        record("I15", f"停用：登录 disabled、{len(protected)} 个受保护接口 403、入驻 403、WS 4403；启用后恢复",
               r_dis.status_code == 200 and r_login.json() == {"status": "disabled", "token": None, "user": None}
               and r_onb.status_code == 403 and r_onb.headers.get("x-account-status") == "disabled"
               and protected and not leaks and ws_code == 4403
               and r_en.status_code == 200 and r_back.status_code == 200,
               f"login={r_login.json()} onboard={r_onb.status_code} leaks={leaks[:4]} ws={ws_code} back={r_back.status_code}")

        # I16 历史用户
        def _legacy(db):
            user = User(openid="o_s19_legacy", nickname="老用户", org_id=1, created_at=now - timedelta(days=30))
            db.add(user)
            db.commit()
            return user.id
        legacy_id = q(_legacy)
        wx_as("o_s19_legacy")
        r = login(client)
        r_sel = client.post("/api/org/select", headers=bearer(r.json().get("token") or ""), json={"orgId": 2})
        record("I16", "历史用户（无邀请码）登录 active、已有组织改选被锁定 403",
               r.json().get("status") == "active" and r.json()["user"]["id"] == legacy_id
               and r_sel.status_code == 403 and q(lambda db: db.get(User, legacy_id).org_id) == 1,
               f"login={r.json().get('status')} select={r_sel.status_code}")

        # I17 专属码用户（组织尚未确定）首次选组织受范围约束，选定后锁定
        def _clear_scoped_org(db):
            db.query(User).filter(User.openid == "o_s19_scope_0001").update({User.org_id: None})
            db.commit()
        q(_clear_scoped_org)
        h = bearer(scoped_token)
        r_out = client.post("/api/org/select", headers=h, json={"orgId": 2})
        r_404 = client.post("/api/org/select", headers=h, json={"orgId": 9999})
        r_in = client.post("/api/org/select", headers=h, json={"orgId": 11})
        r_again = client.post("/api/org/select", headers=h, json={"orgId": 111})
        r_mine = client.get("/api/org/mine", headers=h)
        record("I17", "专属码用户首次选组织越界 400、范围内 200、再选 403 锁定、/org/mine 返回范围与 locked",
               r_out.status_code == 400 and r_in.status_code == 200 and r_404.status_code == 404
               and r_again.status_code == 403 and r_mine.json().get("orgId") == 11 and r_mine.json().get("locked") is True
               and r_mine.json().get("scopeOrgId") == 11 and r_mine.json().get("scopeOrgName") == "华东分公司",
               f"out={r_out.status_code} in={r_in.status_code} 404={r_404.status_code} again={r_again.status_code} mine={r_mine.json()}")

        # I18 微信换取失败
        auth_service.code2session = lambda code: None
        n_before = q(lambda db: db.query(User).count())
        r_l = login(client, "bad-code")
        r_o = onboard(client, cap_code, wx_code="bad-code")
        record("I18", "code 换取失败：登录/入驻 502 且不建号",
               r_l.status_code == 502 and r_o.status_code == 502 and q(lambda db: db.query(User).count()) == n_before,
               f"login={r_l.status_code} onboard={r_o.status_code}")

        # I19 无/伪造 Token
        leaks = []
        for rt in protected:
            for method in rt.methods:
                for hdr in ({}, {"Authorization": "Bearer forged.token.value"}):
                    resp = call(client, method, rt.path, hdr)
                    if resp.status_code != 401:
                        leaks.append(f"{method} {rt.path} {resp.status_code}")
        record("I19", f"{len(protected)} 个用户受保护接口无/伪造 Token 均 401", not leaks, f"leaks={leaks[:5]}")

        # I20 普通用户 Token 访问管理接口
        admin_routes = [rt for rt in iter_routes([admin]) if depends_on(rt.dependant, deps.get_current_admin)]
        escalations = []
        for rt in admin_routes:
            for method in rt.methods:
                resp = call(client, method, rt.path, bearer(li_token))
                if resp.status_code not in (401, 403):
                    escalations.append(f"{method} {rt.path} {resp.status_code}")
        record("I20", f"{len(admin_routes)} 个管理接口拒绝普通用户 Token", admin_routes and not escalations,
               f"escalations={escalations[:5]}")

        # I21 管理端邀请码
        set_wx("", "")
        wechat_service._invite_image_cache.clear()
        r_anon = client.get("/api/admin/invites")
        r_create = client.post("/api/admin/invites", headers=ADMIN_H, json={
            "name": "第一批员工", "remark": "十月活动", "org_id": 11, "max_uses": 50,
            "expires_at": "2026-12-31T16:00:00Z"})
        inv = r_create.json() if r_create.status_code == 200 else {}
        r_bad_org = client.post("/api/admin/invites", headers=ADMIN_H, json={"name": "x", "org_id": 9999})
        r_list = client.get("/api/admin/invites?keyword=第一批", headers=ADMIN_H)
        r_patch = client.patch(f"/api/admin/invites/{inv.get('id')}", headers=ADMIN_H, json={"is_enabled": False})
        r_low = client.patch(f"/api/admin/invites/{cap_id}", headers=ADMIN_H, json={"max_uses": 2})
        r_null = client.patch(f"/api/admin/invites/{cap_id}", headers=ADMIN_H, json={"name": None})
        r_clear = client.patch(f"/api/admin/invites/{cap_id}", headers=ADMIN_H, json={"max_uses": None})
        r_404 = client.patch("/api/admin/invites/99999", headers=ADMIN_H, json={"is_enabled": True})
        r_qr = client.get(f"/api/admin/invites/{inv.get('id')}/qrcode", headers=ADMIN_H)
        qr = r_qr.json() if r_qr.status_code == 200 else {}
        stored = q(lambda db: db.query(InviteCode).filter(InviteCode.id == inv.get("id")).first())
        audits = q(lambda db: [a.action for a in db.query(AuditLog).filter(AuditLog.action.like("invite.%")).all()])
        record("I21", "管理端邀请码 CRUD/启停/小程序码/UTC 存储/审计",
               r_anon.status_code == 401 and r_create.status_code == 200 and len(inv.get("code", "")) == 16
               and inv.get("org_name") == "华东分公司" and inv.get("status") == "active"
               and r_bad_org.status_code == 400 and r_list.json().get("total") == 1
               and r_patch.json().get("status") == "disabled" and r_low.status_code == 400
               and r_null.status_code == 400 and r_clear.status_code == 200
               and r_clear.json()["max_uses"] is None and r_clear.json()["status"] == "active"
               and r_404.status_code == 404
               and qr.get("scene") == "i=" + inv.get("code", "") and qr.get("page") == "pages/launch/launch"
               and qr.get("mock") is True and stored is not None
               and stored.expires_at == datetime(2026, 12, 31, 16, 0, 0) and stored.created_by == "s19-admin"
               and audits.count("invite.create") == 1 and audits.count("invite.update") == 2,
               f"create={r_create.status_code} list={r_list.json().get('total')} low={r_low.json()} "
               f"qr={qr} expires={stored.expires_at if stored else None} audits={audits}")

        # I22 管理端用户状态
        def _menu_admin(db):
            menus = [AdminMenu(code=c, name=c, sort_order=i) for i, c in enumerate(["access", "invites", "dashboard"])]
            role = AdminRole(code="s19op", name="仅驾驶舱")
            db.add_all(menus + [role])
            db.flush()
            db.add(AdminRoleMenu(role_id=role.id, menu_id=menus[2].id))
            db.add(AdminUserRole(user_id=legacy_id, role_id=role.id, enabled=True))
            db.commit()
        q(_menu_admin)
        op_h = bearer(create_admin_token_for_user(legacy_id))
        r_forbid = client.patch(f"/api/admin/users/{uid_li}/status", headers=op_h, json={"status": "disabled"})
        r_forbid_inv = client.get("/api/admin/invites", headers=op_h)
        r_badstatus = client.patch(f"/api/admin/users/{uid_li}/status", headers=ADMIN_H, json={"status": "deleted"})
        r_nouser = client.patch("/api/admin/users/99999/status", headers=ADMIN_H, json={"status": "disabled"})
        client.patch(f"/api/admin/users/{uid_li}/status", headers=ADMIN_H, json={"status": "disabled"})
        r_users = client.get("/api/admin/users?status=disabled", headers=ADMIN_H)
        items = r_users.json().get("items", [])
        r_all = client.get("/api/admin/users?page_size=100", headers=ADMIN_H).json().get("items", [])
        legacy_item = next((x for x in r_all if x["id"] == legacy_id), {})
        status_audits = q(lambda db: [a.action for a in db.query(AuditLog).filter(
            AuditLog.target_user_id == uid_li, AuditLog.action.like("user.%able")).all()])
        client.patch(f"/api/admin/users/{uid_li}/status", headers=ADMIN_H, json={"status": "active"})
        record("I22", "用户状态：无 access 菜单 403、非法状态 422、用户不存在 404、列表含状态并可筛选、审计",
               r_forbid.status_code == 403 and r_forbid_inv.status_code == 403
               and r_badstatus.status_code == 422 and r_nouser.status_code == 404
               and [x["id"] for x in items] == [uid_li] and items[0]["status"] == "disabled"
               and items[0]["invite_name"] == "通用码" and items[0]["onboarded_at"]
               and legacy_item.get("invite_code_id") is None and legacy_item.get("status") == "active"
               and status_audits == ["user.disable", "user.enable", "user.disable"],
               f"forbid={r_forbid.status_code} items={[(x['id'], x['status'], x['invite_name']) for x in items]} audits={status_audits}")

        # I23 敏感信息
        set_wx("wx-s19-appid", "wx-s19-secret")
        sens_id, sens_code = make_invite(name="敏感检查码")
        wx_as("o_s19_sensitive")
        capture.lines.clear()
        r_v = client.post("/api/auth/invite/verify", json={"inviteCode": sens_code})
        r_o = onboard(client, sens_code, wx_code="WXCODE_SECRET_s19")
        r_l = login(client, "WXCODE_SECRET_s19")
        blob = r_v.text + r_o.text + r_l.text
        log_blob = "\n".join(capture.lines)
        secrets_ = [sens_code, "SK_SECRET_s19", "WXCODE_SECRET_s19", "o_s19_sensitive", "wx-s19-secret"]
        record("I23", "响应与日志不含 openid/session_key/wx code/邀请码/AppSecret",
               r_o.status_code == 200 and not any(s in blob for s in secrets_)
               and not any(s in log_blob for s in secrets_),
               f"resp_hits={[s for s in secrets_ if s in blob]} log_hits={[s for s in secrets_ if s in log_blob]} log_lines={len(capture.lines)}")

        # I24 本地测试开关
        set_wx("wx-s19-appid", "wx-s19-secret", allow_mock=True)
        auth_service.code2session = lambda code: None
        r = login(client, "s19-allow-mock")
        record("I24", "WX_LOGIN_ALLOW_MOCK=true 回退 mock openid 识别，未入驻不建号",
               r.status_code == 200 and r.json().get("status") == "unregistered"
               and users_with(auth_service._mock_openid("s19-allow-mock")) == 0, f"{r.status_code} {r.json()}")

        # I25 过期 Token
        now = datetime.now(timezone.utc)
        expired = jwt.encode({"sub": str(uid_li), "openid": "o_s19_new_0001", "iat": now - timedelta(days=8),
                              "exp": now - timedelta(minutes=1)}, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
        r_exp = client.get("/api/auth/me", headers=bearer(expired))
        wx_as("o_s19_new_0001")
        r_re = login(client)
        r_me = client.get("/api/auth/me", headers=bearer(r_re.json().get("token") or ""))
        record("I25", "过期 Token 401，重新登录 active 并复用同一用户",
               r_exp.status_code == 401 and r_re.json().get("status") == "active"
               and r_re.json()["user"]["id"] == uid_li and r_me.status_code == 200,
               f"expired={r_exp.status_code} relogin={r_re.json().get('status')} me={r_me.status_code}")
    finally:
        logging.getLogger().removeHandler(capture)
        auth_service.code2session = original_code2session
        set_wx(*original_wx)
        engine.dispose()

    passed = sum(1 for x in RESULTS if x["ok"])
    print(f"\n== S19 邀请码准入: {passed}/{len(RESULTS)} 通过 ==")
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s19-invite-admission-results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"results": RESULTS}, f, ensure_ascii=False, indent=2)
    if os.path.exists(_DB_PATH):
        os.remove(_DB_PATH)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
