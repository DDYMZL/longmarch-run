# -*- coding: utf-8 -*-
"""
P0-1 行军轨迹进度字段 冒烟脚本（后端黑盒）
覆盖：GET /api/march/route 新增 currentNodeId / currentProgress / routeProgress
  - 新用户（0 步）：currentNodeId=2（遵义，target 5000），currentProgress=0，routeProgress=0
  - 加步数后：进度按比例上升，段内进度与全程进度计算正确
  - 全程完成后：currentNodeId=None，currentProgress/routeProgress 收尾值正确
用法：cd backend && python test/p0_route_progress.py（需后端已在 8010 运行）
"""
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:8010/api"
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


def add_steps(token, delta):
    status, body = http("/sport/add", token, method="POST", data={"delta": delta})
    assert status == 200, f"add steps failed: {status} {body}"
    return body


def get_route(token):
    status, body = http("/march/route", token)
    assert status == 200, f"route failed: {status} {body}"
    return body


def main():
    suffix = datetime.now().strftime("%H%M%S")
    token = login("p0r-" + suffix, "P0轨迹")

    # 用例1：0 步新用户——节点1（瑞金 target 0）必点亮，当前前往节点2（遵义 5000）
    r = get_route(token)
    record(
        "P0R-01", "0步：当前前往节点2", r.get("currentNodeId") == 2,
        f"currentNodeId={r.get('currentNodeId')}",
    )
    record(
        "P0R-02", "0步：段内/全程进度为0",
        r.get("currentProgress") == 0 and r.get("routeProgress") == 0,
        f"currentProgress={r.get('currentProgress')} routeProgress={r.get('routeProgress')}",
    )

    # 用例2：累计 2500 步——遵义段内进度 0.5，全程 2500/65000
    add_steps(token, 2500)
    r = get_route(token)
    ok_seg = abs(r.get("currentProgress", -1) - 0.5) < 1e-6
    ok_all = abs(r.get("routeProgress", -1) - 2500 / 65000) < 1e-6
    record("P0R-03", "2500步：段内进度0.5", ok_seg, f"currentProgress={r.get('currentProgress')}")
    record("P0R-04", "2500步：全程进度=2500/65000", ok_all, f"routeProgress={r.get('routeProgress')}")
    record("P0R-05", "2500步：当前节点仍为2", r.get("currentNodeId") == 2, f"{r.get('currentNodeId')}")

    # 用例3：累计 7500 步——已过遵义(5000)，前往节点3（四渡赤水 10000），段内 (7500-5000)/5000=0.5
    add_steps(token, 5000)
    r = get_route(token)
    record("P0R-06", "7500步：当前前往节点3", r.get("currentNodeId") == 3, f"{r.get('currentNodeId')}")
    record(
        "P0R-07", "7500步：段内进度0.5", abs(r.get("currentProgress", -1) - 0.5) < 1e-6,
        f"{r.get('currentProgress')}",
    )

    # 用例4：补满全程 65000——finished=True，currentNodeId=None
    add_steps(token, 65000)
    http("/march/light-up", token, method="POST")
    r = get_route(token)
    record("P0R-08", "全程完成：finished=True", r.get("finished") is True, f"{r.get('finished')}")
    record("P0R-09", "全程完成：currentNodeId=None", r.get("currentNodeId") is None, f"{r.get('currentNodeId')}")
    record("P0R-10", "全程完成：routeProgress=1", r.get("routeProgress") == 1, f"{r.get('routeProgress')}")

    failed = [x for x in RESULTS if not x["ok"]]
    print(f"\n== 共 {len(RESULTS)} 用例，失败 {len(failed)} ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
