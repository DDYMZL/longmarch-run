# -*- coding: utf-8 -*-
"""
S20 V2.0 活动窗口 / 积分台账 / 部门锁定 综合回归（TestClient + SQLite 临时库）

覆盖（限时答题见 s18）：
  活动窗口
    A01 未配置活动时不拦截（status=ongoing，写接口可用）
    A02 管理端保存开始不早于结束 400
    A03 未发布：写接口 403 + X-Activity-Status=unpublished，读接口可用
    A04 发布未开始：写接口 403 not_started（含答题开题、组织选择）
    A05 进行中：写接口放行
    A06 已结束：写 403 ended；allow_view_after_end=True 读放行，False 读也 403
    A07 关闭访问限制后已结束也放行
    A08 鉴权先于活动校验：无 Token 恒 401
    A09 保存/发布/撤回均写审计
  积分
    P01 步行积分边界 999/1000/1999/20000/25000 步 -> 0/1/1/20/20
    P02 多次补步累加只保留一行台账、按最终步数计分
    P03 重复同步幂等，不重复计分
    P04 微信运动重复同步取最大步数，往日按最终步数校正
    P05 答题积分：答对 4 题 8 分、5 题封顶 10，答错不扣分
    P06 总积分 = 步行 + 答题（概览/明细一致）
    P07 旧规则流水（legacy）不计入总积分
    P08 核对：篡改与多余行被检出，修复后无差异且写审计
  跨端一致
    C01 小程序总积分榜按积分降序，前 10 与管理端排名同序、积分一致
    C02 我的名次在 /points、/rank/points、个人档案三处一致
    C03 管理端人员详情与导出包含同口径积分
  部门锁定
    D01 首次选择组织成功并锁定，再次选择 403
    D02 已有组织（入驻确定）选择 403，/org/mine locked=true
    D03 8 并发首次选择不同组织，仅 1 个成功
    D04 管理员调整组织写审计（操作人、原/新组织），未变化不写审计
    D05 管理端调整：用户/组织不存在 404，用户 Token 无权调用

用法：cd backend && python test/s20_v2_regression.py
"""
import json
import os
import sys
import threading
from datetime import datetime, timedelta

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_smoke_v2_regression.db")
if os.path.exists(_DB_PATH):
    os.remove(_DB_PATH)
os.environ["DATABASE_URL"] = "sqlite:///" + _DB_PATH.replace("\\", "/")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.database import Base, SessionLocal, engine
from app.core.helpers import BEIJING_TZ, now_beijing, today_str
from app.core.security import create_access_token, create_admin_token
from app.main import app
from app.models.models import (
    ActivitySetting, AuditLog, DailySport, Organization, PointsLog, Question, User,
)
from app.services import points_service, sport_service

RESULTS = []


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def seed():
    db = SessionLocal()
    try:
        db.add_all([Organization(id=1, name="总部", level=1),
                    Organization(id=2, name="华东", parent_id=1, level=2),
                    Organization(id=3, name="华南", parent_id=1, level=2)])
        for i in range(1, 7):
            db.add(Question(id=i, type="single", question=f"S20 题目 {i}",
                            options=[{"label": "A", "text": "甲"}, {"label": "B", "text": "乙"}],
                            answer=["A"], analysis="解析", score=20, category="event"))
        users = [User(openid=f"mock_s20_{i}", nickname=f"S20用户{i}", status="active") for i in range(1, 14)]
        users.append(User(openid="mock_s20_locked", nickname="已入驻", status="active", org_id=2))
        db.add_all(users)
        db.commit()
        return [(u.id, u.openid) for u in users]
    finally:
        db.close()


def H(user):
    return {"Authorization": "Bearer " + create_access_token(*user)}


ADMIN = {"Authorization": "Bearer " + create_admin_token(settings.ADMIN_USERNAME)}


def bj(dt):
    return dt.strftime("%Y-%m-%dT%H:%M")


def run_parallel(fns):
    barrier = threading.Barrier(len(fns))
    out, lock = [], threading.Lock()

    def worker(fn):
        barrier.wait(timeout=10)
        resp = fn()
        with lock:
            out.append(resp)

    threads = [threading.Thread(target=worker, args=(fn,)) for fn in fns]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    return out


def walk_rows(uid):
    db = SessionLocal()
    try:
        return [(r.biz_key, r.delta) for r in db.query(PointsLog).filter(
            PointsLog.user_id == uid, PointsLog.source_type == "walk").order_by(PointsLog.biz_key)]
    finally:
        db.close()


def audits(action):
    db = SessionLocal()
    try:
        return [json.loads(a.detail) if isinstance(a.detail, str) else a.detail
                for a in db.query(AuditLog).filter(AuditLog.action == action).order_by(AuditLog.id)]
    finally:
        db.close()


def play_quiz(client, user, correct):
    """按顺序作答当日全部题目，前 correct 题答对。"""
    res = None
    for i in range(5):
        q = client.post("/api/quiz/start", headers=H(user)).json()["current"]["question"]
        res = client.post("/api/quiz/answer", headers=H(user),
                          json={"questionId": q["id"], "answer": ["A" if i < correct else "B"]}).json()
    return res


def activity_cases(c, users):
    u = users[0]
    now = now_beijing().replace(tzinfo=None)

    def save(start, end, **extra):
        body = {"name": "长征步迹·荣耀征程", "start_at": bj(start), "end_at": bj(end),
                "restrict_enabled": True, "allow_view_after_end": True, **extra}
        return c.put("/api/admin/activity", headers=ADMIN, json=body)

    def write():
        return c.post("/api/sport/add", headers=H(u), json={"delta": 100})

    def read():
        return c.get("/api/points", headers=H(u))

    st = c.get("/api/activity/status").json()
    w = write()
    record("A01", "未配置活动不拦截", st["status"] == "ongoing" and st["allowParticipate"] and w.status_code == 200,
           f"status={st['status']} write={w.status_code}")

    r = save(now, now - timedelta(minutes=1))
    record("A02", "开始不早于结束 400", r.status_code == 400 and "早于" in r.json()["detail"], r.text[:120])

    save(now + timedelta(days=1), now + timedelta(days=2))
    w, rd = write(), read()
    record("A03", "未发布：写 403 unpublished，读放行",
           w.status_code == 403 and w.headers.get("X-Activity-Status") == "unpublished" and rd.status_code == 200,
           f"write={w.status_code}/{w.headers.get('X-Activity-Status')} read={rd.status_code}")

    c.post("/api/admin/activity/publish", headers=ADMIN, json={"published": True})
    codes = [write(), c.post("/api/quiz/start", headers=H(u)),
             c.post("/api/org/select", headers=H(u), json={"orgId": 2})]
    st = c.get("/api/activity/status").json()
    record("A04", "未开始：同步/开题/选组织均 403 not_started",
           st["status"] == "not_started" and all(x.status_code == 403 for x in codes)
           and {x.headers.get("X-Activity-Status") for x in codes} == {"not_started"},
           f"status={st['status']} codes={[x.status_code for x in codes]}")

    save(now - timedelta(days=1), now + timedelta(days=1))
    w = write()
    record("A05", "进行中放行", c.get("/api/activity/status").json()["status"] == "ongoing" and w.status_code == 200,
           f"write={w.status_code}")

    save(now - timedelta(days=2), now - timedelta(days=1))
    w, rd = write(), read()
    save(now - timedelta(days=2), now - timedelta(days=1), allow_view_after_end=False)
    rd2 = read()
    record("A06", "已结束：写 403，读按 allow_view_after_end 放行/拒绝",
           w.status_code == 403 and w.headers.get("X-Activity-Status") == "ended" and rd.status_code == 200
           and rd2.status_code == 403 and rd2.headers.get("X-Activity-Status") == "ended",
           f"write={w.status_code} read={rd.status_code} read_closed={rd2.status_code}")

    save(now - timedelta(days=2), now - timedelta(days=1), restrict_enabled=False)
    w = write()
    record("A07", "关闭访问限制后放行", w.status_code == 200, f"write={w.status_code}")

    save(now - timedelta(days=2), now - timedelta(days=1))
    codes = [c.post("/api/sport/add", json={"delta": 1}).status_code, c.get("/api/points").status_code]
    record("A08", "无 Token 恒 401", codes == [401, 401], f"codes={codes}")

    c.post("/api/admin/activity/publish", headers=ADMIN, json={"published": False})
    upd, pub, unpub = audits("activity.update"), audits("activity.publish"), audits("activity.unpublish")
    record("A09", "保存/发布/撤回写审计",
           len(upd) == 6 and len(pub) == 1 and len(unpub) == 1 and upd[-1]["operator"] == settings.ADMIN_USERNAME
           and "before" in upd[-1] and "after" in upd[-1],
           f"update={len(upd)} publish={len(pub)} unpublish={len(unpub)}")

    db = SessionLocal()
    try:
        db.query(ActivitySetting).delete()
        db.query(DailySport).delete()
        db.query(PointsLog).delete()
        db.commit()
    finally:
        db.close()


def points_cases(c, users):
    u1, u2, u3, u4, u5 = users[1:6]
    db = SessionLocal()
    try:
        got = []
        for steps, want in [(999, 0), (1000, 1), (1999, 1), (20000, 20), (25000, 20)]:
            db.query(PointsLog).filter(PointsLog.user_id == u1[0]).delete()
            db.query(DailySport).filter(DailySport.user_id == u1[0]).delete()
            db.commit()
            sport_service.add_steps(db, u1[0], steps)
            p = c.get("/api/points", headers=H(u1)).json()
            got.append((steps, p["walk"], p["todayWalk"], want))
        record("P01", "步行积分边界", all(w == want and t == want for _, w, t, want in got) and
               points_service.walk_points(-5) == 0, f"got={got}")
        db.query(PointsLog).filter(PointsLog.user_id == u1[0]).delete()
        db.query(DailySport).filter(DailySport.user_id == u1[0]).delete()
        db.commit()
    finally:
        db.close()

    for _ in range(5):
        c.post("/api/sport/add", headers=H(u1), json={"delta": 1500})
    p = c.get("/api/points", headers=H(u1)).json()
    record("P02", "多次补步只保留一行、按最终步数计分",
           p["walk"] == 7 and walk_rows(u1[0]) == [("walk:" + today_str(), 7)], f"walk={p['walk']} rows={walk_rows(u1[0])}")

    outs = [c.post("/api/sport/sync", headers=H(u2), json={}).json() for _ in range(3)]
    rows = walk_rows(u2[0])
    steps = outs[-1]["steps"]
    record("P03", "重复同步幂等",
           len(rows) == 1 and rows[0][1] == min(steps, 20000) // 1000 and len({o["steps"] for o in outs}) == 1,
           f"steps={steps} rows={rows}")

    # 微信运动真实链路：替换解密，模拟同日步数回落与往日校正
    today = today_str()
    yday = (now_beijing() - timedelta(days=1)).strftime("%Y-%m-%d")
    db = SessionLocal()
    try:
        db.add(DailySport(user_id=u3[0], date=yday, steps=3000))
        db.commit()
    finally:
        db.close()

    def ts(day):
        return int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=BEIJING_TZ).timestamp())

    current = {}
    orig = (settings.WX_APPID, settings.WX_SECRET, sport_service.code2session, sport_service.decrypt_werun)
    settings.WX_APPID, settings.WX_SECRET = "s20_appid", "s20_secret"
    sport_service.code2session = lambda code: {"session_key": "k"}
    sport_service.decrypt_werun = lambda k, e, iv: {
        "stepInfoList": [{"timestamp": ts(d), "step": s} for d, s in current.items()]}
    try:
        outs = []
        for snapshot in ({today: 4200, yday: 8800}, {today: 12345, yday: 8800}, {today: 9000, yday: 8800}):
            current = snapshot
            outs.append(c.post("/api/sport/sync", headers=H(u3),
                               json={"code": "c", "encryptedData": "e", "iv": "i"}).json())
    finally:
        settings.WX_APPID, settings.WX_SECRET, sport_service.code2session, sport_service.decrypt_werun = orig
    p = c.get("/api/points", headers=H(u3)).json()
    record("P04", "重复同步取最大步数，往日按最终步数校正",
           [o.get("steps") for o in outs] == [4200, 12345, 12345] and p["todayWalk"] == 12 and p["walk"] == 20,
           f"steps={[o.get('steps') for o in outs]} walk={p['walk']}/{p['todayWalk']}")

    r4 = play_quiz(c, u4, 4)
    r5 = play_quiz(c, u5, 5)
    r0 = play_quiz(c, u1, 0)
    pts = [c.get("/api/points", headers=H(u)).json()["quiz"] for u in (u4, u5, u1)]
    record("P05", "答题积分：4 对 8 分、5 对封顶 10、全错 0 不扣分",
           r4["record"]["points"] == 8 and r5["record"]["points"] == 10 and r0["record"]["points"] == 0
           and pts == [8, 10, 0] and points_service.quiz_points(6) == 10,
           f"record={[r4['record']['points'], r5['record']['points'], r0['record']['points']]} ledger={pts}")

    p = c.get("/api/points", headers=H(u1)).json()
    d = c.get("/api/points/daily", headers=H(u1)).json()["items"][0]
    record("P06", "总积分 = 步行 + 答题（概览与明细一致）",
           p["total"] == p["walk"] + p["quiz"] == 7 and d["total"] == d["walk"] + d["quiz"] == 7 and d["steps"] == 7500,
           f"summary={p['total']}={p['walk']}+{p['quiz']} daily={d}")

    db = SessionLocal()
    try:
        db.add(PointsLog(user_id=u2[0], date=today, reason="每日登录", delta=50))
        db.commit()
    finally:
        db.close()
    p = c.get("/api/points", headers=H(u2)).json()
    record("P07", "legacy 流水不计入", p["total"] == walk_rows(u2[0])[0][1], f"total={p['total']}")

    db = SessionLocal()
    try:
        db.query(PointsLog).filter(PointsLog.user_id == u3[0], PointsLog.biz_key == "walk:" + today) \
            .update({PointsLog.delta: 99})
        db.add(PointsLog(user_id=u1[0], date="2026-01-01", reason="步行积分", delta=5, source_type="walk",
                         biz_key="walk:2026-01-01"))
        db.commit()
    finally:
        db.close()
    v1 = c.post("/api/admin/points/verify", headers=ADMIN, json={}).json()
    v2 = c.post("/api/admin/points/verify", headers=ADMIN, json={"fix": True}).json()
    v3 = c.post("/api/admin/points/verify", headers=ADMIN, json={}).json()
    p = c.get("/api/points", headers=H(u3)).json()
    record("P08", "核对检出 2 处差异，修复后无差异并写审计",
           v1["mismatches"] == 2 and v2["fixed"] == 2 and v3["mismatches"] == 0 and p["todayWalk"] == 12
           and len(audits("points.recompute")) >= 1,
           f"verify={v1['mismatches']} fixed={v2['fixed']} after={v3['mismatches']}")


def consistency_cases(c, users):
    me = users[3]
    rk = c.get("/api/rank/points", headers=H(me)).json()
    ar = c.get("/api/admin/rankings", headers=ADMIN, params={"page_size": 10}).json()
    top = [(x["userId"], x["points"]) for x in rk["top"]]
    admin_top = [(x["user_id"], x["total_points"]) for x in ar["items"][:10]]
    pts = [p for _, p in top]
    record("C01", "总积分榜降序，前 10 与管理端同序同分",
           pts == sorted(pts, reverse=True) and top == admin_top
           and [x["user_id"] for x in ar["podium"]] == [u for u, _ in top],
           f"mini={top[:5]} admin={admin_top[:5]}")

    p = c.get("/api/points", headers=H(me)).json()
    prof = c.get("/api/profile/summary", headers=H(me)).json()["points"]
    record("C02", "我的名次与积分三处一致",
           p["rank"] == rk["me"]["rank"] == prof["rank"] and p["total"] == prof["total"] == rk["me"]["points"]
           and rk["me"]["isMe"], f"points={p['rank']}/{p['total']} rank={rk['me']} profile={prof}")

    ov = c.get(f"/api/admin/users/{me[0]}/overview", headers=ADMIN).json()["points"]
    csv_head = c.get("/api/admin/rankings/export", headers=ADMIN).text.splitlines()[0]
    record("C03", "管理端人员详情与导出同口径积分",
           ov["total"] == p["total"] and ov["walk"] == p["walk"] and ov["quiz"] == p["quiz"]
           and all(k in csv_head for k in ("总积分", "步行积分", "答题积分")),
           f"overview={ov} csv={csv_head[:80]}")


def org_cases(c, users):
    fresh, racer, locked = users[6], users[7], users[-1]
    r1 = c.post("/api/org/select", headers=H(fresh), json={"orgId": 2})
    r2 = c.post("/api/org/select", headers=H(fresh), json={"orgId": 3})
    record("D01", "首次选择成功并锁定，再次选择 403",
           r1.status_code == 200 and r1.json()["locked"] is True and r2.status_code == 403
           and "锁定" in r2.json()["detail"], f"first={r1.status_code} second={r2.status_code}")

    r = c.post("/api/org/select", headers=H(locked), json={"orgId": 3})
    mine = c.get("/api/org/mine", headers=H(locked)).json()
    record("D02", "已入驻用户选择 403，mine.locked=true",
           r.status_code == 403 and mine["locked"] is True and mine["orgId"] == 2, f"select={r.status_code} mine={mine}")

    resps = run_parallel([
        (lambda oid: lambda: c.post("/api/org/select", headers=H(racer), json={"orgId": oid}))(1 + i % 3)
        for i in range(8)
    ])
    codes = sorted(x.status_code for x in resps)
    record("D03", "8 并发首次选择仅 1 成功", codes.count(200) == 1 and codes.count(403) == 7, f"codes={codes}")

    r = c.put(f"/api/admin/users/{locked[0]}/org", headers=ADMIN, json={"org_id": 3})
    same = c.put(f"/api/admin/users/{locked[0]}/org", headers=ADMIN, json={"org_id": 3})
    mine = c.get("/api/org/mine", headers=H(locked)).json()
    logs = audits("user.org_change")
    record("D04", "管理员调整写审计（操作人/原/新组织），未变化不写",
           r.status_code == 200 and same.json()["message"] == "组织未变化" and mine["orgId"] == 3 and len(logs) == 1
           and logs[0]["operator"] == settings.ADMIN_USERNAME and logs[0]["before_org_name"] == "总部 / 华东"
           and logs[0]["after_org_name"] == "总部 / 华南",
           f"status={r.status_code} logs={logs}")

    codes = [c.put("/api/admin/users/99999/org", headers=ADMIN, json={"org_id": 2}).status_code,
             c.put(f"/api/admin/users/{locked[0]}/org", headers=ADMIN, json={"org_id": 999}).status_code,
             c.put(f"/api/admin/users/{locked[0]}/org", headers=H(fresh), json={"org_id": 2}).status_code]
    record("D05", "不存在 404，用户 Token 无权", codes[:2] == [404, 404] and codes[2] in (401, 403), f"codes={codes}")


def main():
    Base.metadata.create_all(engine)
    users = seed()
    client = TestClient(app)
    try:
        activity_cases(client, users)
        points_cases(client, users)
        consistency_cases(client, users)
        org_cases(client, users)
    finally:
        engine.dispose()

    passed = sum(1 for x in RESULTS if x["ok"])
    print(f"\n== S20 V2.0 综合回归: {passed}/{len(RESULTS)} 通过 ==")
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s20-v2-regression-results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"results": RESULTS}, f, ensure_ascii=False, indent=2)
    if os.path.exists(_DB_PATH):
        os.remove(_DB_PATH)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
