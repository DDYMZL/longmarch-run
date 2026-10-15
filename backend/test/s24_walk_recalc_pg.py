# -*- coding: utf-8 -*-
"""
S24-PG 步数同步后步行台账全量修复 真实 openGauss 验证（使用 backend/.env 的 DATABASE_URL）

SQLite 验证已覆盖逻辑，本脚本在真实库上验证同步链路与数据库方言下行为一致：
  P01 旧「逐日取整」错账（2611 步仅 1 分）同步后修复为 2 分（个人中心/积分/明细一致）
  P02 同数据重复同步幂等不重复加分
  P03 历史步数更新后累计与积分联动重算
  P04 部分日期缺失：保留原值不清零、failed_dates 可重试
  P05 总积分榜/个人中心/积分概览/积分明细四处口径一致
测试数据 openid 前缀 o_s24pg_，结束后（含失败）全部清理。

用法：cd backend && python test/s24_walk_recalc_pg.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.helpers import recent_dates
from app.core.security import create_access_token
from app.main import app
from app.models.models import DailySport, PointsLog, User
from app.services import sport_service

RESULTS = []
PREFIX = "o_s24pg_"


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:400]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:240]) if detail else ""))


def cleanup(openid):
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.openid == openid).first()
        if user is None:
            return
        for table in ["user_medals", "points_log", "daily_sport", "user_event", "lit_nodes",
                      "daily_questions", "quiz_answers", "quiz_records"]:
            model = {c.name: c for c in User.__table__.metadata.tables.values()}.get(table)
            if model is None:
                continue
            db.execute(model.delete().where(model.c.user_id == user.id))
        db.delete(user)
        db.commit()
    finally:
        db.close()


def main():
    if not settings.DATABASE_URL.startswith("postgresql"):
        print("SKIP DATABASE_URL 不是 PostgreSQL/openGauss（当前：%s）" % settings.DATABASE_URL.split("://", 1)[0])
        return 0
    db = SessionLocal()
    original_resolve = sport_service._resolve_steps
    openid = PREFIX + "walk"
    user = None
    try:
        user = User(openid=openid, nickname="S24PG临时验证")
        db.add(user)
        db.commit()
        db.refresh(user)
        days = recent_dates(7)
        d0, d1, d2, d3 = days[0], days[1], days[2], days[3]
        rows = [DailySport(user_id=user.id, date=d, steps=s, distance=round(s * 0.00065, 2))
                for d, s in [(d0, 800), (d1, 700), (d2, 600), (d3, 511)]]
        db.add_all(rows)
        db.flush()
        db.add(PointsLog(user_id=user.id, date=d2, reason="步行积分", delta=1,
                         source_type="walk", ref_id=rows[2].id, biz_key="walk:" + d2))
        db.commit()

        client = TestClient(app)
        token = {"Authorization": "Bearer " + create_access_token(user.id, openid)}
        before = client.get("/api/points", headers=token).json()
        prof = client.get("/api/profile/summary", headers=token).json()
        record("P01", "复现：真实库旧口径台账 2611 步仅 1 分",
               before["walk"] == 1 and prof["stats"]["totalSteps"] == 2611,
               f"points={before['walk']} steps={prof['stats']['totalSteps']}")

        sport_service._resolve_steps = lambda *a, **k: {d0: 800, d1: 700, d2: 600, d3: 511}
        out = client.post("/api/sport/sync", headers=token).json()
        pts = client.get("/api/points", headers=token).json()
        prof = client.get("/api/profile/summary", headers=token).json()
        daily = client.get("/api/points/daily?page=1&page_size=100", headers=token).json()
        record("P02", "同步后全量修复为 2 分，个人中心/积分/明细一致",
               out["pointsChange"] == 1 and pts["walk"] == 2 and prof["points"]["walk"] == 2
               and prof["stats"]["totalSteps"] == 2611 and sum(i["walk"] for i in daily["items"]) == 2,
               f"change={out['pointsChange']} pts={pts['walk']} prof={prof['points']['walk']}")

        out = client.post("/api/sport/sync", headers=token).json()
        record("P03", "同数据重复同步幂等不重复加分",
               out["pointsChange"] == 0 and client.get("/api/points", headers=token).json()["walk"] == 2,
               f"change={out['pointsChange']}")

        sport_service._resolve_steps = lambda *a, **k: {d0: 800, d1: 900, d2: 600, d3: 511}
        out = client.post("/api/sport/sync", headers=token).json()
        record("P04", "历史步数 700→900 后累计 2811 仍为 2 分且已按源数据重算",
               out["pointsChange"] == 0 and client.get("/api/points", headers=token).json()["walk"] == 2
               and client.get("/api/profile/summary", headers=token).json()["stats"]["totalSteps"] == 2811,
               f"change={out['pointsChange']}")

        sport_service._resolve_steps = lambda *a, **k: {d0: 800, d2: 600, d3: 511}
        out = client.post("/api/sport/sync", headers=token).json()
        saved = db.query(DailySport.steps).filter(
            DailySport.user_id == user.id, DailySport.date == d1).scalar()
        record("P05", "部分日期缺失：保留原值、返回 failed_dates、积分按实际数据重算",
               out["status"] == "partial" and d1 in [f["date"] for f in out["failedDates"]]
               and saved == 900 and client.get("/api/points", headers=token).json()["walk"] == 2,
               f"failed={out['failedDates']} saved={saved}")

        pts = client.get("/api/points", headers=token).json()
        rank = client.get("/api/rank/points", headers=token).json()
        record("P06", "总积分榜与积分概览同口径（walkPoints 一致）",
               rank["me"]["walkPoints"] == pts["walk"] and rank["me"]["points"] == pts["total"],
               f"me={rank['me']} pts={pts}")
    finally:
        sport_service._resolve_steps = original_resolve
        db.close()
        cleanup(openid)

    passed = sum(1 for r in RESULTS if r["ok"])
    print(f"\nS24-PG 完成：{passed}/{len(RESULTS)} 通过")
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s24-walk-recalc-pg-results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"total": len(RESULTS), "passed": passed, "results": RESULTS}, f, ensure_ascii=False, indent=2)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
