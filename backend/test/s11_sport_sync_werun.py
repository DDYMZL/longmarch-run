# -*- coding: utf-8 -*-
"""
S11 步数同步真实数据链路 冒烟脚本（TestClient，不依赖 8010 端口残留进程）

背景：此前 /sport/sync 前端不带数据、后端一律按「日期+用户」伪随机生成 4000~12999
假步数，用户真实步数被覆盖为编造值。修复后：
  - 前端 wx.getWeRunData 加密数据 + wx.login code 上送，后端解密取当日真实步数；
  - 仅 mock 登录用户（开发模式）或未配置微信凭证时回退 seeded 模拟；
  - 真实用户无数据/解密失败一律 400，绝不写入编造步数。

覆盖：
  W01 mock 用户无 payload 同步 → 200 且步数 4000~12999（开发模拟回归）
  W02 同日重复同步 → synced=False 且步数不变
  W03 真实 openid 用户无 payload：已配置凭证 → 400；未配置 → 200 模拟
  W04 真实用户携带伪造加密数据 → 400 且 DB 无当日记录（绝不写假数据）
  W05 decrypt_werun 加解密往返一致（watermark.appid 匹配）
  W06 watermark.appid 不匹配 → ValueError
  W07 解密数据中缺少当日步数 → ValueError（经 _resolve_steps 直接验证，不触网）

用法：cd backend && python test/s11_sport_sync_werun.py
"""
import base64
import hashlib
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from Crypto.Cipher import AES
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.security import create_access_token
from app.core.wx import decrypt_werun
from app.main import app
from app.models.models import DailySport, LitNode, PointsLog, QuizRecord, User, UserEvent, UserMedal
from app.services import sport_service

RESULTS = []
SMOKE_PREFIX = "s11-werun-sync"


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def smoke_openid(tag, prefix="mock_"):
    return prefix + hashlib.md5((SMOKE_PREFIX + "-" + tag).encode("utf-8")).hexdigest()[:24]


def make_user(openid):
    db = SessionLocal()
    try:
        user = User(openid=openid, nickname="S11冒烟", original_nickname="S11冒烟")
        db.add(user)
        db.commit()
        db.refresh(user)
        return user.id
    finally:
        db.close()


def cleanup(user_ids):
    """清理冒烟用户与其业务数据（含积分/事件/勋章等关联行），保证可重复执行。"""
    db = SessionLocal()
    try:
        for model in (PointsLog, DailySport, LitNode, UserMedal, QuizRecord, UserEvent):
            db.query(model).filter(model.user_id.in_(user_ids)).delete(synchronize_session=False)
        db.query(User).filter(User.id.in_(user_ids)).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def encrypt_werun(session_key_b64, iv_b64, payload):
    """按微信规范构造加密运动数据（AES-128-CBC + PKCS7）。"""
    key = base64.b64decode(session_key_b64)
    iv = base64.b64decode(iv_b64)
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    pad = 16 - (len(raw) % 16)
    raw = raw + bytes([pad]) * pad
    return base64.b64encode(AES.new(key, AES.MODE_CBC, iv).encrypt(raw)).decode("utf-8")


def main():
    client = TestClient(app)
    mock_uid = make_user(smoke_openid("u1"))
    real_uid = make_user(smoke_openid("u2", prefix="real_"))
    ids = [mock_uid, real_uid]
    has_creds = bool(settings.WX_APPID and settings.WX_SECRET)
    try:
        mock_headers = {"Authorization": "Bearer " + create_access_token(mock_uid, smoke_openid("u1"))}
        real_headers = {"Authorization": "Bearer " + create_access_token(real_uid, smoke_openid("u2", prefix="real_"))}

        # W01 mock 用户无 payload → 开发模拟
        r = client.post("/api/sport/sync", headers=mock_headers)
        body = r.json() if r.status_code == 200 else {}
        steps = body.get("steps", -1)
        record("W01", "mock 用户无 payload 同步走开发模拟", r.status_code == 200 and 4000 <= steps <= 12999,
               f"status={r.status_code} steps={steps}")

        # W02 同日重复同步 → synced=False 且不变
        r2 = client.post("/api/sport/sync", headers=mock_headers)
        body2 = r2.json() if r2.status_code == 200 else {}
        record("W02", "同日重复同步 synced=False 且步数不变",
               r2.status_code == 200 and body2.get("synced") is False and body2.get("steps") == steps,
               f"steps={body2.get('steps')} synced={body2.get('synced')}")

        # W03 真实用户无 payload：按是否配置凭证分支断言
        r3 = client.post("/api/sport/sync", headers=real_headers)
        if has_creds:
            db = SessionLocal()
            try:
                rows = db.query(DailySport).filter(DailySport.user_id == real_uid).count()
            finally:
                db.close()
            record("W03", "已配置凭证：真实用户无 payload 拒绝且不写库", r3.status_code == 400 and rows == 0,
                   f"status={r3.status_code} detail={r3.json().get('detail')} rows={rows}")
        else:
            record("W03", "未配置凭证：真实用户无 payload 回退开发模拟",
                   r3.status_code == 200 and 4000 <= r3.json().get("steps", -1) <= 12999,
                   f"status={r3.status_code} steps={r3.json().get('steps')}")

        # W04 真实用户携带伪造加密数据 → 400 且 DB 无当日记录
        r4 = client.post("/api/sport/sync", headers=real_headers,
                         json={"code": "fake-code", "encryptedData": "ZmFrZQ==", "iv": "ZmFrZS1pdg=="})
        db = SessionLocal()
        try:
            rows4 = db.query(DailySport).filter(DailySport.user_id == real_uid).count()
        finally:
            db.close()
        if has_creds:
            record("W04", "真实用户伪造加密数据 400 且 DB 无记录", r4.status_code == 400 and rows4 == 0,
                   f"status={r4.status_code} detail={r4.json().get('detail')} rows={rows4}")
        else:
            # 未配置凭证时按设计回退模拟（开发模式），但绝不因解密失败写编造值
            record("W04", "未配置凭证：伪造 payload 回退开发模拟", r4.status_code == 200 and rows4 == 1,
                   f"status={r4.status_code} steps={r4.json().get('steps')}")

        # W05 decrypt_werun 加解密往返
        session_key = base64.b64encode(b"0123456789abcdef").decode("utf-8")
        iv = base64.b64encode(b"abcdef0123456789").decode("utf-8")
        today = time.strftime("%Y-%m-%d")
        ts = int(time.mktime(time.strptime(today, "%Y-%m-%d")))
        payload = {"stepInfoList": [{"timestamp": ts - 86400, "step": 111}, {"timestamp": ts, "step": 6543}],
                   "watermark": {"appid": settings.WX_APPID, "ts": ts}}
        encrypted = encrypt_werun(session_key, iv, payload)
        try:
            out = decrypt_werun(session_key, encrypted, iv)
            got = out["stepInfoList"][-1]["step"]
            record("W05", "decrypt_werun 加解密往返一致", got == 6543, f"step={got}")
        except Exception as e:  # noqa: BLE001
            record("W05", "decrypt_werun 加解密往返一致", False, f"异常: {e}")

        # W06 watermark.appid 不匹配 → ValueError
        bad = dict(payload)
        bad["watermark"] = {"appid": "wx-other-appid", "ts": ts}
        encrypted_bad = encrypt_werun(session_key, iv, bad)
        try:
            decrypt_werun(session_key, encrypted_bad, iv)
            record("W06", "watermark.appid 不匹配拒绝", False, "未抛错")
        except ValueError as e:
            record("W06", "watermark.appid 不匹配拒绝", "校验失败" in str(e), str(e))

        # W07/W08 _resolve_steps 解密路径（monkeypatch code2session 避免触网；
        # 并临时保证凭证非空，使逻辑进入解密分支，结束后恢复）
        orig_code2session = sport_service.code2session
        orig_appid, orig_secret = settings.WX_APPID, settings.WX_SECRET
        sport_service.code2session = lambda code: {"openid": "x", "session_key": session_key}
        settings.WX_APPID = orig_appid or "wx-s11-test"
        settings.WX_SECRET = orig_secret or "s11"
        try:
            payload2 = {"stepInfoList": [{"timestamp": ts - 86400, "step": 111}, {"timestamp": ts, "step": 6543}],
                        "watermark": {"appid": settings.WX_APPID, "ts": ts}}
            encrypted2 = encrypt_werun(session_key, iv, payload2)
            yesterday_only = {"stepInfoList": [{"timestamp": ts - 86400, "step": 111}],
                              "watermark": {"appid": settings.WX_APPID, "ts": ts}}
            enc_yesterday = encrypt_werun(session_key, iv, yesterday_only)
            try:
                sport_service._resolve_steps("real_x", "c", enc_yesterday, iv, today, 999999)
                record("W07", "解密数据缺当日步数抛错", False, "未抛错")
            except ValueError as e:
                record("W07", "解密数据缺当日步数抛错", "缺少今日步数" in str(e), str(e))

            got = sport_service._resolve_steps("real_x", "c", encrypted2, iv, today, 999999)
            record("W08", "_resolve_steps 取当日真实步数", got == 6543, f"steps={got}")
        finally:
            sport_service.code2session = orig_code2session
            settings.WX_APPID, settings.WX_SECRET = orig_appid, orig_secret
    finally:
        cleanup(ids)

    passed = sum(1 for x in RESULTS if x["ok"])
    print(f"\n== S11 步数同步真实数据链路: {passed}/{len(RESULTS)} 通过 ==")
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s11-werun-sync-results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"results": RESULTS, "hasCreds": has_creds}, f, ensure_ascii=False, indent=2)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
