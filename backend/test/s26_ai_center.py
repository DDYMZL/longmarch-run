# -*- coding: utf-8 -*-
"""
S26 AI 智能中心 冒烟脚本（TestClient + SQLite 临时库，不依赖 8010/openGauss）

覆盖需求 V1.0 验收点（历史助手 / 路线讲解 / 答题解析 / 管理端 AI 智能中心）：
  C 组 配置中心：读取生效值+默认+范围+提示词、覆盖运行参数、非法值拒绝、鉴权、不泄密钥
  K 组 知识库：增改删查、状态流转发布、校验、鉴权、发布后才可检索、节点绑定
  H 组 历史助手：对话落库+camelCase、连续对话带历史、会话列表/详情、归属隔离、删除、
                输入超长、空输入、AI 关闭 403、日限额 429、上游故障 502 且不残留、来源为已发布资料
  R 组 路线讲解：优先已发布知识、无知识回退节点字段、草稿不泄露、节点不存在、关闭时仍可用、不调模型
  Q 组 答题解析：题库已有解析直接返回(不调模型)、无解析才调模型、未作答拦截、AI 关闭、以库内答案为准
  W 组 题目工坊：任务+草稿持久化、任务列表/详情、草稿编辑/审核、幂等导入题库、鉴权、知识接地、失败落库
  G 组 回归与安全：旧出题链路不受影响、任何响应不泄露 CLOUDBASE_API_KEY
  L 组 真实调用 Agent（可选，配置了 API Key 且未设置 LM_AI_SKIP_LIVE=1 时执行）

用法：
  cd backend
  set LM_TEST_DNS_MAP=<gateway-host>=<ip>   # 本机 DNS 不可用时（仅 L 组真实调用需要）
  .venv\\Scripts\\python.exe test\\s26_ai_center.py
  set LM_AI_SKIP_LIVE=1                     # 跳过 L 组真实调用
"""
import io
import json
import os
import sys
from datetime import datetime, timedelta

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
sys.path.insert(0, _HERE)
sys.path.insert(0, _BACKEND)

import dns_shim  # noqa: E402

_DNS_ENTRIES = dns_shim.install()

_DB_PATH = os.path.join(_HERE, "_smoke_s26.db")
if os.path.exists(_DB_PATH):
    os.remove(_DB_PATH)
os.environ["DATABASE_URL"] = "sqlite:///" + _DB_PATH.replace("\\", "/")

from fastapi.testclient import TestClient  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.database import Base, SessionLocal, engine  # noqa: E402
from app.core.helpers import now_utc, today_str  # noqa: E402
from app.core.security import (  # noqa: E402
    create_access_token,
    create_admin_token,
    create_admin_token_for_user,
)
from app.main import app  # noqa: E402
from app.models.models import (  # noqa: E402
    AdminMenu,
    AdminRole,
    AdminRoleMenu,
    AdminUserRole,
    AiConversation,
    AiGeneratedQuestion,
    AiGenerationJob,
    AiKnowledge,
    AiMessage,
    AiUsageLog,
    DailyQuestion,
    Question,
    QuizAnswer,
    RouteNode,
    User,
)
from app.services import cloudbase_service  # noqa: E402

RESULTS = []
API_KEY = settings.CLOUDBASE_API_KEY.strip()
KEY_HEAD, KEY_TAIL = API_KEY[:16], API_KEY[-16:]

CHAT_URL = "/api/ai/chat"
CONV_URL = "/api/ai/conversations"
CONFIG_URL = "/api/admin/ai/config"
KNOW_URL = "/api/admin/ai/knowledge"
JOBS_URL = "/api/admin/ai/jobs"
DRAFTS_URL = "/api/admin/ai/drafts"
IMPORT_URL = "/api/admin/ai/drafts/import"
LEGACY_GEN_URL = "/api/admin/ai/generate-questions"


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:500]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name
          + ((" | " + str(detail)[:240]) if detail else ""))


def q(fn):
    db = SessionLocal()
    try:
        return fn(db)
    finally:
        db.close()


def no_key_leak(*responses):
    for resp in responses:
        if resp is None:
            continue
        body = resp.text
        if KEY_HEAD and (KEY_HEAD in body or KEY_TAIL in body):
            return False
    return True


# ---------------- CloudBase 打桩 ----------------
def patch_meta(reply_text="这是模拟的长征历史回答", exc=None, used=123):
    """替换 prompt_meta（历史助手/答题解析用），捕获最终提示词与 system。"""
    orig = cloudbase_service.prompt_meta
    captured = []

    def _fake(text, *, system=None, timeout=None, max_retries=None):
        captured.append({"text": text, "system": system, "timeout": timeout})
        if exc is not None:
            raise exc
        return cloudbase_service.CallResult(
            text=reply_text, used_tokens=used, stop_reason="end_turn", elapsed_ms=7
        )

    cloudbase_service.prompt_meta = _fake
    return orig, captured


def restore_meta(orig):
    cloudbase_service.prompt_meta = orig


def patch_prompt(reply=None, exc=None):
    """替换 prompt（题目工坊/旧出题链路用），捕获提示词。"""
    orig = cloudbase_service.prompt
    captured = []

    def _fake(text, timeout=None):
        captured.append(text)
        if exc is not None:
            raise exc
        return reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False)

    cloudbase_service.prompt = _fake
    return orig, captured


def restore_prompt(orig):
    cloudbase_service.prompt = orig


def fake_item(question, labels=("A", "B", "C", "D"), answer="B", analysis="解析"):
    return {
        "type": "single",
        "question": question,
        "options": [{"label": l, "text": f"{question}选项{l}"} for l in labels],
        "answer": [answer] if answer else [],
        "analysis": analysis,
    }


# ---------------- 数据种子 ----------------
def seed_all():
    db = SessionLocal()
    try:
        ua = User(openid="s26-user-a", nickname="战士甲", status="active", created_at=now_utc())
        ub = User(openid="s26-user-b", nickname="战士乙", status="active", created_at=now_utc())
        ul = User(openid="s26-user-limit", nickname="限额战士", status="active", created_at=now_utc())
        db.add_all([ua, ub, ul])
        db.flush()

        na = RouteNode(
            name="瑞金", target_steps=0, historical_time="1934年10月", icon="🚩",
            description="中央红军出发地。", latitude=25.885, longitude=116.027,
            sort_order=1, is_enabled=True, brief="长征出发地", significance="中央红军由此出发",
            figures="毛泽东、朱德", location="江西瑞金",
        )
        nb = RouteNode(
            name="遵义", target_steps=50000, historical_time="1935年1月", icon="🏛",
            description="遵义会议召开地。", latitude=27.725, longitude=106.927,
            sort_order=2, is_enabled=True, brief="转折之城", significance="确立了正确的领导",
        )
        db.add_all([na, nb])
        db.flush()

        q_with = Question(id=9001, type="single", question="遵义会议确立了谁的正确领导？",
                          options=[{"label": "A", "text": "甲"}, {"label": "B", "text": "乙"}],
                          answer=["B"], analysis="既有解析：这是题库已审核的标准解析。",
                          score=20, category="event", active=True)
        q_without = Question(id=9002, type="single", question="红军长征出发地是哪里？",
                             options=[{"label": "A", "text": "甲"}, {"label": "B", "text": "乙"}],
                             answer=["A"], analysis="", score=20, category="route", active=True)
        db.add_all([q_with, q_without])
        db.flush()

        # 让 ul 对 q_without 处于「已作答」状态，用于放开答题解析的防作弊闸门
        dq = DailyQuestion(user_id=ul.id, date=today_str(), question_ids=[9002])
        db.add(dq)
        db.flush()
        db.add(QuizAnswer(
            session_id=dq.id, user_id=ul.id, date=today_str(), seq=0, question_id=9002,
            started_at=now_utc(), deadline_at=now_utc() + timedelta(seconds=90),
            submitted_at=now_utc(), user_answer=["A"], is_correct=True, status="answered", points=20,
        ))
        db.commit()
        return {
            "ua": ua.id, "ub": ub.id, "ul": ul.id,
            "na": na.id, "nb": nb.id, "q_with": 9001, "q_without": 9002,
        }
    finally:
        db.close()


def seed_restricted_admin():
    db = SessionLocal()
    try:
        user = User(openid="s26-restricted", nickname="受限管理员", status="active", created_at=now_utc())
        db.add(user)
        db.flush()
        menu = AdminMenu(code="dashboard", name="驾驶舱", sort_order=0)
        role = AdminRole(code="s26viewer", name="仅驾驶舱")
        db.add_all([menu, role])
        db.flush()
        db.add(AdminRoleMenu(role_id=role.id, menu_id=menu.id))
        db.add(AdminUserRole(user_id=user.id, role_id=role.id, enabled=True))
        db.commit()
        return user.id
    finally:
        db.close()


def main():
    print(f"DNS 映射条目：{_DNS_ENTRIES}（0 表示走系统 DNS）")
    print(f"CloudBase：env_id={'有' if settings.CLOUDBASE_ENV_ID else '无'} "
          f"agent_id={'有' if settings.CLOUDBASE_AGENT_ID else '无'} api_key={'有' if API_KEY else '无'}")
    Base.metadata.create_all(engine)
    ids = seed_all()
    restricted_id = seed_restricted_admin()

    client = TestClient(app)
    admin_h = {"Authorization": "Bearer " + create_admin_token("s26-smoke")}
    restricted_h = {"Authorization": "Bearer " + create_admin_token_for_user(restricted_id)}
    ua_h = {"Authorization": "Bearer " + create_access_token(ids["ua"], "s26-user-a")}
    ub_h = {"Authorization": "Bearer " + create_access_token(ids["ub"], "s26-user-b")}
    ul_h = {"Authorization": "Bearer " + create_access_token(ids["ul"], "s26-user-limit")}

    # ============ C 组：配置中心 ============
    r = client.get(CONFIG_URL, headers=admin_h)
    body = r.json() if r.status_code == 200 else {}
    values = body.get("values", {})
    record("C01", "读取配置：生效值/默认/范围/提示词齐备，含三类提示词",
           r.status_code == 200 and values.get("enabled") is True
           and "chat_daily_limit" in values and "defaults" in body and "ranges" in body
           and set(body.get("prompts", {})) >= {"chat", "route", "quiz"} and body.get("prompt_version"),
           f"status={r.status_code} values_keys={sorted(values)[:5]} prompts={sorted(body.get('prompts', {}))}")

    r2 = client.patch(CONFIG_URL, headers=admin_h, json={
        "values": {"max_input_chars": 50, "context_turns": 2, "knowledge_top_k": 3},
        "prompt_version": "v2-test",
    })
    got = r2.json() if r2.status_code == 200 else {}
    gv = got.get("values", {})
    r2b = client.get(CONFIG_URL, headers=admin_h).json()
    record("C02", "覆盖运行参数生效并持久（max_input_chars=50/context_turns=2），overridden 标记",
           r2.status_code == 200 and gv.get("max_input_chars") == 50 and gv.get("context_turns") == 2
           and r2b.get("values", {}).get("max_input_chars") == 50
           and r2b.get("prompt_version") == "v2-test"
           and "ai_max_input_chars" in r2b.get("overridden", []),
           f"status={r2.status_code} max_input_chars={gv.get('max_input_chars')} "
           f"reread={r2b.get('values', {}).get('max_input_chars')} overridden={r2b.get('overridden')}")

    r_bad_int = client.patch(CONFIG_URL, headers=admin_h, json={"values": {"chat_daily_limit": -5}})
    r_bad_kind = client.patch(CONFIG_URL, headers=admin_h, json={"prompts": {"unknown": "x"}})
    record("C03", "非法配置拒绝：越界整数 400、未知提示词类型 400",
           r_bad_int.status_code == 400 and r_bad_kind.status_code == 400,
           f"bad_int={r_bad_int.status_code} bad_prompt_kind={r_bad_kind.status_code}")

    r_anon = client.get(CONFIG_URL)
    r_low = client.get(CONFIG_URL, headers=restricted_h)
    r_low_p = client.patch(CONFIG_URL, headers=restricted_h, json={"values": {"enabled": False}})
    record("C04", "配置中心鉴权：未登录 401、无 ai_config 菜单管理员 403（读+写）",
           r_anon.status_code == 401 and r_low.status_code == 403 and r_low_p.status_code == 403,
           f"anon={r_anon.status_code} restricted_get={r_low.status_code} restricted_patch={r_low_p.status_code}")

    record("C05", "配置响应不泄露 CLOUDBASE_API_KEY", no_key_leak(r, r2, r_bad_int),
           f"key_configured={bool(API_KEY)}")

    # ============ K 组：知识库 ============
    r_k1 = client.post(KNOW_URL, headers=admin_h, json={
        "title": "遵义会议资料", "content": "遵义会议于1935年1月召开，是党的历史上一个生死攸关的转折点。",
        "source": "《中国共产党历史》", "category": "event", "node_id": ids["nb"], "status": "draft",
        "related": ["遵义会议的意义是什么？"],
    })
    k1 = r_k1.json() if r_k1.status_code == 200 else {}
    kid = k1.get("id")
    record("K01", "新增知识资料（草稿）成功", r_k1.status_code == 200 and k1.get("status") == "draft"
           and k1.get("node_id") == ids["nb"] and k1.get("related") == ["遵义会议的意义是什么？"],
           f"status={r_k1.status_code} id={kid} st={k1.get('status')}")

    r_k2 = client.patch(f"{KNOW_URL}/{kid}/status", headers=admin_h, json={"status": "published"})
    k2 = r_k2.json() if r_k2.status_code == 200 else {}
    r_list_pub = client.get(KNOW_URL, headers=admin_h, params={"status": "published", "node_id": ids["nb"]})
    lp = r_list_pub.json() if r_list_pub.status_code == 200 else {}
    record("K02", "状态流转发布：published_at 落定、按状态+节点可检索到",
           r_k2.status_code == 200 and k2.get("status") == "published" and k2.get("published_at")
           and lp.get("total") == 1 and lp["items"][0]["id"] == kid,
           f"status={r_k2.status_code} published_at={bool(k2.get('published_at'))} list_total={lp.get('total')}")

    r_k3 = client.put(f"{KNOW_URL}/{kid}", headers=admin_h, json={
        "title": "遵义会议资料(修订)", "content": "修订后的正文内容。", "source": "修订来源",
        "category": "event", "node_id": ids["nb"], "status": "published", "related": [],
    })
    k3 = r_k3.json() if r_k3.status_code == 200 else {}
    record("K03", "编辑知识资料成功", r_k3.status_code == 200 and k3.get("title") == "遵义会议资料(修订)",
           f"status={r_k3.status_code} title={k3.get('title')}")

    r_e1 = client.post(KNOW_URL, headers=admin_h, json={"title": "  ", "content": "x"})
    r_e2 = client.post(KNOW_URL, headers=admin_h, json={"title": "t", "content": "x", "category": "poem"})
    r_e3 = client.post(KNOW_URL, headers=admin_h, json={"title": "t", "content": "x", "node_id": 999999})
    record("K04", "知识校验：空标题 400、非法分类 400、节点不存在 400",
           r_e1.status_code == 400 and r_e2.status_code == 400 and r_e3.status_code == 400,
           f"empty_title={r_e1.status_code} bad_cat={r_e2.status_code} bad_node={r_e3.status_code}")

    r_kl = client.get(KNOW_URL, headers=restricted_h)
    r_klp = client.post(KNOW_URL, headers=restricted_h, json={"title": "t", "content": "c"})
    record("K05", "知识库鉴权：无 ai_knowledge 菜单管理员 403（读+写）",
           r_kl.status_code == 403 and r_klp.status_code == 403,
           f"list={r_kl.status_code} create={r_klp.status_code}")

    # 建一条临时知识用于删除测试
    r_tmp = client.post(KNOW_URL, headers=admin_h, json={"title": "待删除", "content": "临时", "status": "draft"})
    tmp_id = r_tmp.json().get("id") if r_tmp.status_code == 200 else None
    r_del = client.delete(f"{KNOW_URL}/{tmp_id}", headers=admin_h)
    r_get_del = client.get(f"{KNOW_URL}/{tmp_id}", headers=admin_h)
    record("K06", "删除知识资料后再查为 404",
           r_del.status_code == 200 and r_get_del.status_code == 404,
           f"delete={r_del.status_code} get_after={r_get_del.status_code}")

    record("K07", "知识增删改响应不泄露密钥", no_key_leak(r_k1, r_k2, r_k3, r_list_pub), "")

    # ============ H 组：历史助手对话 ============
    orig_meta, cap = patch_meta(reply_text="模拟回答：遵义会议是重要转折点。", used=200)
    r_h1 = client.post(CHAT_URL, headers=ua_h, json={"message": "遵义会议有什么意义？"})
    h1 = r_h1.json() if r_h1.status_code == 200 else {}
    conv_a = h1.get("conversationId")
    dbmsg = q(lambda db: db.query(AiMessage).filter(AiMessage.conversation_id == conv_a).count()) if conv_a else 0
    record("H01", "对话成功：camelCase 契约(conversationId/reply)、用户+助手消息落库",
           r_h1.status_code == 200 and "conversationId" in h1 and h1.get("reply", "").startswith("模拟回答")
           and h1.get("usedTokens") == 200 and dbmsg == 2,
           f"status={r_h1.status_code} keys={sorted(h1)} msgs={dbmsg}")

    # H02 连续对话：带 conversationId，历史拼进提示词
    cap.clear()
    r_h2 = client.post(CHAT_URL, headers=ua_h, json={"message": "它发生在哪一年？", "conversationId": conv_a})
    hist_ok = cap and "[对话历史]" in cap[0]["text"] and "遵义会议有什么意义？" in cap[0]["text"]
    sys_ok = cap and cap[0]["system"] and "长征" in cap[0]["system"]
    conv_cnt = q(lambda db: db.query(AiConversation).filter(AiConversation.user_id == ids["ua"]).count())
    record("H02", "连续对话：复用会话、历史与系统提示注入、会话数不增",
           r_h2.status_code == 200 and r_h2.json().get("conversationId") == conv_a and hist_ok and sys_ok
           and conv_cnt == 1,
           f"status={r_h2.status_code} hist={bool(hist_ok)} sys={bool(sys_ok)} conv_count={conv_cnt}")

    r_list = client.get(CONV_URL, headers=ua_h)
    lst = r_list.json() if r_list.status_code == 200 else {}
    r_detail = client.get(f"{CONV_URL}/{conv_a}", headers=ua_h)
    det = r_detail.json() if r_detail.status_code == 200 else {}
    roles = [m["role"] for m in det.get("messages", [])]
    record("H03", "会话列表与详情：列表含该会话、详情消息按序含 user/assistant",
           r_list.status_code == 200 and lst.get("total") == 1
           and lst["items"][0]["conversationId"] == conv_a
           and r_detail.status_code == 200 and roles == ["user", "assistant", "user", "assistant"],
           f"list_total={lst.get('total')} roles={roles}")

    # H05 归属隔离
    r_cross_get = client.get(f"{CONV_URL}/{conv_a}", headers=ub_h)
    r_cross_del = client.delete(f"{CONV_URL}/{conv_a}", headers=ub_h)
    r_cross_chat = client.post(CHAT_URL, headers=ub_h, json={"message": "偷看别人会话", "conversationId": conv_a})
    conv_a_alive = q(lambda db: db.query(AiConversation).filter(AiConversation.id == conv_a).count())
    record("H05", "跨账号隔离：他人会话读/删均 404、带他人会话ID提问 400，会话未被破坏",
           r_cross_get.status_code == 404 and r_cross_del.status_code == 404
           and r_cross_chat.status_code == 400 and conv_a_alive == 1,
           f"get={r_cross_get.status_code} del={r_cross_del.status_code} chat={r_cross_chat.status_code} alive={conv_a_alive}")

    # H07 输入超长（max_input_chars=50）
    r_long = client.post(CHAT_URL, headers=ua_h, json={"message": "长" * 60})
    record("H07", "输入超长被拒（>max_input_chars=50）返回 400",
           r_long.status_code == 400 and "50" in str(r_long.json().get("detail", "")),
           f"status={r_long.status_code} detail={r_long.json().get('detail')}")

    # H08 空输入 → Pydantic 422
    r_empty = client.post(CHAT_URL, headers=ua_h, json={"message": ""})
    record("H08", "空输入被拒（422 参数校验）", r_empty.status_code == 422,
           f"status={r_empty.status_code}")

    # H12 来源为已发布资料（问题命中「遵义会议」已发布知识）
    srcs = h1.get("sources", []) or r_h2.json().get("sources", [])
    record("H12", "回答附带后端核验的已发布知识来源",
           any(s.get("id") == kid for s in srcs),
           f"sources={srcs}")

    restore_meta(orig_meta)

    # H11 上游故障 502 且不残留用户消息/新会话
    before_conv = q(lambda db: db.query(AiConversation).filter(AiConversation.user_id == ids["ua"]).count())
    before_msg = q(lambda db: db.query(AiMessage).count())
    orig_meta, _ = patch_meta(exc=cloudbase_service.CloudBaseError("AI 服务暂时不可用，请稍后重试", retryable=True))
    r_err = client.post(CHAT_URL, headers=ua_h, json={"message": "会触发故障的问题"})
    restore_meta(orig_meta)
    after_conv = q(lambda db: db.query(AiConversation).filter(AiConversation.user_id == ids["ua"]).count())
    after_msg = q(lambda db: db.query(AiMessage).count())
    err_logs = q(lambda db: db.query(AiUsageLog).filter(AiUsageLog.status == "error").count())
    record("H11", "上游故障映射 502，回滚本次用户消息（会话/消息数不变），记 error 日志",
           r_err.status_code == 502 and after_conv == before_conv and after_msg == before_msg and err_logs >= 1,
           f"status={r_err.status_code} conv {before_conv}->{after_conv} msg {before_msg}->{after_msg} errlog={err_logs}")

    # H09 AI 关闭 403
    client.patch(CONFIG_URL, headers=admin_h, json={"values": {"enabled": False}})
    orig_meta, cap = patch_meta(reply_text="不应被调用")
    r_off = client.post(CHAT_URL, headers=ua_h, json={"message": "AI 关闭时提问"})
    record("H09", "AI 总开关关闭时对话返回 403 且不调用模型",
           r_off.status_code == 403 and len(cap) == 0 and "未开放" in str(r_off.json().get("detail", "")),
           f"status={r_off.status_code} model_called={len(cap)} detail={r_off.json().get('detail')}")
    restore_meta(orig_meta)
    client.patch(CONFIG_URL, headers=admin_h, json={"values": {"enabled": True}})

    # H10 日限额 429（把 chat_daily_limit 降到 2，用专用用户 ul；测完恢复到 100 不干扰后续）
    client.patch(CONFIG_URL, headers=admin_h, json={"values": {"chat_daily_limit": 2}})
    orig_meta, _ = patch_meta(reply_text="限额测试回答")
    r_l1 = client.post(CHAT_URL, headers=ul_h, json={"message": "第一次"})
    r_l2 = client.post(CHAT_URL, headers=ul_h, json={"message": "第二次"})
    r_l3 = client.post(CHAT_URL, headers=ul_h, json={"message": "第三次应被限"})
    restore_meta(orig_meta)
    client.patch(CONFIG_URL, headers=admin_h, json={"values": {"chat_daily_limit": 100}})
    record("H10", "用户日限额：前 2 次成功，第 3 次 429",
           r_l1.status_code == 200 and r_l2.status_code == 200 and r_l3.status_code == 429,
           f"1st={r_l1.status_code} 2nd={r_l2.status_code} 3rd={r_l3.status_code}")

    # H06 删除本人会话
    r_del_own = client.delete(f"{CONV_URL}/{conv_a}", headers=ua_h)
    r_get_after = client.get(f"{CONV_URL}/{conv_a}", headers=ua_h)
    msgs_left = q(lambda db: db.query(AiMessage).filter(AiMessage.conversation_id == conv_a).count())
    record("H06", "删除本人会话：200 后详情 404、消息一并清除",
           r_del_own.status_code == 200 and r_get_after.status_code == 404 and msgs_left == 0,
           f"del={r_del_own.status_code} get_after={r_get_after.status_code} msgs_left={msgs_left}")

    # H13/H14 密钥不泄露 + 成功用量日志
    ok_logs = q(lambda db: db.query(AiUsageLog).filter(AiUsageLog.status == "success").count())
    record("H13", "对话相关响应不泄露密钥", no_key_leak(r_h1, r_h2, r_err, r_l1), "")
    record("H14", "成功调用写入 ai_usage_logs（feature=chat）", ok_logs >= 3,
           f"success_logs={ok_logs}")

    # ============ R 组：路线讲解 ============
    # 发布一条绑定 na(瑞金) 的知识，验证优先取已发布知识
    client.post(KNOW_URL, headers=admin_h, json={
        "title": "瑞金出发", "content": "1934年10月，中央红军从瑞金等地出发，开始战略转移。",
        "source": "史料", "category": "route", "node_id": ids["na"], "status": "published",
        "related": ["中央红军何时出发？"],
    })
    r_r1 = client.get(f"/api/ai/route-guide/{ids['na']}", headers=ua_h)
    g1 = r_r1.json() if r_r1.status_code == 200 else {}
    record("R01", "节点讲解优先取已发布知识：source_type=knowledge、正文/来源/相关问题来自知识",
           r_r1.status_code == 200 and g1.get("sourceType") == "knowledge"
           and "战略转移" in g1.get("content", "") and g1.get("relatedQuestions") == ["中央红军何时出发？"],
           f"status={r_r1.status_code} type={g1.get('sourceType')} related={g1.get('relatedQuestions')}")

    # 新建一个「仅有草稿知识」的节点，验证回退到节点字段且草稿不泄露
    def _mk_node(db):
        n = RouteNode(
            name="于都", target_steps=1000, historical_time="1934年10月", icon="🌊",
            description="于都河畔。", latitude=25.95, longitude=115.41, sort_order=3,
            is_enabled=True, brief="于都河渡口", significance="红军夜渡于都河")
        db.add(n)
        db.commit()
        return n.id
    nc = q(_mk_node)
    client.post(KNOW_URL, headers=admin_h, json={
        "title": "于都草稿", "content": "草稿SECRET", "node_id": nc, "status": "draft"})
    r_r2 = client.get(f"/api/ai/route-guide/{nc}", headers=ua_h)
    g2 = r_r2.json() if r_r2.status_code == 200 else {}
    record("R02/R03", "无已发布知识时回退节点字段(source_type=node)，且草稿内容绝不出现",
           r_r2.status_code == 200 and g2.get("sourceType") == "node"
           and "于都河" in (g2.get("content", "") + g2.get("title", ""))
           and "SECRET" not in json.dumps(g2, ensure_ascii=False),
           f"status={r_r2.status_code} type={g2.get('sourceType')} content={g2.get('content', '')[:40]}")

    r_r4 = client.get("/api/ai/route-guide/999999", headers=ua_h)
    record("R04", "节点不存在返回 404", r_r4.status_code == 404, f"status={r_r4.status_code}")

    # R05/R06 AI 关闭 + 打桩探针：讲解不调模型、关闭时仍可用
    client.patch(CONFIG_URL, headers=admin_h, json={"values": {"enabled": False}})
    orig_meta, cap = patch_meta(exc=AssertionError("讲解不应调用模型"))
    r_r5 = client.get(f"/api/ai/route-guide/{ids['na']}", headers=ua_h)
    restore_meta(orig_meta)
    client.patch(CONFIG_URL, headers=admin_h, json={"values": {"enabled": True}})
    record("R05/R06", "节点讲解不调用模型（AI 关闭仍 200，模型未被触发）",
           r_r5.status_code == 200 and len(cap) == 0, f"status={r_r5.status_code} model_called={len(cap)}")

    # ============ Q 组：答题解析 ============
    # Q01 题库已有解析（q_with）：ul 未作答该题→会被防作弊闸门拦；改用直接对 q_with 建作答记录
    q(lambda db: (db.add(QuizAnswer(
        session_id=1, user_id=ids["ul"], date=today_str(), seq=1, question_id=9001,
        started_at=now_utc(), deadline_at=now_utc(), submitted_at=now_utc(),
        user_answer=["B"], is_correct=True, status="answered", points=20)), db.commit())[1])
    orig_meta, cap = patch_meta(reply_text="不应被调用")
    r_q1 = client.get("/api/ai/quiz-explanation/9001", headers=ul_h)
    e1 = r_q1.json() if r_q1.status_code == 200 else {}
    restore_meta(orig_meta)
    record("Q01", "题库已有解析直接返回：source_type=bank、解析为题库原文、不调模型",
           r_q1.status_code == 200 and e1.get("sourceType") == "bank"
           and e1.get("analysis") == "既有解析：这是题库已审核的标准解析。" and len(cap) == 0,
           f"status={r_q1.status_code} type={e1.get('sourceType')} model_called={len(cap)}")

    # Q03 未作答拦截：ua 未作答 q_without(9002) → 400
    r_q3 = client.get("/api/ai/quiz-explanation/9002", headers=ua_h)
    record("Q03", "防作弊：未作答/未超时的题目查看解析被拒（400）",
           r_q3.status_code == 400 and "作答" in str(r_q3.json().get("detail", "")),
           f"status={r_q3.status_code} detail={r_q3.json().get('detail')}")

    # Q02 无解析题（q_without, ul 已作答）→ 调模型
    orig_meta, cap = patch_meta(reply_text="AI 生成解析：出发地是瑞金。", used=88)
    r_q2 = client.get("/api/ai/quiz-explanation/9002", headers=ul_h)
    e2 = r_q2.json() if r_q2.status_code == 200 else {}
    # 断言提示词内含库内正确答案，而非客户端可篡改内容
    prompt_has_answer = cap and "【正确答案】A" in cap[0]["text"]
    restore_meta(orig_meta)
    record("Q02", "题库无解析时调用模型：source_type=ai、提示词以库内正确答案为准",
           r_q2.status_code == 200 and e2.get("sourceType") == "ai"
           and e2.get("analysis", "").startswith("AI 生成解析") and e2.get("answer") == ["A"]
           and prompt_has_answer,
           f"status={r_q2.status_code} type={e2.get('sourceType')} answer={e2.get('answer')} ans_in_prompt={bool(prompt_has_answer)}")

    # Q05 AI 关闭 + 无解析 → 403
    client.patch(CONFIG_URL, headers=admin_h, json={"values": {"enabled": False}})
    r_q5 = client.get("/api/ai/quiz-explanation/9002", headers=ul_h)
    client.patch(CONFIG_URL, headers=admin_h, json={"values": {"enabled": True}})
    record("Q05", "AI 关闭且题库无解析时返回 403", r_q5.status_code == 403, f"status={r_q5.status_code}")

    r_q6 = client.get("/api/ai/quiz-explanation/888888", headers=ul_h)
    record("Q06", "题目不存在返回 400", r_q6.status_code == 400, f"status={r_q6.status_code}")

    # ============ W 组：题目工坊 ============
    orig_p, pcap = patch_prompt(reply=[fake_item("工坊生成题1"), fake_item("工坊生成题2")])
    r_w1 = client.post(JOBS_URL, headers=admin_h, json={
        "topic": "红军长征重要战役", "count": 2, "difficulty": "medium", "category": "event"})
    w1 = r_w1.json() if r_w1.status_code == 200 else {}
    job_id = w1.get("id")
    restore_prompt(orig_p)
    job_rows = q(lambda db: db.query(AiGenerationJob).filter(AiGenerationJob.id == job_id).count()) if job_id else 0
    draft_rows = q(lambda db: db.query(AiGeneratedQuestion).filter(AiGeneratedQuestion.job_id == job_id).count()) if job_id else 0
    record("W01", "发起出题任务：任务与草稿持久化落库",
           r_w1.status_code == 200 and w1.get("status") in ("success", "partial")
           and len(w1.get("drafts", [])) == 2 and job_rows == 1 and draft_rows == 2,
           f"status={r_w1.status_code} job_status={w1.get('status')} drafts={len(w1.get('drafts', []))} db_job={job_rows} db_draft={draft_rows}")

    r_w2 = client.get(JOBS_URL, headers=admin_h)
    l2 = r_w2.json() if r_w2.status_code == 200 else {}
    r_w2b = client.get(f"{JOBS_URL}/{job_id}", headers=admin_h)
    d2b = r_w2b.json() if r_w2b.status_code == 200 else {}
    record("W02", "任务列表与详情可回溯（详情含草稿）",
           r_w2.status_code == 200 and l2.get("total") >= 1
           and r_w2b.status_code == 200 and len(d2b.get("drafts", [])) == 2,
           f"list_total={l2.get('total')} detail_drafts={len(d2b.get('drafts', []))}")

    r_w3 = client.get(DRAFTS_URL, headers=admin_h, params={"job_id": job_id})
    l3 = r_w3.json() if r_w3.status_code == 200 else {}
    draft_ids = [d["id"] for d in l3.get("items", [])]
    record("W03", "按任务查草稿列表", r_w3.status_code == 200 and l3.get("total") == 2 and len(draft_ids) == 2,
           f"total={l3.get('total')} ids={draft_ids}")

    # W04 编辑草稿（改成题干为空 → 应重算出 errors）
    first_id = draft_ids[0]
    r_w4 = client.put(f"{DRAFTS_URL}/{first_id}", headers=admin_h, json={
        "data": {"type": "single", "question": "", "options": [{"label": "A", "text": "甲"}, {"label": "B", "text": "乙"}],
                 "answer": ["A"], "analysis": "x", "score": 20, "category": "event"}})
    w4 = r_w4.json() if r_w4.status_code == 200 else {}
    record("W04", "编辑草稿重算待修正问题（题干为空 → errors 非空）",
           r_w4.status_code == 200 and len(w4.get("errors", [])) > 0,
           f"status={r_w4.status_code} errors={w4.get('errors')}")

    # 修回合法，再审核通过
    client.put(f"{DRAFTS_URL}/{first_id}", headers=admin_h, json={
        "data": {"type": "single", "question": "工坊修订题1", "options": [{"label": "A", "text": "甲"}, {"label": "B", "text": "乙"}],
                 "answer": ["A"], "analysis": "修订解析", "score": 20, "category": "event"}})
    r_w5 = client.patch(f"{DRAFTS_URL}/{first_id}/status", headers=admin_h, json={"status": "approved"})
    w5 = r_w5.json() if r_w5.status_code == 200 else {}
    second_id = draft_ids[1]
    r_w5b = client.patch(f"{DRAFTS_URL}/{second_id}/status", headers=admin_h, json={"status": "rejected"})
    record("W05", "审核草稿：通过→approved、驳回→rejected",
           r_w5.status_code == 200 and w5.get("status") == "approved"
           and r_w5b.status_code == 200 and r_w5b.json().get("status") == "rejected",
           f"approve={w5.get('status')} reject={r_w5b.json().get('status') if r_w5b.status_code==200 else r_w5b.status_code}")

    # W06 导入（含 1 通过 + 1 驳回；仅通过的可导入）
    q_before = q(lambda db: db.query(Question).count())
    r_w6 = client.post(IMPORT_URL, headers=admin_h, json={"draft_ids": [first_id, second_id]})
    w6 = r_w6.json() if r_w6.status_code == 200 else {}
    q_after = q(lambda db: db.query(Question).count())
    imported_did = q(lambda db: db.query(AiGeneratedQuestion).filter(AiGeneratedQuestion.id == first_id).first().status)
    imported_qid = q(lambda db: db.query(AiGeneratedQuestion).filter(AiGeneratedQuestion.id == first_id).first().question_id)
    record("W06", "导入审核通过草稿到题库：仅通过项入库、置 imported 且回填 question_id、驳回项计入 failed",
           r_w6.status_code == 200 and w6.get("imported") == 1 and w6.get("failed") == 1
           and q_after == q_before + 1 and imported_did == "imported" and imported_qid,
           f"imported={w6.get('imported')} failed={w6.get('failed')} q {q_before}->{q_after} draft_status={imported_did} qid={imported_qid}")

    # W07 幂等：重复导入同批 → skipped，不再新增题目
    r_w7 = client.post(IMPORT_URL, headers=admin_h, json={"draft_ids": [first_id]})
    w7 = r_w7.json() if r_w7.status_code == 200 else {}
    q_after2 = q(lambda db: db.query(Question).count())
    record("W07", "导入幂等：重复导入已导入草稿被 skipped，题库不再新增",
           r_w7.status_code == 200 and w7.get("imported") == 0 and w7.get("skipped") == 1 and q_after2 == q_after,
           f"imported={w7.get('imported')} skipped={w7.get('skipped')} q {q_after}->{q_after2}")

    r_w9 = client.post(JOBS_URL, headers=restricted_h, json={"topic": "x", "count": 1})
    r_w9b = client.get(DRAFTS_URL, headers=restricted_h)
    record("W09", "题目工坊鉴权：无 ai_workshop 菜单管理员 403",
           r_w9.status_code == 403 and r_w9b.status_code == 403,
           f"jobs={r_w9.status_code} drafts={r_w9b.status_code}")

    # W10 知识接地：带 knowledge_ids 时参考资料进入提示词
    kn = q(lambda db: db.query(AiKnowledge).filter(AiKnowledge.status == "published").first())
    if kn:
        orig_p, pcap = patch_prompt(reply=[fake_item("知识接地题")])
        r_w10 = client.post(JOBS_URL, headers=admin_h, json={
            "topic": "长征", "count": 1, "knowledge_ids": [kn.id]})
        restore_prompt(orig_p)
        grounded = any((kn.content[:12] in c) for c in pcap)
        record("W10", "知识接地出题：所选已发布资料正文进入提示词",
               r_w10.status_code == 200 and grounded, f"status={r_w10.status_code} grounded={grounded}")
    else:
        record("W10", "知识接地出题", False, "无已发布知识可供接地")

    # W11 生成失败：任务落 failed 且返回 502
    orig_p, _ = patch_prompt(exc=cloudbase_service.CloudBaseError("AI 服务暂时不可用，请稍后重试", retryable=True))
    r_w11 = client.post(JOBS_URL, headers=admin_h, json={"topic": "失败任务", "count": 1})
    restore_prompt(orig_p)
    failed_jobs = q(lambda db: db.query(AiGenerationJob).filter(AiGenerationJob.status == "failed").count())
    record("W11", "生成失败：返回 502 且任务以 failed 落库（可回溯）",
           r_w11.status_code == 502 and failed_jobs >= 1,
           f"status={r_w11.status_code} failed_jobs={failed_jobs}")

    # ============ G 组：回归与安全 ============
    orig_p, _ = patch_prompt(reply=[fake_item("旧链路回归题")])
    r_g1 = client.post(LEGACY_GEN_URL, headers=admin_h, json={"topic": "长征", "count": 1})
    restore_prompt(orig_p)
    g1j = r_g1.json() if r_g1.status_code == 200 else {}
    record("G01", "旧内存态出题链路(generate-questions)不受影响",
           r_g1.status_code == 200 and g1j.get("generated") == 1,
           f"status={r_g1.status_code} generated={g1j.get('generated')}")

    record("G02", "工坊/导入/旧链路响应不泄露密钥",
           no_key_leak(r_w1, r_w6, r_g1, r_q2, r_r1), "")

    # ============ L 组：真实调用 Agent（可选）============
    if not API_KEY or os.getenv("LM_AI_SKIP_LIVE") == "1":
        record("L01", "真实调用 Agent 完成一次历史助手对话", True,
               "跳过：未配置 API Key 或 LM_AI_SKIP_LIVE=1")
    else:
        r_live = client.post(CHAT_URL, headers=ua_h, json={"message": "请用一句话介绍遵义会议的意义。"})
        live = r_live.json() if r_live.status_code == 200 else {}
        record("L01", "真实调用 Agent 完成一次历史助手对话（回答非空、捕获平台用量）",
               r_live.status_code == 200 and len(live.get("reply", "")) >= 8
               and live.get("usedTokens") is not None,
               f"status={r_live.status_code} reply_len={len(live.get('reply',''))} usedTokens={live.get('usedTokens')}")
        if live.get("reply"):
            print("  真实回答样例：" + live["reply"][:160].replace("\n", " "))


def teardown():
    engine.dispose()
    try:
        if os.path.exists(_DB_PATH):
            os.remove(_DB_PATH)
    except OSError as exc:
        print(f"清理临时库失败（可忽略）：{exc}")


if __name__ == "__main__":
    try:
        main()
    finally:
        teardown()
    passed = sum(1 for r in RESULTS if r["ok"])
    summary = {"suite": "s26_ai_center", "total": len(RESULTS),
               "passed": passed, "failed": len(RESULTS) - passed, "results": RESULTS}
    out_path = os.path.join(_HERE, "s26-ai-center-results.json")
    with io.open(out_path, "w", encoding="utf-8") as fp:
        json.dump(summary, fp, ensure_ascii=False, indent=2)
    print(f"\n合计 {len(RESULTS)} 项：通过 {passed}，失败 {len(RESULTS) - passed}")
    print("结果已写入 " + out_path)
    sys.exit(0 if passed == len(RESULTS) else 1)
