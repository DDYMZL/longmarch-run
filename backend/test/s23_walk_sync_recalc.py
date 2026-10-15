# -*- coding: utf-8 -*-
"""S23 步数同步后累计步行积分全量重算回归（SQLite + TestClient）。

背景：步数同步/补步后必须按运动源数据全量修复该用户步行台账（recompute_walk），
保证累计步行积分 = 累计计分步数 // 1000（先汇总有效步数再整除，跨日零头可累计），
并修复历史「每日各自取整」遗留的错账，不依赖后端重启。

覆盖：
  R01 复现「累计 2611 步仅 1 分」并验证同步后修复为 2 分（个人中心/积分/明细一致）
  R02 跨日零碎步数累计（800+700+600+511=2611 → 2 分，逐日 0/1/1/0）
  R03 累计边界 999→0、1999→1、2000→2、3500→3（多次同步联动重算）
  R04 重复同步幂等不重复加分
  R05 历史步数下调跨越千步边界时积分随实际数据修正（允许下降）
  R06 部分日期缺失：不清零、不覆盖、保留原值并返回 failed_dates
  R07 无运动记录的残留 walk 台账行被清零
  R08 同步只修复本人台账，不影响其他用户
  R09 答题积分与 legacy 流水不受影响
  R10 个人中心 / 积分概览 / 积分明细 / 总积分榜四处步行积分一致

用法：cd backend && python test/s23_walk_sync_recalc.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_smoke_s23.db")
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)
os.environ["DATABASE_URL"] = "sqlite:///" + DB_PATH.replace("\\", "/")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

from app.core.database import Base, SessionLocal, engine
from app.core.helpers import recent_dates
from app.core.security import create_access_token
from app.main import app
from app.models.models import DailySport, PointsLog, User
from app.services import sport_service

RESULTS = []


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:400]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:240]) if detail else ""))


def make_user(db, suffix):
    user = User(openid="mock_s23_" + suffix, nickname="S23" + suffix)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def H(user):
    return {"Authorization": "Bearer " + create_access_token(user.id, user.openid)}


def walk_rows(uid):
    db = SessionLocal()
    try:
        return [(r.biz_key, r.delta) for r in db.query(PointsLog).filter(
            PointsLog.user_id == uid, PointsLog.source_type == "walk").order_by(PointsLog.biz_key)]
    finally:
        db.close()


def points_of(c, user):
    return c.get("/api/points", headers=H(user)).json()


def profile_of(c, user):
    return c.get("/api/profile/summary", headers=H(user)).json()


def sync_with(c, user, snapshot):
    sport_service._resolve_steps = lambda *args, **kwargs: dict(snapshot)
    return c.post("/api/sport/sync", headers=H(user)).json()


def seed_sports(db, uid, pairs):
    rows = [DailySport(user_id=uid, date=d, steps=s, distance=round(s * 0.00065, 2)) for d, s in pairs]
    db.add_all(rows)
    db.flush()
    by_date = {r.date: r for r in rows}
    db.commit()
    return by_date


def main():
    Base.metadata.create_all(engine)
    client = TestClient(app)
    db = SessionLocal()
    original_resolve = sport_service._resolve_steps
    days = recent_dates(7)
    d0, d1, d2, d3 = days[0], days[1], days[2], days[3]
    try:
        # ---------- R01 复现旧口径错账，同步即修复 ----------
        u1 = make_user(db, "r01")
        sports = seed_sports(db, u1.id, [(d0, 500), (d1, 500), (d2, 1611)])
        db.add(PointsLog(user_id=u1.id, date=d2, reason="步行积分", delta=1,
                         source_type="walk", ref_id=sports[d2].id, biz_key="walk:" + d2))
        db.add(PointsLog(user_id=u1.id, date=d2, reason="答题积分", delta=7,
                         source_type="quiz", biz_key="quiz:" + d2))
        db.commit()

        pts = points_of(client, u1)
        prof = profile_of(client, u1)
        record("R01", "复现 bug：累计 2611 步但步行积分仅 1 分（旧逐日取整台账）",
               pts["walk"] == 1 and prof["stats"]["totalSteps"] == 2611 and prof["points"]["walk"] == 1,
               f"points={pts} profile={prof['stats']}")

        out = sync_with(client, u1, {d0: 500, d1: 500, d2: 1611})
        pts = points_of(client, u1)
        prof = profile_of(client, u1)
        daily = client.get("/api/points/daily?page=1&page_size=100", headers=H(u1)).json()
        daily_walk = sum(i["walk"] for i in daily["items"])
        record("R02", "同步后全量修复：2611 步步行积分 2 分，答题积分保留",
               out["status"] == "partial" and out["pointsChange"] == 1 and out["processedDates"] == [d0, d1, d2]
               and pts["walk"] == 2 and pts["total"] == 9 and prof["points"]["walk"] == 2
               and prof["stats"]["totalSteps"] == 2611 and daily_walk == 2
               and sum(d for _k, d in walk_rows(u1.id)) == 2,
               f"out={out} pts={pts} dailyWalk={daily_walk} rows={walk_rows(u1.id)}")

        # ---------- R02 跨日零碎步数累计 ----------
        u2 = make_user(db, "r02")
        seed_sports(db, u2.id, [(d0, 800), (d1, 700), (d2, 600), (d3, 511)])
        out = sync_with(client, u2, {d0: 800, d1: 700, d2: 600, d3: 511})
        pts = points_of(client, u2)
        rows = walk_rows(u2.id)
        record("R03", "多天不足 1000 步跨日累计：800+700+600+511 → 2 分（逐日 0/1/1/0）",
               pts["walk"] == 2 and rows == [("walk:" + d1, 1), ("walk:" + d2, 1)]
               and pts["walkCarry"] == 611,
               f"walk={pts['walk']} carry={pts['walkCarry']} rows={rows}")

        # ---------- R03 累计边界 + 历史更新联动 ----------
        u3 = make_user(db, "r03")
        got = []
        for snap, want in [({d0: 999}, 0), ({d0: 999, d1: 1000}, 1),
                           ({d0: 999, d1: 1000, d2: 1}, 2), ({d0: 999, d1: 1000, d2: 1501}, 3)]:
            out = sync_with(client, u3, snap)
            w = points_of(client, u3)["walk"]
            got.append((w, out["pointsChange"]))
        record("R04", "累计边界 999→0、1999→1、2000→2、3500→3，每次同步联动重算",
               got == [(0, 0), (1, 1), (2, 1), (3, 1)], f"got={got}")

        # ---------- R04 重复同步幂等 ----------
        out = sync_with(client, u3, {d0: 999, d1: 1000, d2: 1501})
        record("R05", "同数据重复同步幂等不重复加分",
               out["synced"] is False and out["pointsChange"] == 0 and points_of(client, u3)["walk"] == 3,
               f"out={out}")

        # ---------- R05 历史下调跨千步边界，积分随实际数据修正 ----------
        out = sync_with(client, u3, {d0: 999, d1: 499, d2: 1501})
        w_down = points_of(client, u3)["walk"]
        record("R06", "历史步数下调至 2999 步积分修正为 2 分（允许按实际数据下降）",
               out["pointsChange"] == -1 and w_down == 2, f"change={out['pointsChange']} walk={w_down}")
        out = sync_with(client, u3, {d0: 999, d1: 500, d2: 1501})
        record("R07", "步数回升至 3000 步积分恢复为 3 分",
               out["pointsChange"] == 1 and points_of(client, u3)["walk"] == 3, f"change={out['pointsChange']}")

        # ---------- R06 部分日期缺失 ----------
        keep = 700
        out = sync_with(client, u2, {d0: 800, d2: 600, d3: 511})
        saved = db.query(DailySport.steps).filter(
            DailySport.user_id == u2.id, DailySport.date == d1).scalar()
        failed_dates = {f["date"]: f["reason"] for f in out["failedDates"]}
        record("R08", "同步部分日期失败：缺失日保留原值不清零、其他日正常、积分按实际数据重算",
               out["status"] == "partial" and d1 in failed_dates and len(failed_dates) == 4
               and saved == keep and points_of(client, u2)["walk"] == 2
               and profile_of(client, u2)["stats"]["totalSteps"] == 2611,
               f"failed={failed_dates} saved={saved}")

        # ---------- R07 残留行清零 ----------
        db.add(PointsLog(user_id=u2.id, date="2020-01-01", reason="步行积分", delta=9,
                         source_type="walk", biz_key="walk:2020-01-01"))
        db.commit()
        sync_with(client, u2, {d0: 800, d1: 700, d2: 600, d3: 511})
        rows = walk_rows(u2.id)
        stale = db.query(PointsLog.delta).filter(
            PointsLog.user_id == u2.id, PointsLog.biz_key == "walk:2020-01-01").scalar()
        record("R09", "无运动记录的残留 walk 台账行被清零且不计入总分",
               stale == 0 and sum(d for _k, d in rows) == 2 and points_of(client, u2)["walk"] == 2,
               f"stale={stale} rows={rows}")

        # ---------- R08 其他用户隔离 ----------
        u4 = make_user(db, "r04")
        seed_sports(db, u4.id, [(d0, 600), (d1, 600)])
        db.commit()
        before4 = walk_rows(u4.id)
        sync_with(client, u2, {d0: 800, d1: 700, d2: 600, d3: 511})
        record("R10", "同步只修复本人台账，不影响其他用户",
               walk_rows(u4.id) == before4 and points_of(client, u4)["walk"] == 0,
               f"u4 rows={walk_rows(u4.id)}")

        # ---------- R09 答题与 legacy 不受影响 ----------
        db.add(PointsLog(user_id=u2.id, date=d2, reason="旧规则积分", delta=99, source_type="legacy"))
        db.commit()
        sync_with(client, u2, {d0: 800, d1: 700, d2: 600, d3: 511})
        pts = points_of(client, u2)
        legacy = db.query(PointsLog.delta).filter(
            PointsLog.user_id == u2.id, PointsLog.source_type == "legacy").scalar()
        u1_pts = points_of(client, u1)
        record("R11", "答题/legacy 流水不受同步修复影响，total = walk + quiz",
               legacy == 99 and pts["total"] == pts["walk"] + pts["quiz"] and pts["walk"] == 2
               and u1_pts["quiz"] == 7 and u1_pts["walk"] == 2 and u1_pts["total"] == 9,
               f"pts={pts} u1={u1_pts} legacy={legacy}")

        # ---------- R10 跨端一致性 ----------
        pts = points_of(client, u2)
        prof = profile_of(client, u2)
        daily = client.get("/api/points/daily?page=1&page_size=100", headers=H(u2)).json()
        rank = client.get("/api/rank/points", headers=H(u2)).json()
        me = rank["me"]
        today = client.get("/api/sport/today", headers=H(u2)).json()
        record("R12", "个人中心/积分概览/积分明细/总积分榜四处步行积分一致",
               prof["points"]["walk"] == 2 and prof["stats"]["totalSteps"] == 2611
               and pts["walk"] == 2 and sum(i["walk"] for i in daily["items"]) == 2
               and me["walkPoints"] == 2 and me["points"] == pts["total"] and me["steps"] == 2611
               and pts["rank"] == me["rank"] and today["totalSteps"] == 2611,
               f"prof={prof['points']} pts={pts} me={me} today={today['totalSteps']}")

        # ---------- 刷新/重进模拟：重新请求接口仍正确 ----------
        pts2 = points_of(client, u2)
        prof2 = profile_of(client, u2)
        record("R13", "重新请求（模拟刷新/退出重进）积分仍为 2 分",
               pts2["walk"] == 2 and prof2["points"]["walk"] == 2 and prof2["stats"]["totalSteps"] == 2611,
               f"pts={pts2} prof={prof2['points']}")
    finally:
        sport_service._resolve_steps = original_resolve
        db.close()

    passed = sum(1 for r in RESULTS if r["ok"])
    print(f"\nS23 完成：{passed}/{len(RESULTS)} 通过")
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s23-walk-sync-recalc-results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"total": len(RESULTS), "passed": passed, "results": RESULTS}, f, ensure_ascii=False, indent=2)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
