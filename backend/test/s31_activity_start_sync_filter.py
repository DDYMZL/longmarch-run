# -*- coding: utf-8 -*-
"""S31 步数同步按 PC 端活动开始日过滤回归（SQLite + TestClient）。

背景：此前 /sport/sync 固定同步最近 7 个北京时间自然日，不感知活动开始时间，
活动开始前（如 9 月）的数据也会被写入并计入累计步数/积分。
修复后：同步窗口再按 PC 端（管理后台 activity_settings.start_at，北京时间）过滤，
开始日之前的日期不写入、不标记失败；未配置活动时间时保持原行为（不过滤）。
仅拦截新同步，不追溯/改动历史存量数据。

覆盖：
  A01 未配置活动时间（无 activity_settings 行）→ 同步写入最近 7 日（存量行为不变）
  A02 活动开始日为 3 天前 → 只写开始日之后的 4 天，累计步数按 4 天计
  A03 开始日之前的日期 → 不入库、不进入 failed_dates
  A04 同日重复同步 → 幂等，仍为 4 天且步数不变
  A05 活动开始日为明天（未开始，关闭限制放行准入）→ 一个日期都不写、不标记失败

用法：cd backend && python test/s31_activity_start_sync_filter.py
"""
import json
import os
import sys
from datetime import datetime, timedelta

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_smoke_s31.db")
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)
os.environ["DATABASE_URL"] = "sqlite:///" + DB_PATH.replace("\\", "/")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient

from app.core.database import Base, SessionLocal, engine
from app.core.helpers import local_to_utc, recent_dates
from app.core.security import create_access_token
from app.main import app
from app.models.models import ActivitySetting, DailySport, User
from app.services import sport_service

RESULTS = []


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:400]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:240]) if detail else ""))


def make_user(db, suffix):
    user = User(openid="mock_s31_" + suffix, nickname="S31" + suffix)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def H(user):
    return {"Authorization": "Bearer " + create_access_token(user.id, user.openid)}


def sport_dates(uid):
    db = SessionLocal()
    try:
        rows = db.query(DailySport.date).filter(DailySport.user_id == uid).order_by(DailySport.date).all()
        return [r[0] for r in rows]
    finally:
        db.close()


def bj_midnight(date_str):
    """YYYY-MM-DD → 北京时间当日 00:00（库内 UTC naive）。"""
    return local_to_utc(datetime.strptime(date_str + " 00:00:00", "%Y-%m-%d %H:%M:%S"))


def shift(date_str, days):
    """YYYY-MM-DD 偏移若干天。"""
    return (datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def upsert_setting(start_date, end_date, published=True, restrict=True):
    """写入/更新 activity_settings 单行（id=1）。"""
    db = SessionLocal()
    try:
        row = db.query(ActivitySetting).filter(ActivitySetting.id == 1).first()
        if row is None:
            row = ActivitySetting(id=1, name="S31活动")
            db.add(row)
        row.name = "S31活动"
        row.start_at = bj_midnight(start_date)
        row.end_at = bj_midnight(end_date)
        row.is_published = published
        row.restrict_enabled = restrict
        row.allow_view_after_end = True
        db.commit()
    finally:
        db.close()


def main():
    Base.metadata.create_all(engine)
    client = TestClient(app)
    db = SessionLocal()
    days = recent_dates(7)
    d0, d1, d2, d3, d4, d5, d6 = days
    next_day = shift(d6, 1)
    snapshot = {d: 1000 for d in days}
    original_resolve = sport_service._resolve_steps
    try:
        # 全程按固定快照返回 7 日步数，聚焦活动开始日过滤逻辑
        sport_service._resolve_steps = lambda *args, **kwargs: dict(snapshot)

        # ---------- A01 未配置活动时间：最近 7 日全部入账（存量行为不变） ----------
        u1 = make_user(db, "a01")
        r1 = client.post("/api/sport/sync", headers=H(u1))
        b1 = r1.json()
        dates1 = sport_dates(u1.id)
        record("A01", "未配置活动时间：同步写入最近 7 日（存量行为不变）",
               r1.status_code == 200 and dates1 == days and b1.get("totalSteps") == 7000
               and b1.get("processedDates") == days and b1.get("failedDates") == [],
               f"status={r1.status_code} dates={dates1} totalSteps={b1.get('totalSteps')}")

        # ---------- A02 开始日为 3 天前：只写开始日之后，开始日前不写不入失败清单 ----------
        upsert_setting(d3, next_day)  # start=d3 00:00，end=明天 00:00 → ongoing，准入放行
        u2 = make_user(db, "a02")
        r2 = client.post("/api/sport/sync", headers=H(u2))
        b2 = r2.json()
        dates2 = sport_dates(u2.id)
        expect2 = [d3, d4, d5, d6]
        record("A02", "开始日为 3 天前：仅写入开始日之后的日期",
               r2.status_code == 200 and dates2 == expect2 and b2.get("processedDates") == expect2
               and b2.get("totalSteps") == 4000,
               f"status={r2.status_code} dates={dates2} processed={b2.get('processedDates')}")
        record("A03", "开始日之前的日期不写入、不进入 failed_dates",
               all(d not in dates2 for d in (d0, d1, d2)) and b2.get("failedDates") == [],
               f"failedDates={b2.get('failedDates')}")

        # ---------- A04 同日重复同步：幂等，仍为 4 天且步数不变 ----------
        r4 = client.post("/api/sport/sync", headers=H(u2))
        b4 = r4.json()
        dates4 = sport_dates(u2.id)
        record("A04", "同日重复同步幂等：仍为开始日后 4 天且步数不变",
               r4.status_code == 200 and dates4 == expect2 and b4.get("synced") is False
               and b4.get("totalSteps") == 4000,
               f"dates={dates4} synced={b4.get('synced')}")

        # ---------- A05 开始日为明天（未开始，关闭限制放行准入）：一个日期都不写 ----------
        upsert_setting(next_day, shift(next_day, 10), published=True, restrict=False)
        u5 = make_user(db, "a05")
        r5 = client.post("/api/sport/sync", headers=H(u5))
        b5 = r5.json()
        dates5 = sport_dates(u5.id)
        record("A05", "活动未开始：不写任何日期、不标记失败、返回 success",
               r5.status_code == 200 and dates5 == [] and b5.get("processedDates") == []
               and b5.get("failedDates") == [] and b5.get("status") == "success",
               f"status={r5.status_code} dates={dates5} resp_status={b5.get('status')}")
    finally:
        sport_service._resolve_steps = original_resolve
        db.close()

    passed = sum(1 for x in RESULTS if x["ok"])
    print(f"\n== S31 步数同步按活动开始日过滤: {passed}/{len(RESULTS)} 通过 ==")
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s31-activity-start-sync-filter-results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"results": RESULTS}, f, ensure_ascii=False, indent=2)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
