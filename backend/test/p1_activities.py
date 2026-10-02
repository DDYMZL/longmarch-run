# -*- coding: utf-8 -*-
"""
P1-1 实时行军动态（小程序侧）冒烟脚本（后端黑盒 + WS）
覆盖：
  - GET /api/broadcast/activities：动态流结构、隐私边界（无 userId/data/openid）、limit、鉴权
  - 用户触发事件后动态流出现对应昵称与文案
  - WS /api/ws/updates 实时收到 activity 消息
  - mask_nickname 脱敏规则（ACTIVITY_MASK_NICKNAME 配置的纯函数部分）
用法：cd backend && python test/p1_activities.py（需后端已在 8010 运行）
"""
import asyncio
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime

import websockets

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:8010/api"
WS_BASE = "ws://127.0.0.1:8010/api"
RESULTS = []


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name + ((" | " + str(detail)[:200]) if detail else ""))


def http(path, token=None, method="GET", data=None):
    headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        BASE + path, headers=headers,
        data=json.dumps(data).encode() if data is not None else None, method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode()
            return resp.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, None


def login(code, nickname):
    status, body = http("/auth/login", method="POST", data={"code": code, "nickname": nickname})
    assert status == 200 and body and "token" in body, f"login failed: {status} {body}"
    return body["token"]


def get_activities(token, limit=10):
    return http(f"/broadcast/activities?limit={limit}", token)


async def ws_case(token, trigger):
    """连接 WS 后执行 trigger，等待一条 activity 消息。"""
    async with websockets.connect(WS_BASE + "/ws/updates?token=" + token) as ws:
        trigger()
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        return json.loads(raw)


def main():
    suffix = datetime.now().strftime("%H%M%S")
    nickname = "P1动态" + suffix[-4:]
    token = login("p1a-" + suffix, nickname)

    # 用例1：结构 + 隐私边界
    status, body = get_activities(token)
    items = (body or {}).get("items", []) if status == 200 else []
    shape_ok = all(
        set(x.keys()) <= {"id", "eventType", "eventTime", "nickname", "text"} for x in items
    )
    record(
        "P1A-01", "动态流结构且不含userId/data等敏感字段",
        status == 200 and isinstance(items, list) and shape_ok,
        f"status={status} count={len(items)} keys={sorted(items[0].keys()) if items else '[]'}",
    )

    # 用例2：触发首次运动事件后，动态流出现本人昵称与文案
    status, _ = http("/sport/add", token, method="POST", data={"delta": 3000})
    assert status == 200
    _, body = get_activities(token)
    mine = [x for x in (body or {}).get("items", []) if x.get("nickname") == nickname]
    record(
        "P1A-02", "本人事件进入动态流（昵称+文案）",
        len(mine) > 0 and any("首次完成运动同步" in x.get("text", "") for x in mine),
        f"mine={[(x.get('eventType'), x.get('text')) for x in mine[:3]]}",
    )

    # 用例3：点亮节点事件进动态流
    http("/march/light-up", token, method="POST")
    _, body = get_activities(token)
    mine = [x for x in (body or {}).get("items", []) if x.get("nickname") == nickname]
    record(
        "P1A-03", "点亮节点事件进动态流",
        any(x.get("eventType") == "NODE_UNLOCK" and "瑞金" in x.get("text", "") for x in mine),
        f"mine={[(x.get('eventType'), x.get('text')) for x in mine[:3]]}",
    )

    # 用例4：limit 生效
    _, body = get_activities(token, limit=2)
    record("P1A-04", "limit=2 返回不超过2条", len((body or {}).get("items", [])) <= 2, f"{len((body or {}).get('items', []))}")

    # 用例5：未鉴权 401
    status, _ = http("/broadcast/activities")
    record("P1A-05", "未鉴权访问返回401", status == 401, f"status={status}")

    # 用例6：WS 实时收到 activity 消息（新用户首次同步步数 → FIRST_STEP）
    ws_token = login("p1a-ws-" + suffix, "P1实时")
    try:
        msg = asyncio.run(ws_case(ws_token, lambda: http("/sport/add", ws_token, method="POST", data={"delta": 1200})))
        record(
            "P1A-06", "WS实时收到activity消息（含昵称/文案/类型）",
            msg.get("type") == "activity" and msg.get("nickname") == "P1实时"
            and msg.get("eventType") == "FIRST_STEP" and bool(msg.get("text")),
            f"{msg}",
        )
    except Exception as e:
        record("P1A-06", "WS实时收到activity消息", False, str(e))

    # 用例7：脱敏纯函数规则（ACTIVITY_MASK_NICKNAME 默认关闭，函数行为单测）
    from app.services.event_service import mask_nickname
    cases = {"张三": "张*", "王小明": "王*明", "AB": "A*", "": "战友", "一": "一"}
    bad = [(k, mask_nickname(k), v) for k, v in cases.items() if mask_nickname(k) != v]
    record("P1A-07", "mask_nickname 脱敏规则", not bad, f"bad={bad}")

    failed = [x for x in RESULTS if not x["ok"]]
    print(f"\n== 共 {len(RESULTS)} 用例，失败 {len(failed)} ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
