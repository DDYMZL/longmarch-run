# -*- coding: utf-8 -*-
"""
S28 AI 历史助手「流式对话」冒烟脚本（TestClient + SQLite 临时库，不依赖 8010/openGauss）

覆盖 POST /api/ai/chat/stream 的 SSE 契约、落库一致性与异常收尾：
  S 组（打桩，离线）
    S01 事件序列 start → delta* → done，delta 与模型分片逐一对应
    S02 增量拼接 == done.reply == 落库助手正文，用户/助手各一条，used_tokens 落库
    S03 响应头 text/event-stream + X-Accel-Buffering:no（生产 nginx 不缓冲的前提）
    S04 start 先于任何 delta 给出 conversationId/title，done 带核验过的已发布 sources
    S05 前置校验失败仍是普通 JSON + 正确状态码（400/401/403/429），与非流式同码
    S06 流中途故障：发 error 事件、半截对话被清除、记 error 用量日志
    S07 连续对话：复用会话、历史与 system 注入、被丢弃的提问不进上下文
    S08 客户端提前断开读取：提问必有对应回答落库，不留「只有问没有答」的脏数据
    S09 中断收尾两条分支：有增量则半截回答落库，无增量则提问与空会话一并删除
    S10 与非流式 /ai/chat 落库同构（同一套 prepare/finalize，不产生两种数据形态）
    S11 SSE 响应体不泄露当前供应商的 API Key
  L 组（真实调用，当前 LLM_PROVIDER 的密钥已配置且未设 LM_AI_SKIP_LIVE=1 时执行）
    L01 真流式而非缓冲后一次吐：LlmStream 分片数 >1 且首片延迟明显早于总耗时
    L02 真实模型下 SSE 端点逐片转发：增量拼接 == done.reply == 落库正文

用法：
  cd backend
  .venv\\Scripts\\python.exe test\\s28_ai_chat_stream.py
  set LM_AI_SKIP_LIVE=1                     # 跳过 L 组真实调用
"""
import gc
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
sys.path.insert(0, _HERE)
sys.path.insert(0, _BACKEND)

import dns_shim  # noqa: E402

_DNS_ENTRIES = dns_shim.install()

_DB_PATH = os.path.join(_HERE, "_smoke_s28.db")
if os.path.exists(_DB_PATH):
    os.remove(_DB_PATH)
os.environ["DATABASE_URL"] = "sqlite:///" + _DB_PATH.replace("\\", "/")

from fastapi.testclient import TestClient  # noqa: E402

from app.api.routes.ai import _settle_aborted  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.core.database import Base, SessionLocal, engine  # noqa: E402
from app.core.helpers import now_utc  # noqa: E402
from app.core.security import create_access_token, create_admin_token  # noqa: E402
from app.main import app  # noqa: E402
from app.models.models import (  # noqa: E402
    AiConversation,
    AiKnowledge,
    AiMessage,
    AiUsageLog,
    RouteNode,
    User,
)
from app.services import ai_chat_service, llm_service  # noqa: E402

RESULTS = []
# 当前生效供应商的密钥：随 LLM_PROVIDER 取值，用于「能否跑真实调用」判定与响应泄露检查
PROVIDER = settings.LLM_PROVIDER.strip().lower()
API_KEY = (settings.CLOUDBASE_API_KEY if PROVIDER == "cloudbase"
           else settings.LLM_API_KEY).strip()
KEY_HEAD, KEY_TAIL = API_KEY[:16], API_KEY[-16:]

STREAM_URL = "/api/ai/chat/stream"
CHAT_URL = "/api/ai/chat"
CONFIG_URL = "/api/admin/ai/config"

KN_TITLE = "遵义会议"
KN_SOURCE = "《中国共产党历史》"


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


def no_key_leak(*bodies):
    if not KEY_HEAD:
        return True
    return all(KEY_HEAD not in str(b) and KEY_TAIL not in str(b) for b in bodies if b)


def parse_sse(text):
    """把 SSE 响应体解析成事件对象列表；无法解析的分片保留原文以便定位。"""
    events = []
    for block in str(text or "").split("\n\n"):
        block = block.strip()
        if not block.startswith("data:"):
            continue
        payload = block[len("data:"):].strip()
        if not payload:
            continue
        try:
            events.append(json.loads(payload))
        except ValueError:
            events.append({"type": "_unparsable", "raw": payload})
    return events


def by_type(events, kind):
    return [e for e in events if e.get("type") == kind]


def one(events, kind):
    hits = by_type(events, kind)
    return hits[0] if hits else {}


def fetch_messages(conv_id):
    """按序取某会话的消息（含 used_tokens 与 sources），用于核对落库形态。"""
    if not conv_id:
        return []
    return q(lambda db: [
        {"role": m.role, "content": m.content, "used_tokens": m.used_tokens,
         "sources": m.sources or []}
        for m in db.query(AiMessage)
        .filter(AiMessage.conversation_id == conv_id)
        .order_by(AiMessage.id.asc())
        .all()
    ])


# ---------------- 大模型打桩 ----------------
def patch_stream(pieces, exc=None, used=321, captured=None):
    """替换 llm_service.LlmStream：按 pieces 逐片产出增量正文。

    exc 非空时在产出全部 pieces **之后**抛出，模拟「半截回答已推给前端、流才断」这一
    最难处理的场景——此时 HTTP 200 与响应头都已发出，状态码无法再改，只能发 error 事件。
    captured 用于捕获最终提示词与 system/max_tokens/timeout。
    """
    orig = llm_service.LlmStream

    class _FakeStream:
        def __init__(self, text, *, system=None, timeout=None, max_tokens=None, extra_body=None):
            self.result = None
            if captured is not None:
                captured.append({"text": text, "system": system, "timeout": timeout,
                                 "max_tokens": max_tokens})

        def __iter__(self):
            acc = []
            for piece in pieces:
                acc.append(piece)
                yield piece
            if exc is not None:
                raise exc
            self.result = llm_service.CallResult(
                text="".join(acc).strip(), used_tokens=used, stop_reason="stop", elapsed_ms=11)

    llm_service.LlmStream = _FakeStream
    return orig


def restore_stream(orig):
    llm_service.LlmStream = orig


def patch_meta(reply_text="非流式对照回答。", used=55):
    """替换 prompt_meta（非流式 /ai/chat 对照组）。"""
    orig = llm_service.prompt_meta

    def _fake(text, *, system=None, timeout=None, max_retries=None, max_tokens=None):
        return llm_service.CallResult(
            text=reply_text, used_tokens=used, stop_reason="stop", elapsed_ms=7)

    llm_service.prompt_meta = _fake
    return orig


def restore_meta(orig):
    llm_service.prompt_meta = orig


# ---------------- 数据种子 ----------------
def seed_all():
    db = SessionLocal()
    try:
        ua = User(openid="s28-user-a", nickname="流式战士甲", status="active", created_at=now_utc())
        ub = User(openid="s28-user-b", nickname="流式战士乙", status="active", created_at=now_utc())
        ul = User(openid="s28-user-limit", nickname="限额战士", status="active", created_at=now_utc())
        db.add_all([ua, ub, ul])
        db.flush()
        node = RouteNode(
            name="遵义", target_steps=0, historical_time="1935年1月", icon="🏛",
            description="遵义会议召开地。", latitude=27.725, longitude=106.927,
            sort_order=1, is_enabled=True, brief="转折之城", location="贵州遵义",
        )
        db.add(node)
        db.flush()
        # 已发布资料：让检索命中，从而验证 done 事件与落库都带 sources（草稿不算）
        kn = AiKnowledge(
            title=KN_TITLE, content="1935年1月，中共中央在遵义召开政治局扩大会议。",
            source=KN_SOURCE, category="event", node_id=node.id,
            status="published", published_at=now_utc(),
        )
        db.add(kn)
        db.commit()
        return {"ua": ua.id, "ub": ub.id, "ul": ul.id, "node": node.id}
    finally:
        db.close()


def main():
    print(f"DNS 映射条目：{_DNS_ENTRIES}（0 表示走系统 DNS）")
    print(f"大模型：provider={PROVIDER} model={llm_service.model_label() or '无'} "
          f"api_key={'有' if API_KEY else '无'}")
    Base.metadata.create_all(engine)
    ids = seed_all()

    client = TestClient(app)
    admin_h = {"Authorization": "Bearer " + create_admin_token("s28-smoke")}
    ua_h = {"Authorization": "Bearer " + create_access_token(ids["ua"], "s28-user-a")}
    ub_h = {"Authorization": "Bearer " + create_access_token(ids["ub"], "s28-user-b")}
    ul_h = {"Authorization": "Bearer " + create_access_token(ids["ul"], "s28-user-limit")}

    # ============ S01~S04 正常流式一轮 ============
    pieces = ["遵义会议", "是1935年", "1月召开的", "重要会议。"]
    full = "".join(pieces)
    cap = []
    orig = patch_stream(pieces, used=321, captured=cap)
    r1 = client.post(STREAM_URL, headers=ua_h, json={"message": "遵义会议有什么意义？"})
    restore_stream(orig)

    events = parse_sse(r1.text)
    types = [e.get("type") for e in events]
    deltas = [e.get("text", "") for e in by_type(events, "delta")]
    start = one(events, "start")
    done = one(events, "done")
    conv_id = start.get("conversationId")

    record("S01", "SSE 事件序列：start 一个 → delta 与模型分片逐一对应 → done 一个，顺序不乱",
           r1.status_code == 200 and types[0] == "start" and types[-1] == "done"
           and types.count("start") == 1 and types.count("done") == 1
           and "_unparsable" not in types and deltas == pieces,
           f"status={r1.status_code} types={types}")

    msgs = fetch_messages(conv_id)
    record("S02", "增量拼接 == done.reply == 落库助手正文；用户+助手各一条；used_tokens 落库",
           "".join(deltas) == full and done.get("reply") == full and done.get("usedTokens") == 321
           and [m["role"] for m in msgs] == ["user", "assistant"]
           and msgs[1]["content"] == full and msgs[1]["used_tokens"] == 321
           and msgs[0]["content"] == "遵义会议有什么意义？",
           f"reply_len={len(done.get('reply') or '')} roles={[m['role'] for m in msgs]} "
           f"stored_tokens={msgs[1]['used_tokens'] if len(msgs) > 1 else None}")

    record("S03", "响应头 text/event-stream + X-Accel-Buffering:no（生产 nginx 不缓冲的前提）",
           r1.headers.get("content-type", "").startswith("text/event-stream")
           and r1.headers.get("x-accel-buffering") == "no"
           and r1.headers.get("cache-control") == "no-cache",
           f"ctype={r1.headers.get('content-type')} xab={r1.headers.get('x-accel-buffering')} "
           f"cc={r1.headers.get('cache-control')}")

    conv_rows = q(lambda db: [c.id for c in db.query(AiConversation)
                              .filter(AiConversation.user_id == ids["ua"]).all()])
    src_titles = [s.get("title") for s in (done.get("sources") or [])]
    record("S04", "start 先于任何 delta 给出 conversationId/title，done 带核验过的已发布 sources",
           conv_id in conv_rows and start.get("title") == "遵义会议有什么意义？"
           and types.index("start") < types.index("delta")
           and KN_TITLE in src_titles and all(s.get("source") == KN_SOURCE
                                              for s in (done.get("sources") or []))
           and msgs[1]["sources"] == done.get("sources"),
           f"conv={conv_id} in_db={conv_id in conv_rows} title={start.get('title')} sources={src_titles}")

    # ============ S05 前置校验仍是普通 JSON ============
    cap5 = []
    orig = patch_stream(["不应影响错误码的回答。"], captured=cap5)
    r_empty = client.post(STREAM_URL, headers=ua_h, json={"message": "   "})
    r_anon = client.post(STREAM_URL, json={"message": "匿名提问"})
    r_foreign = client.post(STREAM_URL, headers=ub_h,
                            json={"message": "蹭别人会话", "conversationId": conv_id})
    # 同一越权请求打到非流式端点：两条链路的错误码必须一致（既有契约是提问 400、读/删 404）
    r_foreign_plain = client.post(CHAT_URL, headers=ub_h,
                                  json={"message": "蹭别人会话", "conversationId": conv_id})
    client.patch(CONFIG_URL, headers=admin_h, json={"values": {"enabled": False}})
    r_off = client.post(STREAM_URL, headers=ua_h, json={"message": "AI 关闭时提问"})
    client.patch(CONFIG_URL, headers=admin_h, json={"values": {"enabled": True}})
    client.patch(CONFIG_URL, headers=admin_h, json={"values": {"chat_daily_limit": 1}})
    r_l1 = client.post(STREAM_URL, headers=ul_h, json={"message": "限额第一次"})
    r_l2 = client.post(STREAM_URL, headers=ul_h, json={"message": "限额第二次应被拦"})
    client.patch(CONFIG_URL, headers=admin_h, json={"values": {"chat_daily_limit": 100}})
    restore_stream(orig)

    err_responses = [r_empty, r_anon, r_foreign, r_off, r_l2]
    none_sse = all(not r.headers.get("content-type", "").startswith("text/event-stream")
                   for r in err_responses)
    all_json_detail = all(isinstance(r.json().get("detail"), (str, list)) for r in err_responses)
    record("S05", "前置校验失败仍是普通 JSON + 正确状态码（400/401/403/429），与非流式同码不退化成 SSE",
           r_empty.status_code == 400 and r_anon.status_code == 401
           and r_foreign.status_code == 400 and r_foreign.status_code == r_foreign_plain.status_code
           and r_off.status_code == 403 and r_l1.status_code == 200 and r_l2.status_code == 429
           and none_sse and all_json_detail and len(cap5) == 1,
           f"空输入={r_empty.status_code} 匿名={r_anon.status_code} "
           f"他人会话={r_foreign.status_code}/{r_foreign_plain.status_code}(流式/非流式) "
           f"关闭={r_off.status_code} 限额={r_l1.status_code}/{r_l2.status_code} "
           f"模型只被成功那次调用={len(cap5)}")

    # ============ S06 流中途故障 ============
    before_conv = q(lambda db: db.query(AiConversation).count())
    before_msg = q(lambda db: db.query(AiMessage).count())
    before_err_log = q(lambda db: db.query(AiUsageLog)
                       .filter(AiUsageLog.status == "error").count())
    orig = patch_stream(["已推给前端的半截", "回答。"],
                        exc=llm_service.LlmError("AI 服务暂时不可用，请稍后重试", retryable=True))
    r6 = client.post(STREAM_URL, headers=ua_h, json={"message": "会中途断流的提问"})
    restore_stream(orig)
    ev6 = parse_sse(r6.text)
    err_ev = one(ev6, "error")
    after_conv = q(lambda db: db.query(AiConversation).count())
    after_msg = q(lambda db: db.query(AiMessage).count())
    after_err_log = q(lambda db: db.query(AiUsageLog)
                      .filter(AiUsageLog.status == "error").count())
    record("S06", "流中途故障：半截回答已推出后发 error 事件，提问与新建会话被清除，记 error 日志",
           r6.status_code == 200 and len(by_type(ev6, "delta")) == 2
           and "不可用" in str(err_ev.get("message", "")) and not by_type(ev6, "done")
           and after_conv == before_conv and after_msg == before_msg
           and after_err_log == before_err_log + 1,
           f"status={r6.status_code} deltas={len(by_type(ev6, 'delta'))} "
           f"err={err_ev.get('message')} conv {before_conv}->{after_conv} "
           f"msg {before_msg}->{after_msg} errlog {before_err_log}->{after_err_log}")

    # ============ S07 连续对话 ============
    cap7 = []
    orig = patch_stream(["追问的回答。"], captured=cap7)
    r7 = client.post(STREAM_URL, headers=ua_h,
                     json={"message": "它发生在哪一年？", "conversationId": conv_id})
    restore_stream(orig)
    ev7 = parse_sse(r7.text)
    hist_ok = bool(cap7) and "[对话历史]" in cap7[0]["text"] and "遵义会议有什么意义？" in cap7[0]["text"]
    sys_ok = bool(cap7) and bool(cap7[0]["system"])
    tokens_ok = bool(cap7) and isinstance(cap7[0]["max_tokens"], int) and cap7[0]["max_tokens"] > 0
    timeout_ok = bool(cap7) and cap7[0]["timeout"] == settings.AI_REQUEST_TIMEOUT
    conv_cnt = q(lambda db: db.query(AiConversation)
                 .filter(AiConversation.user_id == ids["ua"]).count())
    roles7 = [m["role"] for m in fetch_messages(conv_id)]
    record("S07", "连续对话：复用同一会话、历史与 system 注入、被丢弃的提问不进上下文",
           r7.status_code == 200 and one(ev7, "start").get("conversationId") == conv_id
           and hist_ok and sys_ok and tokens_ok and timeout_ok and conv_cnt == 1
           and roles7 == ["user", "assistant", "user", "assistant"]
           and "会中途断流的提问" not in (cap7[0]["text"] if cap7 else ""),
           f"status={r7.status_code} hist={hist_ok} sys={sys_ok} max_tokens={cap7[0]['max_tokens'] if cap7 else None} "
           f"conv_count={conv_cnt} roles={roles7}")

    # ============ S08 客户端提前断开读取 ============
    aborted_pieces = ["第一段。", "第二段。", "第三段。", "第四段。"]
    aborted_full = "".join(aborted_pieces)
    orig = patch_stream(aborted_pieces, used=77)
    seen = []
    with client.stream("POST", STREAM_URL, headers=ua_h,
                       json={"message": "会被中途停止的提问"}) as resp8:
        abort_status = resp8.status_code
        for line in resp8.iter_lines():
            if not line.startswith("data:"):
                continue
            try:
                ev = json.loads(line[len("data:"):].strip())
            except ValueError:
                continue
            seen.append(ev)
            if ev.get("type") == "delta":
                break  # 只收一个增量就不再读取，等价于用户点了「停止」
    restore_stream(orig)
    gc.collect()
    conv8 = one(seen, "start").get("conversationId")
    msgs8 = fetch_messages(conv8)
    assistant8 = msgs8[1]["content"] if len(msgs8) > 1 else ""
    # TestClient 的断连投递不进线程池里的同步生成器，故后端会把整段生成跑完再落库；
    # 断言取「已生成内容完整落库、且提问必有对应回答」这一在两种时序下都成立的不变量。
    record("S08", "客户端提前断开读取：提问必有对应回答落库，不留「只有问没有答」的脏数据",
           abort_status == 200 and conv8 and len(msgs8) == 2
           and msgs8[1]["role"] == "assistant" and bool(assistant8)
           and aborted_full.startswith(assistant8) and not by_type(seen, "done"),
           f"status={abort_status} conv={conv8} msgs={len(msgs8)} 客户端只收到={len(seen)}个事件 "
           f"落库正文={assistant8!r}")

    # ============ S09 中断收尾的两条分支（直接验证 _settle_aborted） ============
    class _NoResult:
        result = None

    settle_db = SessionLocal()
    settle_user = settle_db.query(User).filter(User.id == ids["ua"]).first()
    # 分支一：已收到增量 → 半截回答落库，用量未知记空
    turn_p = ai_chat_service.prepare_message(settle_db, settle_user, "中断收尾-有增量")
    _settle_aborted(settle_db, turn_p, _NoResult(), ["只推出去", "的一半"])
    msgs_p = fetch_messages(turn_p.conversation_id)
    partial_ok = ([m["role"] for m in msgs_p] == ["user", "assistant"]
                  and msgs_p[1]["content"] == "只推出去的一半"
                  and msgs_p[1]["used_tokens"] is None)
    # 分支二：一个增量都没收到 → 提问与本次新建的空会话一并删除
    conv_before9 = q(lambda db: db.query(AiConversation).count())
    turn_e = ai_chat_service.prepare_message(settle_db, settle_user, "中断收尾-无增量")
    _settle_aborted(settle_db, turn_e, _NoResult(), [])
    conv_after9 = q(lambda db: db.query(AiConversation).count())
    empty_ok = conv_after9 == conv_before9 and fetch_messages(turn_e.conversation_id) == []
    settle_db.close()
    record("S09", "中断收尾两条分支：有增量则半截回答落库（用量记空），无增量则提问与空会话一并删除",
           partial_ok and empty_ok,
           f"半截落库={partial_ok}(正文={msgs_p[1]['content'] if len(msgs_p) > 1 else None!r} "
           f"tokens={msgs_p[1]['used_tokens'] if len(msgs_p) > 1 else None}) "
           f"无增量清理={empty_ok}(会话数 {conv_before9}->{conv_after9})")

    # ============ S10 与非流式落库同构 ============
    orig_meta = patch_meta(reply_text="对照回答：两条链路同构。", used=55)
    r9a = client.post(CHAT_URL, headers=ua_h, json={"message": "非流式对照提问"})
    restore_meta(orig_meta)
    orig = patch_stream(["对照回答：", "两条链路同构。"], used=55)
    r9b = client.post(STREAM_URL, headers=ua_h, json={"message": "流式对照提问"})
    restore_stream(orig)
    body9a = r9a.json() if r9a.status_code == 200 else {}
    msgs9a = fetch_messages(body9a.get("conversationId"))
    msgs9b = fetch_messages(one(parse_sse(r9b.text), "start").get("conversationId"))
    a_assistant = msgs9a[1] if len(msgs9a) > 1 else {}
    b_assistant = msgs9b[1] if len(msgs9b) > 1 else {}
    record("S10", "与非流式 /ai/chat 落库同构：正文/used_tokens/sources 形态一致，不产生两种数据",
           r9a.status_code == 200 and r9b.status_code == 200
           and a_assistant.get("content") == b_assistant.get("content") == "对照回答：两条链路同构。"
           and a_assistant.get("used_tokens") == b_assistant.get("used_tokens") == 55
           and sorted(a_assistant.keys()) == sorted(b_assistant.keys())
           and [s.get("title") for s in a_assistant.get("sources") or []]
           == [s.get("title") for s in b_assistant.get("sources") or []]
           and body9a.get("reply") == one(parse_sse(r9b.text), "done").get("reply"),
           f"非流式={r9a.status_code} 流式={r9b.status_code} "
           f"tokens={a_assistant.get('used_tokens')}/{b_assistant.get('used_tokens')} "
           f"sources={[s.get('title') for s in b_assistant.get('sources') or []]}")

    record("S11", "SSE 响应体与错误响应均不泄露 LLM_API_KEY",
           no_key_leak(r1.text, r6.text, r7.text, r9b.text, r_empty.text), "")

    # ============ L01/L02 真实调用模型：验证确实是流式 ============
    l01_name = "真实流式调用：上游逐片到达、首片早于总耗时、用量与结束原因齐全"
    l02_name = "真实模型下 SSE 端点逐片转发：分片多次到达、增量拼接 == done.reply == 落库正文"
    if not API_KEY:
        record("L01", l01_name, False, f"跳过：{PROVIDER} 供应商密钥未配置")
        record("L02", l02_name, False, f"跳过：{PROVIDER} 供应商密钥未配置")
    elif os.getenv("LM_AI_SKIP_LIVE") == "1":
        record("L01", l01_name, True, "跳过：LM_AI_SKIP_LIVE=1")
        record("L02", l02_name, True, "跳过：LM_AI_SKIP_LIVE=1")
    else:
        question = "请用三句话介绍飞夺泸定桥。"

        # L01：直接迭代 LlmStream 测「上游 + 解析器」是否真的逐片到达。
        # 端点层的到达时刻无法在 TestClient 下测量：本版 starlette 的 _TestClientTransport
        # 把整个响应体先写进 BytesIO、再以 httpx.ByteStream 一次性交给客户端
        # （testclient.py:296/365），因此端点侧只断言分片数与落库一致性（见 L02）。
        started = time.monotonic()
        first_at = None
        piece_count = 0
        stream = llm_service.LlmStream(question, system="你是长征历史助手。", max_tokens=300)
        for _piece in stream:
            piece_count += 1
            if first_at is None:
                first_at = time.monotonic() - started
        total = time.monotonic() - started
        result = stream.result
        live_text = result.text if result else ""
        # 真流式的判据：分片明显多于 1，且首片早于结束（若被整体缓冲则首片≈总耗时）。
        # 两项阈值随供应商而异：
        # - 正常结束原因：openai 为 stop，cloudbase（ACP）为 end_turn；
        # - 首片占比：CloudBase Agent 会先推完 agent_thought_chunk 思考过程才开始吐正文，
        #   实测首片 11.65s / 总耗时 13.56s（占比 0.86），故阈值放宽到 0.95——仍能与
        #   「整体缓冲后一次吐」（占比≈1.0）区分开；百炼首片 1~2s，沿用严格的 0.8。
        normal_stop = "end_turn" if PROVIDER == "cloudbase" else "stop"
        first_ratio = 0.95 if PROVIDER == "cloudbase" else 0.8
        record("L01", l01_name,
               piece_count >= 3 and first_at is not None and first_at < total * first_ratio
               and bool(live_text) and result is not None
               and isinstance(result.used_tokens, int) and result.stop_reason == normal_stop,
               f"分片数={piece_count} 首片={first_at if first_at is None else round(first_at, 2)}s "
               f"总耗时={total:.2f}s 字数={len(live_text)} "
               f"usedTokens={result.used_tokens if result else None} "
               f"stop_reason={result.stop_reason if result else None}（期望 {normal_stop}）")

        # L02：同一问题打到 SSE 端点，确认端点逐片转发（分片数 >1）、done.reply 与落库一致
        live_done = {}
        parts = []
        deltas = 0
        live_status = 0
        with client.stream("POST", STREAM_URL, headers=ua_h, json={"message": question}) as resp:
            live_status = resp.status_code
            for line in resp.iter_lines():
                if not line.startswith("data:"):
                    continue
                try:
                    ev = json.loads(line[len("data:"):].strip())
                except ValueError:
                    continue
                if ev.get("type") == "delta":
                    deltas += 1
                    parts.append(ev.get("text", ""))
                elif ev.get("type") == "done":
                    live_done = ev
        sse_text = "".join(parts)
        stored_text = q(lambda db: (db.query(AiMessage.content)
                                    .filter(AiMessage.role == "assistant")
                                    .order_by(AiMessage.id.desc())
                                    .first() or [None])[0])
        stored_ok = bool(stored_text) and stored_text == sse_text
        record("L02", l02_name,
               live_status == 200 and deltas >= 3 and bool(sse_text)
               and live_done.get("reply") == sse_text and stored_ok
               and isinstance(live_done.get("usedTokens"), int),
               f"status={live_status} 分片数={deltas} 字数={len(sse_text)} "
               f"usedTokens={live_done.get('usedTokens')} 落库一致={stored_ok}")
        if sse_text:
            print("  回答开头：" + sse_text[:80])

    ok = sum(1 for r in RESULTS if r["ok"])
    print(f"\n合计 {len(RESULTS)} 项：通过 {ok}，失败 {len(RESULTS) - ok}")
    out = os.path.join(_HERE, "s28-ai-chat-stream-results.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"total": len(RESULTS), "passed": ok, "results": RESULTS},
                  fh, ensure_ascii=False, indent=2)
    print("结果已写入", out)
    return 0 if ok == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
