# -*- coding: utf-8 -*-
"""
P0-3 长征章节系统 冒烟脚本（后端黑盒）
覆盖：GET /api/march/route 章节视图 + POST /api/march/light-up 章节完成 + CHAPTER_COMPLETE 事件
  - 0 步：5 章，第一章 ACTIVE（1/2），其余 LOCKED，currentChapterId=1
  - +5000 步：light-up 返回 newlyCompletedChapters 含「第一章 · 出发」，第二章转 ACTIVE
  - 累计 25000 步：一次点亮跨越第二、三章完成
  - 累计 65000 步：全部章节 COMPLETED，currentChapterId=None
  - 足迹时间轴含 5 条 CHAPTER_COMPLETE 事件且文案正确；重复 light-up 幂等
用法：cd backend && python test/p0_chapters.py（需后端已在 8010 运行）
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


def light_up(token):
    status, body = http("/march/light-up", token, method="POST")
    assert status == 200, f"light-up failed: {status} {body}"
    return body


def chapter_by_id(route, cid):
    return next((c for c in route.get("chapters", []) if c.get("id") == cid), None)


def main():
    suffix = datetime.now().strftime("%H%M%S")
    token = login("p0c-" + suffix, "P0章节")

    # 用例1/2：0 步新用户——5 章；第一章 ACTIVE（瑞金 target 0 已点亮，1/2），其余 LOCKED
    r = get_route(token)
    chs = r.get("chapters", [])
    c1 = chapter_by_id(r, 1)
    record(
        "P0C-01", "0步：5章且第一章ACTIVE(1/2)",
        len(chs) == 5 and c1 and c1.get("status") == "ACTIVE"
        and c1.get("litCount") == 1 and c1.get("totalCount") == 2
        and abs(c1.get("progress", -1) - 0.5) < 1e-6
        and r.get("currentChapterId") == 1,
        f"len={len(chs)} c1={c1 and (c1.get('status'), c1.get('litCount'), c1.get('progress'))} cur={r.get('currentChapterId')}",
    )
    record(
        "P0C-02", "0步：第2~5章全部LOCKED",
        all((chapter_by_id(r, i) or {}).get("status") == "LOCKED" for i in (2, 3, 4, 5)),
        str([(c.get("id"), c.get("status")) for c in chs]),
    )

    # 用例3/4：+5000 步点亮遵义 → 第一章完成，第二章 ACTIVE
    add_steps(token, 5000)
    lu = light_up(token)
    new_ch = lu.get("newlyCompletedChapters", [])
    ch1 = next((c for c in new_ch if c.get("id") == 1), None)
    record(
        "P0C-03", "5000步：light-up返回第一章完成(含标题与介绍)",
        ch1 is not None and ch1.get("title") == "第一章 · 出发" and bool(ch1.get("intro")),
        f"newlyCompletedChapters={[(c.get('id'), c.get('title')) for c in new_ch]}",
    )
    r = get_route(token)
    record(
        "P0C-04", "5000步：章1 COMPLETED、章2 ACTIVE",
        (chapter_by_id(r, 1) or {}).get("status") == "COMPLETED"
        and (chapter_by_id(r, 2) or {}).get("status") == "ACTIVE"
        and r.get("currentChapterId") == 2,
        f"cur={r.get('currentChapterId')}",
    )

    # 用例5/6：累计 25000 步——一次 light-up 跨章完成第二、三章
    add_steps(token, 20000)
    lu = light_up(token)
    done_ids = [c.get("id") for c in lu.get("newlyCompletedChapters", [])]
    record(
        "P0C-05", "25000步：一次点亮跨章完成第2、3章",
        done_ids == [2, 3], f"done={done_ids}",
    )
    r = get_route(token)
    record(
        "P0C-06", "25000步：章1-3 COMPLETED、章4 ACTIVE",
        all((chapter_by_id(r, i) or {}).get("status") == "COMPLETED" for i in (1, 2, 3))
        and (chapter_by_id(r, 4) or {}).get("status") == "ACTIVE"
        and r.get("currentChapterId") == 4,
        f"cur={r.get('currentChapterId')}",
    )

    # 用例7/8：累计 65000 步——全部章节完成，currentChapterId=None
    add_steps(token, 40000)
    lu = light_up(token)
    done_ids = [c.get("id") for c in lu.get("newlyCompletedChapters", [])]
    record(
        "P0C-07", "65000步：light-up返回第4、5章完成",
        done_ids == [4, 5], f"done={done_ids}",
    )
    r = get_route(token)
    record(
        "P0C-08", "65000步：全部COMPLETED且currentChapterId=None",
        all(c.get("status") == "COMPLETED" for c in r.get("chapters", []))
        and r.get("currentChapterId") is None and r.get("finished") is True,
        f"cur={r.get('currentChapterId')} finished={r.get('finished')}",
    )

    # 用例9：足迹时间轴含 5 条 CHAPTER_COMPLETE，文案正确
    status, tl = http("/profile/timeline", token)
    items = (tl or {}).get("items", []) if status == 200 else []
    cc = [x for x in items if x.get("eventType") == "CHAPTER_COMPLETE"]
    texts = {x.get("text") for x in cc}
    record(
        "P0C-09", "时间轴含5条CHAPTER_COMPLETE且文案正确",
        len(cc) == 5 and "完成长征章节「第一章 · 出发」" in texts and "完成长征章节「第五章 · 会师」" in texts,
        f"count={len(cc)} texts={sorted(texts)[:2]}",
    )

    # 用例10：重复 light-up 幂等——无新节点、无新章节
    lu = light_up(token)
    record(
        "P0C-10", "重复light-up幂等",
        lu.get("newlyLit") == [] and lu.get("newlyCompletedChapters") == [],
        f"{lu}",
    )

    failed = [x for x in RESULTS if not x["ok"]]
    print(f"\n== 共 {len(RESULTS)} 用例，失败 {len(failed)} ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
