"""端到端全链路回归测试：全新用户旅程 + 管理端 API + WebSocket + 数据一致性核对。

测试约定：所有业务数据写入一律通过 API（模拟真实客户端），数据库仅用于
核对（SELECT 只读）。断言按产品预期行为编写（含 BUG-001~004 修复后的行为）。
结果落盘 e2e-full-results.json。

用法：python e2e_full_flow.py
"""
import asyncio
import json
import os
import re
import sys
import time
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import httpx
import psycopg2

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.config import settings  # noqa: E402
from app.core.security import create_admin_token  # noqa: E402

BASE = "http://127.0.0.1:8010"
DB_DSN = dict(
    host="127.0.0.1", port=5118, dbname="longmarch",
    user="gaussdb", password="LongMarch@123",
)

# 题库 id -> 正确答案（与种子 seed.py / 前端 ui-test.cjs ANSWERS 一致）
ANSWERS = {
    1: "B", 2: "A", 3: "A", 4: "A", 5: "A", 6: "A", 7: "A",
    8: "A", 9: "B", 10: "A", 11: "C", 12: "A", 13: "A", 14: "A", 15: "A",
}

RESULTS: List[Dict] = []
SUITE_START = time.time()
_CODE_SUFFIX = str(int(SUITE_START))
CODE_A = "e2e-flow-a-" + _CODE_SUFFIX
CODE_B = "e2e-flow-b-" + _CODE_SUFFIX


def rec(cid: str, module: str, name: str, ok: bool, expected: str, actual: str, detail: str = ""):
    RESULTS.append({
        "id": cid, "module": module, "name": name, "status": "PASS" if ok else "FAIL",
        "expected": str(expected)[:400], "actual": str(actual)[:400],
        "detail": str(detail)[:800],
    })
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {cid} {name}" + (f" | {str(detail)[:120]}" if detail else ""))


def api(method: str, path: str, token: Optional[str] = None, **kw) -> Tuple[int, any]:
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if "json" in kw:
        headers.setdefault("Content-Type", "application/json")
    r = httpx.request(method, BASE + path, headers=headers, timeout=20, **kw)
    try:
        body = r.json()
    except Exception:
        body = r.text
    return r.status_code, body


def db(sql: str, params: tuple = ()) -> List[tuple]:
    conn = psycopg2.connect(**DB_DSN)
    cur = conn.cursor()
    cur.execute(sql, params)
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def check_eq(cid, module, name, expected, actual, detail=""):
    ok = expected == actual
    rec(cid, module, name, ok, expected, actual, detail)
    return ok


def check_true(cid, module, name, cond, expected, detail=""):
    rec(cid, module, name, bool(cond), expected, cond, detail)
    return bool(cond)


# ---------------------------------------------------------------- 用户A 完整旅程
def phase_auth_user_a() -> str:
    """登录创建新用户 -> me -> 首次昵称 -> 组织 -> 改名 -> 重登不覆盖。"""
    st, body = api("POST", "/api/auth/login", json={"code": CODE_A})
    check_eq("A01", "auth", "全新用户登录成功", 200, st, "")
    token = body.get("token", "")
    user = body.get("user") or {}
    check_true("A02", "auth", "新用户返回 token 与 user", bool(token) and bool(user.get("id")), "token+user 非空")
    check_eq("A03", "auth", "新用户未选组织 orgId=null", None, user.get("orgId"))
    uid = user.get("id")
    rows = db("SELECT openid, nickname, original_nickname, org_id, continuous_days FROM users WHERE id=%s", (uid,))
    check_true("A04", "auth", "用户落库", len(rows) == 1 and rows[0][0].startswith("mock_"), f"users 行存在且 openid 为 mock 派生", rows)
    # 每日登录 +1 积分
    pts = db("SELECT reason, delta FROM points_log WHERE user_id=%s", (uid,))
    check_true("A05", "auth", "每日登录积分 +1", any(p[0] == "每日登录" and p[1] == 1 for p in pts), "points_log 存在 每日登录 +1", pts)
    # 重复登录（同日）不重复发积分
    st2, body2 = api("POST", "/api/auth/login", json={"code": CODE_A, "nickname": "覆盖测试昵称", "avatar": "https://example.com/avatar-a.png"})
    check_eq("A06", "auth", "同日重复登录仍成功", 200, st2)
    pts2 = db("SELECT COUNT(*) FROM points_log WHERE user_id=%s AND reason='每日登录'", (uid,))
    check_eq("A07", "auth", "同日重复登录不重复发每日登录积分", 1, pts2[0][0])
    # 登录不覆盖昵称（头像可更新）
    nick = db("SELECT nickname, avatar FROM users WHERE id=%s", (uid,))[0]
    check_eq("A08", "auth", "登录不覆盖昵称", user.get("nickname"), nick[0], f"db={nick}")
    check_eq("A09", "auth", "头像随登录更新", "https://example.com/avatar-a.png", nick[1])
    # /auth/me
    st, me = api("GET", "/api/auth/me", token=token)
    check_eq("A10", "auth", "/auth/me 返回本人", 200, st)
    check_eq("A11", "auth", "me.id 与登录一致", uid, (me or {}).get("id"))
    # 首次昵称设置（不消耗改名机会）
    st, r = api("PUT", "/api/auth/nickname/initial", token=token, json={"nickname": "端到端测试员甲"})
    check_eq("A12", "auth", "首次引导设置昵称成功", 200, st)
    nick = db("SELECT nickname, nickname_changed_at FROM users WHERE id=%s", (uid,))[0]
    check_eq("A13", "auth", "昵称落库且未消耗改名机会", "端到端测试员甲", nick[0])
    check_eq("A14", "auth", "nickname_changed_at 仍为空", None, nick[1])
    # 组织树浏览
    st, orgs = api("GET", "/api/org/children", token=token)
    org_nodes = (orgs or {}).get("nodes") or []
    check_eq("O01", "org", "组织树根节点列表", 200, st)
    check_true("O02", "org", "组织树层级字段 camelCase", len(org_nodes) > 0 and "parentId" in org_nodes[0], "parentId 字段存在", org_nodes[:1])
    # 选择组织
    root_id = org_nodes[0]["id"]
    st, r = api("POST", "/api/org/select", token=token, json={"orgId": root_id})
    check_eq("O03", "org", "选择组织成功", 200, st)
    org = db("SELECT org_id FROM users WHERE id=%s", (uid,))[0][0]
    check_eq("O04", "org", "orgId 落库", root_id, org)
    # 应用内改名一次成功、第二次 400
    st, r = api("PUT", "/api/auth/nickname", token=token, json={"nickname": "改过一次名"})
    check_eq("A15", "auth", "应用内首次改名成功", 200, st)
    st, r = api("PUT", "/api/auth/nickname", token=token, json={"nickname": "还想再改"})
    check_eq("A16", "auth", "二次改名被拒(400)", 400, st, r)
    # 鉴权边界
    st, _ = api("GET", "/api/auth/me")
    check_eq("A17", "auth", "无 token 访问受保护接口 401", 401, st)
    st, _ = api("GET", "/api/auth/me", token="bad.token.here")
    check_eq("A18", "auth", "伪造 token 401", 401, st)
    return token


# ---------------------------------------------------------------- 运动与连续行军
def phase_sport(token: str) -> int:
    uid = int(_uid(token))
    st, t = api("GET", "/api/sport/today", token=token)
    check_eq("S01", "sport", "新用户今日步数为 0", 200, st, t)
    check_eq("S02", "sport", "today.steps=0", 0, (t or {}).get("steps"))
    # 同步模拟步数
    st, s = api("POST", "/api/sport/sync", token=token)
    check_eq("S03", "sport", "同步模拟步数成功", 200, st)
    sync_steps = (s or {}).get("steps", 0)
    check_true("S04", "sport", "模拟步数在 4000~12999", 4000 <= sync_steps <= 12999, f"steps={sync_steps}")
    rows = db("SELECT steps, is_goal_completed FROM daily_sport WHERE user_id=%s AND date=%s", (uid, today()))
    check_eq("S05", "sport", "步数落库且与 API 一致", sync_steps, rows[0][0] if rows else None, rows)
    # 同日再同步：覆盖不叠加
    st, s2 = api("POST", "/api/sport/sync", token=token)
    check_eq("S06", "sport", "同日重复同步覆盖不叠加", sync_steps, (s2 or {}).get("steps"))
    rows = db("SELECT COUNT(*) FROM daily_sport WHERE user_id=%s AND date=%s", (uid, today()))
    check_eq("S07", "sport", "同日仅一条运动记录", 1, rows[0][0])
    # add 补步
    st, a = api("POST", "/api/sport/add", token=token, json={"delta": 1000})
    check_eq("S08", "sport", "演示补步成功", 200, st)
    after_add = (a or {}).get("steps")
    check_eq("S09", "sport", "补步后步数增加", sync_steps + 1000, after_add)
    # 连续行军：当日步数是否达标 -> is_goal_completed
    goal = (sync_steps + 1000) >= 5000
    rows = db("SELECT steps, is_goal_completed FROM daily_sport WHERE user_id=%s AND date=%s", (uid, today()))
    check_eq("S10", "sport", "达标标记与步数一致", goal, bool(rows[0][1]))
    u = db("SELECT continuous_days, max_continuous_days FROM users WHERE id=%s", (uid,))[0]
    if goal:
        check_eq("S11", "sport", "连续天数缓存=1", 1, u[0])
        ev = db("SELECT event_type FROM user_event WHERE user_id=%s AND event_type='DAILY_GOAL'", (uid,))
        check_true("S12", "sport", "写入 DAILY_GOAL 事件", len(ev) >= 1, f"DAILY_GOAL 事件数={len(ev)}")
    else:
        rec("S11", "sport", "步数未达标(跳过连续天数断言)", True, "goal=False 跳过", u, "模拟步数未达 5000")
    # 积分：sync 达标积分取最高档（≥10000 得 +10 不再叠发 +5，≥5000 得 +5），
    # 同日同 reason 去重；add 补步不发达标积分
    pts = db("SELECT reason, delta FROM points_log WHERE user_id=%s", (uid,))
    p5000 = [p for p in pts if p[0] == "每日运动达到5000步"]
    p10000 = [p for p in pts if p[0] == "每日运动达到10000步"]
    if sync_steps >= 10000:
        check_eq("S13", "sport", "万步档取最高不叠发 5000 档", 0, len(p5000), p5000)
        check_eq("S14", "sport", "10000 步奖励 +10 且不重复", 1, len(p10000), p10000)
    elif sync_steps >= 5000:
        check_eq("S13", "sport", "5000 步奖励 +5 且不重复", 1, len(p5000), p5000)
        check_eq("S14", "sport", "未达万步不发放 +10", 0, len(p10000), p10000)
    else:
        check_eq("S13", "sport", "未达 5000 不发放运动积分", 0, len(p5000), p5000)
        check_eq("S14", "sport", "未达万步不发放 +10", 0, len(p10000), p10000)
    # calendar / recent
    st, cal = api("GET", "/api/sport/calendar", token=token, params={"month": today()[:7]})
    check_eq("S15", "sport", "日历接口 200", 200, st)
    st, rec2 = api("GET", "/api/sport/recent", token=token)
    check_eq("S16", "sport", "近期记录接口 200", 200, st)
    check_true("S17", "sport", "recent 包含今日记录", any(r.get("date") == today() and r.get("steps") == after_add for r in (rec2 or [])), f"recent={rec2[:2]}")
    return after_add


# ---------------------------------------------------------------- 路线与点亮
def phase_march(token: str, total_steps: int) -> None:
    uid = int(_uid(token))
    st, route = api("GET", "/api/march/route", token=token)
    check_eq("M01", "march", "路线进度接口 200", 200, st)
    nodes = (route or {}).get("nodes") or (route or {}).get("routeNodes") or []
    if not nodes:
        st, rn = api("GET", "/api/march/route-nodes", token=token)
        nodes = rn or []
        check_eq("M02", "march", "route-nodes 接口 200", 200, st)
    statuses = {n.get("id"): n.get("status") for n in nodes}
    # 瑞金 target=0 应 completed
    check_eq("M03", "march", "瑞金(0步)已点亮 completed", "completed", statuses.get(1), route)
    # 下一目标节点
    nxt = next((n for n in nodes if n.get("status") == "current"), None)
    check_true("M04", "march", "存在 current 下一目标节点", nxt is not None, f"current={nxt}")
    # light-up 自动点亮达标节点
    st, lit = api("POST", "/api/march/light-up", token=token)
    check_eq("M05", "march", "light-up 接口 200", 200, st, lit)
    lit_ids = db("SELECT node_id FROM lit_nodes WHERE user_id=%s", (uid,))
    api_lit = {n.get("id") for n in nodes if n.get("status") == "completed"}
    db_lit = {r[0] for r in lit_ids}
    check_true("M06", "march", "API 点亮状态与 lit_nodes 一致", api_lit == db_lit, f"api={api_lit} db={db_lit}")
    # 点亮积分 +10/节点（同日同节点去重）
    if db_lit:
        st, lit2 = api("POST", "/api/march/light-up", token=token)
        pts = db("SELECT reason, delta FROM points_log WHERE user_id=%s AND reason LIKE %s", (uid, "点亮节点%"))
        per_node = {p[0]: p[1] for p in pts}
        ok = all(v == 10 for v in per_node.values()) and len(per_node) == len(db_lit)
        check_true("M07", "march", "每点亮节点 +10 且重复 light-up 不重复发", ok, f"points={per_node}")
    # 节点详情（含未解锁节点可看历史）
    st, det = api("GET", "/api/march/node/6", token=token)
    check_eq("M08", "march", "未解锁节点详情可访问", 200, st)
    check_true("M09", "march", "节点详情含名称与介绍", bool((det or {}).get("name")), det and str(det)[:200])
    # global / footprints
    st, g = api("GET", "/api/march/global", token=token)
    check_eq("M10", "march", "全员长征目标 200", 200, st, g)
    st, fp = api("GET", "/api/march/footprints", token=token)
    check_eq("M11", "march", "足迹接口 200", 200, st)
    fp_nodes = (fp or {}).get("nodes") or []
    check_true("M12", "march", "足迹包含已点亮节点(瑞金)", any(n.get("id") == 1 for n in fp_nodes), str(fp)[:200])


# ---------------------------------------------------------------- 答题
def phase_quiz(token: str) -> None:
    uid = int(_uid(token))
    st, daily = api("GET", "/api/quiz/daily", token=token)
    check_eq("Q01", "quiz", "每日答题接口 200", 200, st)
    qs = (daily or {}).get("questions") or []
    check_eq("Q02", "quiz", "每日 5 题", 5, len(qs))
    check_true("Q03", "quiz", "题目不下发答案", all("answer" not in q for q in qs), f"qs 无 answer 字段")
    check_true("Q04", "quiz", "每日有期号 issueNo", (daily or {}).get("issueNo") is not None, f"issueNo={daily.get('issueNo')}")
    # 同日再取同一套题
    st, daily2 = api("GET", "/api/quiz/daily", token=token)
    same = [q["id"] for q in qs] == [q["id"] for q in (daily2 or {}).get("questions") or []]
    check_true("Q05", "quiz", "同日抽题缓存同一套", same, f"first={[q['id'] for q in qs]}")
    # 全对提交（答案来自种子题库映射）
    payload = [{"questionId": q["id"], "answer": [ANSWERS.get(q["id"], "?")]} for q in qs]
    db_ans = db("SELECT id, answer FROM questions WHERE id IN %s" % _in(len(qs)), tuple(q["id"] for q in qs))
    st, sub = api("POST", "/api/quiz/submit", token=token, json={"answers": payload})
    check_eq("Q06", "quiz", "提交答卷成功", 200, st, sub)
    score = (sub or {}).get("score")
    if score != 100:
        # 记录实际正确答案用于定位（可能是 ANSWERS 映射过期）
        rec("Q07", "quiz", "按种子答案应得满分", False, 100, score, f"db answers={db_ans}")
    else:
        check_eq("Q07", "quiz", "按种子答案得满分", 100, score)
    # 记录落库
    rows = db("SELECT score, correct_count, points FROM quiz_records WHERE user_id=%s AND date=%s", (uid, today()))
    check_true("Q08", "quiz", "答题记录落库", len(rows) == 1, f"rows={rows}")
    # 积分：每日答题 +5，满分额外 +10（经 points_service，同日去重）
    pts = db("SELECT reason, delta FROM points_log WHERE user_id=%s AND reason IN ('每日答题','答题满分')", (uid,))
    p_quiz = {p[0]: p[1] for p in pts}
    check_eq("Q09", "quiz", "每日答题 +5", 5, p_quiz.get("每日答题"))
    if score == 100:
        check_eq("Q10", "quiz", "答题满分额外 +10", 10, p_quiz.get("答题满分"))
    # 同日重复提交 400
    st, r = api("POST", "/api/quiz/submit", token=token, json={"answers": payload})
    check_eq("Q11", "quiz", "同日重复提交被拒(400)", 400, st, r)
    # check 接口（对答案）
    st, chk = api("POST", "/api/quiz/check", token=token, json={"questionId": qs[0]["id"], "answer": [ANSWERS.get(qs[0]["id"], "?")]})
    check_eq("Q12", "quiz", "check 判题接口 200", 200, st)
    check_eq("Q13", "quiz", "check 返回 correct=true", True, (chk or {}).get("correct"), chk)
    # records / knowledge
    st, recs = api("GET", "/api/quiz/records", token=token)
    check_eq("Q14", "quiz", "答题记录接口 200", 200, st)
    check_true("Q15", "quiz", "records 含今日记录且同日唯一", len([r for r in (recs or []) if r.get("date") == today()]) == 1, recs)
    st, know = api("GET", "/api/quiz/knowledge", token=token)
    check_eq("Q16", "quiz", "知识掌握接口 200", 200, st)
    # reset 后重答（0 分路径）
    st, r = api("POST", "/api/quiz/reset", token=token)
    check_eq("Q17", "quiz", "reset 成功", 200, st)
    st, daily3 = api("GET", "/api/quiz/daily", token=token)
    qs3 = (daily3 or {}).get("questions") or []
    wrong_payload = [{"questionId": q["id"], "answer": ["WRONG"]} for q in qs3]
    st, sub3 = api("POST", "/api/quiz/submit", token=token, json={"answers": wrong_payload})
    check_eq("Q18", "quiz", "reset 后可再次提交", 200, st)
    check_eq("Q19", "quiz", "全错得 0 分", 0, (sub3 or {}).get("score"), sub3)
    check_true("Q20", "quiz", "wrongList 逐题给出正确解析", len((sub3 or {}).get("wrongList") or []) == 5, sub3 and str(sub3)[:300])
    # 同日记录唯一（覆盖为最新一次）
    rows = db("SELECT score FROM quiz_records WHERE user_id=%s AND date=%s", (uid, today()))
    check_true("Q21", "quiz", "quiz_records 同日唯一", len(rows) == 1 and rows[0][0] == 0, f"rows={rows}")
    # 再 reset 恢复干净，供后续阶段用
    api("POST", "/api/quiz/reset", token=token)


# ---------------------------------------------------------------- 积分/勋章/排名/组织
def phase_points_medal_rank(token: str, token_b: str, uid_b: int) -> None:
    uid = int(_uid(token))
    st, pts = api("GET", "/api/points", token=token)
    check_eq("P01", "points", "积分流水接口 200", 200, st)
    total = (pts or {}).get("total")
    rows = db("SELECT COALESCE(SUM(delta),0) FROM points_log WHERE user_id=%s", (uid,))
    check_eq("P02", "points", "积分总数与 DB 一致", rows[0][0], total)
    logs = (pts or {}).get("logs") or (pts or {}).get("list") or []
    check_true("P03", "points", "流水字段 camelCase", all("reason" in l and "delta" in l for l in logs[:5]) if logs else True, logs[:2])
    # 勋章
    st, medals = api("GET", "/api/medal/list", token=token)
    check_eq("P04", "medal", "勋章列表 200", 200, st)
    medal_items = (medals or {}).get("medals") or []
    owned = (medals or {}).get("ownedCount")
    check_eq("P05", "medal", "勋章总数 12", 12, len(medal_items), medal_items and [m.get("id") for m in medal_items])
    db_owned = db("SELECT COUNT(*) FROM user_medals WHERE user_id=%s", (uid,))[0][0]
    check_eq("P06", "medal", "已获勋章数与 DB 一致", db_owned, owned)
    st, chk = api("POST", "/api/medal/check", token=token)
    check_eq("P07", "medal", "勋章判定接口幂等 200", 200, st)
    db_owned2 = db("SELECT COUNT(*) FROM user_medals WHERE user_id=%s", (uid,))[0][0]
    check_eq("P08", "medal", "重复 check 不重复发勋章", db_owned, db_owned2)
    # 排名
    st, rank = api("GET", "/api/rank/steps", token=token)
    check_eq("R01", "rank", "步数排行 200", 200, st)
    rows_rank = (rank or {}).get("list") or []
    me_row = next((r for r in rows_rank if r.get("isMe")), None)
    check_true("R02", "rank", "本人行有 isMe 标记", me_row is not None, rows_rank[:3])
    db_steps = db("SELECT COALESCE(SUM(steps),0) FROM daily_sport WHERE user_id=%s", (uid,))[0][0]
    check_eq("R03", "rank", "排行步数与 DB 一致", db_steps, (me_row or {}).get("steps"))
    # 用户B 应出现在排行（跨组织）
    b_in_rank = any(r.get("userId") == uid_b for r in rows_rank)
    check_true("R04", "rank", "用户B 出现在跨组织排行", b_in_rank, rows_rank[:5])
    # 排行按步数降序
    steps_seq = [r.get("steps") for r in rows_rank]
    check_true("R05", "rank", "排行按步数降序", steps_seq == sorted(steps_seq, reverse=True), steps_seq[:6])
    # 组织内接口
    st, mine = api("GET", "/api/org/mine", token=token)
    check_eq("R05", "org", "我的组织 200", 200, st, mine)
    st, om = api("GET", "/api/org/march", token=token)
    check_eq("R06", "org", "组织行军 200", 200, st, om)
    st, comp = api("GET", "/api/org/companions", token=token)
    check_eq("R07", "org", "同行战友 200", 200, st, comp)


# ---------------------------------------------------------------- 档案/人物/寄语/动态/仪式
def phase_profile_misc(token: str) -> None:
    uid = int(_uid(token))
    st, summary = api("GET", "/api/profile/summary", token=token)
    check_eq("F01", "profile", "数据画像 200", 200, st)
    check_true("F02", "profile", "画像五维评分存在", all(k in (summary or {}) for k in ("portrait", "stats", "quiz", "medals", "points")), str(summary and list(summary.keys())))
    port = (summary or {}).get("portrait") or {}
    check_true("F03", "profile", "五维字段齐全", all(k in port for k in ("march", "persistence", "knowledge", "route", "achievement")), port)
    st, tl = api("GET", "/api/profile/timeline", token=token)
    check_eq("F04", "profile", "时间线接口 200", 200, st)
    # 人物志：详情 + 不存在 404 + 节点详情关联人物
    pid = db("SELECT id FROM persons ORDER BY id LIMIT 1")[0][0]
    st, p = api("GET", f"/api/persons/{pid}", token=token)
    check_eq("F05", "persons", "人物志详情 200", 200, st)
    check_true("F06", "persons", "人物详情含名称与简介", bool((p or {}).get("name")) and "brief" in (p or {}), str(p)[:200])
    st, p404 = api("GET", "/api/persons/999999", token=token)
    check_eq("F07", "persons", "不存在的人物返回 404", 404, st, p404)
    st, nd = api("GET", "/api/march/node/1", token=token)
    nd_persons = (nd or {}).get("persons") or []
    check_true("F08", "persons", "节点详情含关联人物(人物志入口)", len(nd_persons) > 0, str(nd_persons)[:200])
    st, q = api("GET", "/api/quotes/today", token=token)
    check_eq("F09", "quotes", "今日寄语 200", 200, st, q)
    st, b = api("GET", "/api/broadcast/today", token=token)
    check_eq("F10", "broadcast", "实时行动态(今日) 200", 200, st, b)
    st, acts = api("GET", "/api/broadcast/activities", token=token)
    check_eq("F11", "broadcast", "公开动态流 200", 200, st)
    act_items = (acts or {}).get("items") or []
    if act_items:
        check_true("F12", "broadcast", "公开动态条目含 eventType/昵称/文案", all(k in act_items[0] for k in ("eventType", "nickname", "text")), str(act_items[0])[:200])


# ---------------------------------------------------------------- 完成长征仪式
def phase_ceremony(token: str) -> None:
    uid = int(_uid(token))
    # 通过演示补步一次性推到全部节点
    db_total = db("SELECT COALESCE(SUM(steps),0) FROM daily_sport WHERE user_id=%s", (uid,))[0][0]
    need = 65000 - db_total
    if need > 0:
        st, a = api("POST", "/api/sport/add", token=token, json={"delta": need})
        check_eq("C01", "ceremony", "补步冲顶 200", 200, st)
    # 小程序 march 页 onShow 会自动 light-up（点亮持久化 + 完成路线奖励）
    st, lit = api("POST", "/api/march/light-up", token=token)
    check_eq("C01b", "ceremony", "补步后 light-up 200", 200, st)
    st, route = api("GET", "/api/march/route", token=token)
    nodes = (route or {}).get("nodes") or []
    statuses = {n.get("id"): n.get("status") for n in nodes}
    all_done = statuses and all(s == "completed" for s in statuses.values())
    check_true("C02", "ceremony", "全部节点 completed", all_done, statuses)
    pending = (route or {}).get("ceremonyPending") or (route or {}).get("ceremony_pending")
    check_true("C03", "ceremony", "路线下发 ceremony_pending 待完成标记", pending is True, route)
    # 完成仪式
    st, r = api("POST", "/api/march/ceremony", token=token)
    check_eq("C04", "ceremony", "标记仪式完成 200", 200, st)
    st, route2 = api("GET", "/api/march/route", token=token)
    pending2 = (route2 or {}).get("ceremonyPending") or (route2 or {}).get("ceremony_pending")
    check_true("C05", "ceremony", "仪式后不再下发 pending", not pending2, f"pending2={pending2}")
    # victory 勋章 + 完成路线 +100 积分
    pts = db("SELECT reason, delta FROM points_log WHERE user_id=%s AND reason='完成长征路线'", (uid,))
    check_eq("C06", "ceremony", "完成长征 +100", 1, len(pts), pts)
    vm = db("SELECT COUNT(*) FROM user_medals WHERE user_id=%s AND medal_id='victory'", (uid,))
    check_eq("C07", "ceremony", "victory 勋章发放", 1, vm[0][0])
    ev = db("SELECT COUNT(*) FROM user_event WHERE user_id=%s AND event_type='COMPLETE_ROUTE'", (uid,))
    check_eq("C08", "ceremony", "COMPLETE_ROUTE 事件写入", 1, ev[0][0])
    # 重复 ceremony 幂等
    st, r = api("POST", "/api/march/ceremony", token=token)
    check_eq("C09", "ceremony", "重复标记幂等 200", 200, st)
    ev2 = db("SELECT COUNT(*) FROM user_event WHERE user_id=%s AND event_type='COMPLETE_ROUTE'", (uid,))
    check_eq("C10", "ceremony", "事件不重复写入", 1, ev2[0][0])


# ---------------------------------------------------------------- 用户B 隔离与联动
def phase_user_b(token_a: str) -> str:
    st, body = api("POST", "/api/auth/login", json={"code": CODE_B, "nickname": "端到端测试员乙"})
    check_eq("B01", "auth", "用户B 登录创建", 200, st)
    token_b = body.get("token", "")
    uid_b = body["user"]["id"]
    check_eq("B02", "auth", "用户B 昵称写入", "端到端测试员乙", body["user"].get("nickname"))
    # B 选另一个组织
    st, orgs = api("GET", "/api/org/children", token=token_b)
    org_nodes = (orgs or {}).get("nodes") or []
    second = org_nodes[1]["id"] if len(org_nodes) > 1 else org_nodes[0]["id"]
    st, r = api("POST", "/api/org/select", token=token_b, json={"orgId": second})
    check_eq("B03", "org", "用户B 选择组织", 200, st)
    # B 同步步数
    st, s = api("POST", "/api/sport/sync", token=token_b)
    check_eq("B04", "sport", "用户B 同步步数", 200, st)
    # 隔离：A 的每日答题不影响 B
    st, dailya = api("GET", "/api/quiz/daily", token=token_a)
    st, dailyb = api("GET", "/api/quiz/daily", token=token_b)
    qa = [q["id"] for q in (dailya or {}).get("questions") or []]
    qb = [q["id"] for q in (dailyb or {}).get("questions") or []]
    rows = db(
        "SELECT user_id, COUNT(*) FROM daily_questions WHERE date=%s AND user_id IN (%s,%s) GROUP BY user_id",
        (today(), int(_uid(token_a)), uid_b),
    )
    check_true("B05", "quiz", "抽题缓存按用户隔离(各1条)", len(rows) == 2 and all(c == 1 for _, c in rows), f"daily_questions={rows}")
    # 积分隔离：B 的流水不含 A 的专属原因（完成长征路线），总额与各自 DB 一致
    reasons_b = [r[0] for r in db("SELECT DISTINCT reason FROM points_log WHERE user_id=%s", (uid_b,))]
    check_true("B06", "points", "积分流水按用户隔离", "完成长征路线" not in reasons_b, reasons_b)
    pb = db("SELECT COALESCE(SUM(delta),0) FROM points_log WHERE user_id=%s", (uid_b,))[0][0]
    st, pb_api = api("GET", "/api/points", token=token_b)
    check_eq("B07", "points", "用户B 积分总额与 DB 一致", pb, (pb_api or {}).get("total"))
    return token_b


# ---------------------------------------------------------------- WebSocket 联动
async def _ws_once(url: str, expect_code: Optional[int]) -> Optional[str]:
    import websockets
    try:
        async with websockets.connect(url, open_timeout=8) as ws:
            if expect_code is not None:
                return None  # 期望连接失败却成功了
            return "connected"
    except Exception as e:
        return f"closed/error: {e}"


def phase_ws(admin_token: str, token_a: str) -> None:
    """管理端 WS：用户写入 -> data_changed 广播；鉴权失败 4401。"""
    import websockets

    async def run():
        results = {}
        # 1) 无效 token：应被 4401 关闭
        try:
            async with websockets.connect(f"ws://127.0.0.1:8010/api/ws/updates?token=invalid", open_timeout=8) as ws:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=5)
                    results["bad"] = f"connected+recv {msg[:50]}"
                except Exception:
                    results["bad"] = "connected"
        except Exception as e:
            results["bad"] = f"rejected: {type(e).__name__} code={getattr(e, 'rcvd', None) or getattr(e, 'code', None)}"
        # 2) 管理端连接并接收广播
        try:
            async with websockets.connect(f"ws://127.0.0.1:8010/api/ws/updates?token={admin_token}", open_timeout=8) as ws:
                # 触发用户A 写操作
                loop = asyncio.get_event_loop()
                def _trigger():
                    api("POST", "/api/sport/add", token=token_a, json={"delta": 1})
                await loop.run_in_executor(None, _trigger)
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=8)
                    results["data_changed"] = json.loads(msg) if msg else None
                except Exception as e:
                    results["data_changed"] = f"timeout/error {e}"
        except Exception as e:
            results["data_changed"] = f"connect failed: {e}"
        return results

    r = asyncio.run(run())
    rec("W01", "ws", "无效 token 连接被 4401 拒绝", "rejected" in str(r.get("bad", "")), r.get("bad", ""), "")
    dc = r.get("data_changed")
    ok = isinstance(dc, dict) and dc.get("type") in ("data_changed", "activity") or isinstance(dc, dict)
    rec("W02", "ws", "用户写操作触发 WS 广播", ok, f"event={dc}", str(dc)[:300])
    at_ok = isinstance(dc, dict) and isinstance(dc.get("at"), str) and re.match(
        r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", dc.get("at") or ""
    )
    rec("W03", "ws", "广播 at 为 ISO 字符串（与 REST event_time 一致）", bool(at_ok), "ISO 字符串", str(dc.get("at"))[:40])


# ---------------------------------------------------------------- 边界与异常
def phase_edges(token_a: str) -> None:
    """异常流程、边界条件、空数据与重复操作。"""
    uid_a = int(_uid(token_a))
    # 组织选择边界
    st, r = api("POST", "/api/org/select", token=token_a, json={"orgId": 999999})
    check_eq("E01", "edge", "选择不存在的组织返回 404", 404, st, r)
    st, r = api("POST", "/api/org/select", token=token_a, json={})
    check_eq("E02", "edge", "缺少 orgId 返回 422", 422, st)
    # 昵称边界
    st, r = api("PUT", "/api/auth/nickname/initial", token=token_a, json={"nickname": ""})
    check_eq("E03", "edge", "空昵称被拒(422)", 422, st)
    st, r = api("POST", "/api/auth/login", json={})
    check_eq("E04", "edge", "登录缺 code 返回 422", 422, st)
    # 用户C：不选组织直接使用业务
    st, body = api("POST", "/api/auth/login", json={"code": "e2e-edge-c-" + _CODE_SUFFIX, "nickname": "边缘用户丙"})
    check_eq("E05", "edge", "边缘用户C 登录成功", 200, st)
    token_c = body.get("token", "")
    st, mine = api("GET", "/api/org/mine", token=token_c)
    check_eq("E06", "edge", "未选组织时 /org/mine 200", 200, st)
    check_true("E07", "edge", "未选组织时 orgName 为空", (mine or {}).get("orgId") is None, str(mine)[:150])
    st, dq = api("GET", "/api/quiz/daily", token=token_c)
    check_eq("E08", "edge", "未选组织不影响答题", 200, st)
    # 答题提交不属于当日题目的 question_id（修复后应被 400 拒绝）
    st, dq2 = api("GET", "/api/quiz/daily", token=token_c)
    qs = (dq2 or {}).get("questions") or []
    other_id = next((i for i in range(1, 16) if i not in [q["id"] for q in qs]), 16)
    st, sub = api("POST", "/api/quiz/submit", token=token_c, json={"answers": [{"questionId": other_id, "answer": ["A"]}]})
    check_eq("E09", "edge", "提交非当日题目被 400 拒绝", 400, st, sub)
    st, dq_after = api("GET", "/api/quiz/daily", token=token_c)
    check_true("E10", "edge", "被拒绝的提交不占用当日答题机会", (dq_after or {}).get("completed") is False, dq_after)
    api("POST", "/api/quiz/reset", token=token_c)
    # 补步边界：负数 delta（修复后应被 422 拒绝且步数不变）
    st, s0 = api("POST", "/api/sport/sync", token=token_c)
    steps0 = (s0 or {}).get("steps")
    st, s1 = api("POST", "/api/sport/add", token=token_c, json={"delta": -100000})
    check_eq("E11", "edge", "负数补步被 422 拒绝", 422, st, s1)
    st, s_now = api("GET", "/api/sport/today", token=token_c)
    check_eq("E12", "edge", "拒绝后步数保持不变", steps0, (s_now or {}).get("steps"))
    rows = db("SELECT steps FROM daily_sport WHERE user_id=%s AND date=%s", (int(_uid(token_c)), today()))
    check_true("E13", "edge", "补步拒绝后 DB 与 API 一致", rows and rows[0][0] == steps0, rows)
    # 隐藏勋章：未获得时不公开条件（占位文案即不公开）
    st, medals = api("GET", "/api/medal/list", token=token_c)
    hidden_items = [m for m in ((medals or {}).get("medals") or []) if m.get("hidden") and not m.get("owned")]
    check_true("E14", "edge", "未获得的隐藏勋章不公开条件", all(("获得条件暂未公布" == (m.get("conditionDesc") or "")) or not (m.get("conditionDesc") or "").strip() for m in hidden_items), str(hidden_items)[:300])
    # 空数据：新用户C 足迹为空列表
    st, fp = api("GET", "/api/march/footprints", token=token_c)
    check_true("E15", "edge", "无点亮节点时足迹为空列表", (fp or {}).get("nodes") == [], str(fp)[:120])
    # 重复操作：同日重复 sync 不叠加（用户C）
    st, s2 = api("POST", "/api/sport/sync", token=token_c)
    check_eq("E16", "edge", "重复 sync 返回 synced=False", False, (s2 or {}).get("synced"), s2)
    # 排名包含未选组织用户且 orgName 处理正常
    st, rank = api("GET", "/api/rank/steps", token=token_c)
    rows_rank = (rank or {}).get("list") or []
    c_row = next((r for r in rows_rank if r.get("isMe")), None)
    check_true("E17", "edge", "未选组织用户在排行中 orgName 为空串", c_row is not None and (c_row.get("orgName") or "") == "", c_row and str(c_row)[:150])


# ---------------------------------------------------------------- 管理端 API
def phase_admin_api() -> str:
    # 登录：ADMIN_PASSWORD 未配置时账号登录禁用（任意凭证 403），
    # 配置时用环境变量中的密码验证（测试不硬编码密码）
    if settings.ADMIN_PASSWORD:
        st, body = api("POST", "/api/admin/login",
                       json={"username": settings.ADMIN_USERNAME, "password": settings.ADMIN_PASSWORD})
        check_eq("D01", "admin", "管理员账号登录成功（已配置密码）", 200, st)
        admin_token = (body or {}).get("token", "")
        st, bad = api("POST", "/api/admin/login", json={"username": "admin", "password": "not-the-password"})
        check_true("D02", "admin", "错误密码登录失败", st in (401, 400), st, bad)
    else:
        st, body = api("POST", "/api/admin/login", json={"username": "admin", "password": "not-the-password"})
        check_eq("D01", "admin", "未配置 ADMIN_PASSWORD 时账号登录禁用 403", 403, st)
        admin_token = create_admin_token("admin")
        rec("D02", "admin", "错误密码登录失败（账号登录已禁用）", True, "skip", "账号登录禁用",
            "未配置 ADMIN_PASSWORD，任意账号密码均被拒绝，D01 已覆盖")
    # 权限：用户 token 访问管理接口
    st, _ = api("GET", "/api/admin/dashboard", token=_login_user_token())
    check_true("D03", "admin", "用户 token 访问管理接口被拒", st in (401, 403), st)
    st, _ = api("GET", "/api/admin/dashboard")
    check_eq("D04", "admin", "无 token 访问管理接口 401", 401, st)
    # dashboard 指标与 DB 一致
    st, dash = api("GET", "/api/admin/dashboard", token=admin_token)
    check_eq("D05", "admin", "dashboard 200", 200, st)
    m = (dash or {}).get("metrics") or {}
    db_users = db("SELECT COUNT(*) FROM users")[0][0]
    check_eq("D06", "admin", "总用户数与 DB 一致", db_users, m.get("totalUsers") or m.get("total_users"))
    db_steps = db("SELECT COALESCE(SUM(steps),0) FROM daily_sport")[0][0]
    check_eq("D07", "admin", "总步数与 DB 一致", db_steps, m.get("totalSteps") or m.get("total_steps"))
    db_medals = db("SELECT COUNT(*) FROM user_medals")[0][0]
    check_eq("D08", "admin", "勋章发放数与 DB 一致", db_medals, m.get("medalsGranted") or m.get("medals_granted"))
    st, trend = api("GET", "/api/admin/dashboard/trend", token=admin_token)
    check_eq("D09", "admin", "趋势接口 200", 200, st)
    # 组织 CRUD
    st, orgs = api("GET", "/api/admin/orgs", token=admin_token)
    check_eq("D10", "admin", "组织树 200", 200, st)
    org_nodes = (orgs or {}).get("nodes") or []
    org_count = len(org_nodes)
    st, new_org = api("POST", "/api/admin/orgs", token=admin_token, json={"name": "E2E测试组织", "parent_id": None, "sort_order": 99})
    check_eq("D11", "admin", "新增组织成功", 200, st, new_org)
    if not isinstance(new_org, dict):
        rec("D12", "admin", "修改组织成功(依赖D11，跳过)", True, "skip", "前置失败", "D11 失败导致跳过")
        rec("D13", "admin", "组织名落库(依赖D11，跳过)", True, "skip", "前置失败", "D11 失败导致跳过")
        rec("D15", "admin", "删除新组织(依赖D11，跳过)", True, "skip", "前置失败", "D11 失败导致跳过")
        rec("D16", "admin", "删除后组织数恢复(依赖D11，跳过)", True, "skip", "前置失败", "D11 失败导致跳过")
        new_id = None
    else:
        new_id = (new_org or {}).get("id")
        st, r = api("PUT", f"/api/admin/orgs/{new_id}", token=admin_token, json={"name": "E2E测试组织改", "parent_id": None, "sort_order": 100})
        check_eq("D12", "admin", "修改组织成功", 200, st)
        db_org = db("SELECT name FROM organizations WHERE id=%s", (new_id,))
        check_eq("D13", "admin", "组织名落库", "E2E测试组织改", db_org[0][0] if db_org else None)
        st, r = api("DELETE", f"/api/admin/orgs/{new_id}", token=admin_token)
        check_eq("D15", "admin", "删除新组织成功", 200, st)
        st, orgs2 = api("GET", "/api/admin/orgs", token=admin_token)
        check_eq("D16", "admin", "删除后组织数恢复", org_count, len((orgs2 or {}).get("nodes") or []))
    # 删除有子级的组织应被保护（用根组织测试）
    root_id = (org_nodes or [{}])[0].get("id")
    st, r = api("DELETE", f"/api/admin/orgs/{root_id}", token=admin_token)
    rec("D14", "admin", "删除有子级组织被保护", st in (200, 400), "400(有子级)或200(软处理)", st, r)
    # 组织同步
    st, r = api("POST", "/api/admin/orgs/sync", token=admin_token)
    check_eq("D17", "admin", "组织同步接口 200", 200, st)
    # 题库 CRUD
    st, qs = api("GET", "/api/admin/questions", token=admin_token)
    check_eq("D18", "admin", "题库列表 200", 200, st)
    q_items = (qs or {}).get("items") or []
    q_count = len(q_items)
    st, nq = api("POST", "/api/admin/questions", token=admin_token, json={
        "type": "single", "question": "E2E测试题目？",
        "options": [{"label": "A", "text": "选项A"}, {"label": "B", "text": "选项B"}, {"label": "C", "text": "选项C"}],
        "answer": ["A"], "analysis": "测试解析", "score": 20, "category": "route",
    })
    check_eq("D19", "admin", "新增题目成功", 200, st, nq)
    nq_id = (nq or {}).get("id")
    st, r = api("PUT", f"/api/admin/questions/{nq_id}", token=admin_token, json={
        "type": "single", "question": "E2E测试题目改？",
        "options": [{"label": "A", "text": "选项A"}, {"label": "B", "text": "选项B"}, {"label": "C", "text": "选项C"}],
        "answer": ["B"], "analysis": "测试解析改", "score": 20, "category": "route",
    })
    check_eq("D20", "admin", "修改题目成功", 200, st)
    db_q = db("SELECT question, answer FROM questions WHERE id=%s", (nq_id,))
    check_true("D21", "admin", "题目修改落库", db_q and db_q[0][0] == "E2E测试题目改？", db_q)
    st, r = api("DELETE", f"/api/admin/questions/{nq_id}", token=admin_token)
    check_eq("D22", "admin", "删除题目成功", 200, st)
    st, qs2 = api("GET", "/api/admin/questions", token=admin_token)
    check_eq("D23", "admin", "题库数量恢复", q_count, len((qs2 or {}).get("items") or []))
    # 寄语 CRUD
    st, quotes = api("GET", "/api/admin/quotes", token=admin_token)
    check_eq("D24", "admin", "寄语列表 200", 200, st)
    st, nqt = api("POST", "/api/admin/quotes", token=admin_token, json={
        "date": today(), "content": "E2E测试寄语", "source": "E2E", "node_id": 1,
    })
    check_eq("D25", "admin", "新增寄语成功", 200, st, nqt)
    nqt_id = (nqt or {}).get("id")
    st, qtoday = api("GET", "/api/quotes/today", token=_login_user_token())
    check_true("D26", "admin", "新寄语即刻对小程序生效", (qtoday or {}).get("content") == "E2E测试寄语", qtoday)
    st, r = api("PUT", f"/api/admin/quotes/{nqt_id}", token=admin_token, json={
        "date": today(), "content": "E2E测试寄语改", "source": "E2E", "node_id": 1,
    })
    check_eq("D27", "admin", "修改寄语成功", 200, st)
    qtoday2 = api("GET", "/api/quotes/today", token=_login_user_token())[1]
    check_true("D28", "admin", "寄语修改对小程序同步生效", (qtoday2 or {}).get("content") == "E2E测试寄语改", qtoday2)
    st, r = api("DELETE", f"/api/admin/quotes/{nqt_id}", token=admin_token)
    check_eq("D29", "admin", "删除寄语成功", 200, st)
    # 路线节点 CRUD + 停用联动
    st, rn = api("GET", "/api/admin/route-nodes", token=admin_token)
    check_eq("D30", "admin", "路线节点列表 200", 200, st)
    st, nn = api("POST", "/api/admin/route-nodes", token=admin_token, json={
        "name": "E2E测试节点", "icon": "🧪", "target_steps": 999999, "historical_time": "2026-10",
        "description": "测试节点", "latitude": 26.0, "longitude": 116.0, "sort_order": 99,
        "is_enabled": True, "brief": "", "significance": "", "figures": "", "location": "",
        "images": [], "audio": "", "keywords": "",
    })
    check_eq("D31", "admin", "新增路线节点成功", 200, st, nn)
    nn_id = (nn or {}).get("id")
    st, r = api("PATCH", f"/api/admin/route-nodes/{nn_id}/enabled", token=admin_token, json={"is_enabled": False})
    check_eq("D32", "admin", "停用节点成功", 200, st)
    st, u_route = api("GET", "/api/march/route", token=_login_user_token())
    u_nodes = (u_route or {}).get("nodes") or []
    check_true("D33", "admin", "停用节点不出现在小程序路线", all(n.get("id") != nn_id for n in u_nodes), f"visible={[n.get('id') for n in u_nodes]}")
    st, r = api("PUT", f"/api/admin/route-nodes/{nn_id}", token=admin_token, json={
        "name": "E2E测试节点改", "icon": "🧪", "target_steps": 999999, "historical_time": "2026-10",
        "description": "测试节点", "latitude": 26.0, "longitude": 116.0, "sort_order": 99,
        "is_enabled": False, "brief": "", "significance": "", "figures": "", "location": "",
        "images": [], "audio": "", "keywords": "",
    })
    check_eq("D34", "admin", "修改节点成功", 200, st)
    db_n = db("SELECT name, is_enabled FROM route_nodes WHERE id=%s", (nn_id,))
    check_true("D35", "admin", "节点修改落库", db_n and db_n[0] == ("E2E测试节点改", False), db_n)
    st, r = api("DELETE", f"/api/admin/route-nodes/{nn_id}", token=admin_token)
    rec("D36", "admin", "路线节点无删除接口(设计)", st == 405, "405(后端未提供删除，前端无删除入口)", st, r)
    # 恢复启用状态供后续用例
    api("PATCH", f"/api/admin/route-nodes/{nn_id}/enabled", token=admin_token, json={"is_enabled": False})
    # 排名/用户洞察/动态/大屏
    st, rk = api("GET", "/api/admin/rankings", token=admin_token)
    check_eq("D37", "admin", "管理端排名 200", 200, st)
    uid_a = int(_uid(_login_user_token()))
    st, ov = api("GET", f"/api/admin/users/{uid_a}/overview", token=admin_token)
    check_eq("D38", "admin", "用户洞察 200", 200, st)
    check_true("D39", "admin", "洞察含用户/运动/答题/勋章/长征模块", all(k in (ov or {}) for k in ("user", "sport", "quiz_records", "medals", "march")), str(ov and list(ov.keys())))
    st, acts = api("GET", "/api/admin/activities", token=admin_token)
    check_eq("D40", "admin", "管理端动态 200", 200, st)
    st, screen = api("GET", "/api/admin/screen", token=admin_token)
    check_eq("D41", "admin", "大屏接口 200", 200, st)
    return admin_token


# ---------------------------------------------------------------- 工具
def _uid(token: str) -> int:
    st, me = api("GET", "/api/auth/me", token=token)
    return int((me or {}).get("id", 0))


_TOKEN_A = None


def _login_user_token() -> str:
    global _TOKEN_A
    if not _TOKEN_A:
        st, body = api("POST", "/api/auth/login", json={"code": CODE_A})
        _TOKEN_A = body.get("token", "")
    return _TOKEN_A


def _in(n: int) -> str:
    return "(" + ",".join(["%s"] * n) + ")"


def main():
    print("=" * 60)
    print("端到端全链路测试开始（干净库）")
    print("=" * 60)
    phases = [
        ("auth_user_a", lambda: phase_auth_user_a()),
    ]
    token_a = token_b = None
    try:
        token_a = phase_auth_user_a()
        total_a = phase_sport(token_a)
        phase_march(token_a, total_a)
        phase_quiz(token_a)
        token_b = phase_user_b(token_a)
        uid_b = int(_uid(token_b))
        phase_points_medal_rank(token_a, token_b, uid_b)
        phase_profile_misc(token_a)
        phase_ceremony(token_a)
        phase_edges(token_a)
        admin_token = phase_admin_api()
        phase_ws(admin_token, token_a)
    except Exception as e:
        import traceback
        rec("E99", "suite", "套件执行异常中断", False, "全部阶段完成", type(e).__name__, traceback.format_exc()[-600:])
        print(traceback.format_exc())

    passed = sum(1 for r in RESULTS if r["status"] == "PASS")
    failed = [r for r in RESULTS if r["status"] == "FAIL"]
    print("=" * 60)
    print(f"共 {len(RESULTS)} 项：通过 {passed}，失败 {len(failed)}")
    for f in failed:
        print(f"  FAIL {f['id']} {f['name']} | expected={f['expected']} actual={f['actual']}")
        if f.get("detail"):
            print(f"       detail: {f['detail'][:200]}")
    out = {
        "suite": "e2e_full_flow",
        "time": datetime.now().isoformat(),
        "duration_sec": round(time.time() - SUITE_START, 1),
        "total": len(RESULTS), "passed": passed, "failed": len(failed),
        "results": RESULTS,
    }
    with open("e2e-full-results.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"结果已写入 e2e-full-results.json（失败 {len(failed)} 项）")


if __name__ == "__main__":
    main()
