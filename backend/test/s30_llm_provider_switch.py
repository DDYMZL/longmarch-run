# -*- coding: utf-8 -*-
"""
S30 大模型供应商可切换（LLM_PROVIDER）冒烟脚本（本地桩服务器 + 可选真实调用）

背景：AI 上游由「一家供应商硬绑定」改为「门面 + 适配器」结构——`llm_service` 按
`LLM_PROVIDER` 分派到 `llm_openai`（OpenAI Chat Completions 兼容）或 `llm_cloudbase`
（腾讯云 CloudBase Agent ACP），两套凭证常驻 env，切换只改一行。本脚本验证这次改造
没有破坏任一协议实现，且分派、配置校验、错误映射、用量口径均符合约定。

  A 组（分派与配置，离线）
    A01 provider=cloudbase → 走 ACP 适配器，model_label 取 Agent ID
    A02 provider=openai → 走 OpenAI 适配器，model_label 取真实模型名
    A03 provider 取值非法 → prompt_meta 抛 LlmError（含取值），model_label 不抛异常
    A04 门面重新导出的 LlmError/CallResult 与各适配器是同一个类对象（isinstance 成立）
    A05 cloudbase 缺 API Key → 构造 LlmStream 与 prompt_meta 均在发请求前就抛错
    A06 openai 缺 API Key → 同上
  B 组（OpenAI 适配器，本地桩，离线）
    B01 非流式请求体正确（model / system role / stream=false / EXTRA_BODY 透传 / 不带 max_tokens）
    B02 显式传 max_tokens 时进请求体
    B03 流式逐片产出，收尾 usage 分片被采纳，stream_options.include_usage 已索取
    B04 出题链路 prompt() 用 LLM_QUESTION_EXTRA_BODY 覆盖 LLM_EXTRA_BODY
    B05 错误映射：401 鉴权(不可重试) / 429 与 500 (可重试) / finish_reason=length 未正常结束
    B06 可重试错误按 AI_MAX_RETRIES 重试后成功
    B07 空正文按「返回空内容」处理且可重试
  C 组（CloudBase 适配器，本地桩，离线）
    C01 请求体为 JSON-RPC session/prompt，system 前缀拼接，Accept: text/event-stream
    C02 SSE 解析：只拼 agent_message_chunk，思考/阶段事件忽略，usage_update 与终态被取用
    C03 流式分片数 >1 且 result 与非流式同构
    C04 max_tokens / extra_body 不进请求体（ACP 无对应参数）
    C05 stopReason=max_tokens → 未正常结束；空正文 → 返回空内容
    C06 显式 CLOUDBASE_AGENT_URL 优先于 ENV_ID/AGENT_ID 拼接
    C07 401 → 提示检查 CLOUDBASE_API_KEY，且异常文案不泄露密钥
  D 组（真实调用，当前 provider 配置齐备且未设 LM_AI_SKIP_LIVE=1 时执行）
    D01 真实非流式：拿到非空正文与正常结束原因
    D02 真实流式：分片数 >1 且首片明显早于总耗时（真增量而非缓冲后一次吐）
    D03 真实出题：长输出 JSON 数组可解析（验证 ACP 下不被截断）

用法：
  cd backend
  python test\\s30_llm_provider_switch.py
  set LM_AI_SKIP_LIVE=1                     # 跳过 D 组真实调用
"""
import json
import os
import sys
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
sys.path.insert(0, _HERE)
sys.path.insert(0, _BACKEND)

from app.core.config import settings  # noqa: E402
from app.services import (  # noqa: E402
    llm_base,
    llm_cloudbase,
    llm_openai,
    llm_service,
)

RESULTS = []

# 供应商取值一律用门面常量，避免测试与实现各写一份字面量
P_OPENAI = llm_service.PROVIDER_OPENAI
P_CLOUDBASE = llm_service.PROVIDER_CLOUDBASE

# 所有可能被覆盖的配置项；每个用例结束都还原，避免相互污染
_SETTING_KEYS = (
    "LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY",
    "LLM_EXTRA_BODY", "LLM_QUESTION_EXTRA_BODY",
    "CLOUDBASE_ENV_ID", "CLOUDBASE_AGENT_ID", "CLOUDBASE_API_KEY", "CLOUDBASE_AGENT_URL",
    "LLM_TIMEOUT_SECONDS", "AI_MAX_RETRIES",
)


def record(case_id, name, ok, detail=""):
    RESULTS.append({"id": case_id, "name": name, "ok": bool(ok), "detail": str(detail)[:500]})
    print(("PASS " if ok else "FAIL ") + case_id + " " + name
          + ((" | " + str(detail)[:240]) if detail else ""))


@contextmanager
def provider(name, **overrides):
    """临时切换供应商与相关配置，退出时逐项还原。"""
    saved = {k: getattr(settings, k) for k in _SETTING_KEYS}
    try:
        settings.LLM_PROVIDER = name
        for key, value in overrides.items():
            setattr(settings, key, value)
        yield
    finally:
        for key, value in saved.items():
            setattr(settings, key, value)


def error_of(fn, *args, **kwargs):
    """执行并捕获 LlmError，返回异常对象（未抛错返回 None）。"""
    try:
        fn(*args, **kwargs)
    except llm_service.LlmError as exc:
        return exc
    return None


# ---------------- 本地桩服务器 ----------------
_STUB_DEFAULTS = {
    "pieces": ["遵义会议", "是党的", "历史上", "生死攸关的转折点"],
    "used": 42,
    "finish_reason": "stop",      # OpenAI 兼容协议的结束原因
    "acp_stop": "end_turn",       # ACP 的结束原因
    "thoughts": ["先回顾一下史实"],  # ACP 思考过程分片，必须被忽略
    "mode": "ok",                 # ok / http_401 / http_429 / http_500
    "fail_times": 0,              # 前 N 次调用返回可重试错误（验证重试）
    "fail_status": 500,
}
STUB = dict(_STUB_DEFAULTS, calls=0, requests=[])
_LOCK = threading.Lock()


def reset_stub(**overrides):
    with _LOCK:
        STUB.clear()
        STUB.update(_STUB_DEFAULTS, calls=0, requests=[])
        STUB.update(overrides)


def last_request():
    with _LOCK:
        return STUB["requests"][-1] if STUB["requests"] else {}


class _StubHandler(BaseHTTPRequestHandler):
    """同时充当两种上游：/chat/completions（OpenAI 兼容）与 /acp（CloudBase ACP）。"""

    def log_message(self, *args):  # 静音，避免污染用例输出
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            body = {}
        with _LOCK:
            STUB["requests"].append(
                {"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()},
                 "body": body}
            )
            calls, fail_times = STUB["calls"], STUB["fail_times"]
            STUB["calls"] = calls + 1
            mode, fail_status = STUB["mode"], STUB["fail_status"]
        if calls < fail_times:
            return self._send_json(fail_status, {"error": {"code": "stub_transient"}})
        if mode.startswith("http_"):
            return self._send_json(int(mode.split("_")[1]), {"error": {"code": "stub_error"}})
        if "/chat/completions" in self.path:
            return self._openai(body)
        return self._acp()

    def _send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_sse(self, events):
        data = b"".join(
            f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode("utf-8") for ev in events
        ) + b"data: [DONE]\n\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _openai(self, body):
        with _LOCK:
            pieces, used, finish = STUB["pieces"], STUB["used"], STUB["finish_reason"]
        text = "".join(pieces)
        if body.get("stream"):
            events = [{"choices": [{"delta": {"content": p}, "finish_reason": None}]} for p in pieces]
            events.append({"choices": [{"delta": {}, "finish_reason": finish}]})
            # 收尾只带 usage、不带 choices：适配器须跳过 choices 解析但仍取用量
            events.append({"choices": [], "usage": {"total_tokens": used}})
            return self._send_sse(events)
        return self._send_json(200, {
            "choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": finish}],
            "usage": {"total_tokens": used},
        })

    def _acp(self):
        with _LOCK:
            pieces, used, stop = STUB["pieces"], STUB["used"], STUB["acp_stop"]
            thoughts = STUB["thoughts"]

        def update(**kwargs):
            return {"method": "session/update", "params": {"update": kwargs}}

        events = [update(sessionUpdate="agent_thought_chunk",
                         content={"type": "text", "text": t}) for t in thoughts]
        events.append(update(sessionUpdate="agent_phase", phase="answering"))
        events += [update(sessionUpdate="agent_message_chunk",
                          content={"type": "text", "text": p}) for p in pieces]
        if used is not None:
            events.append(update(sessionUpdate="usage_update", used=used, size=0))
        events.append({"id": 1, "result": {"stopReason": stop}})
        return self._send_sse(events)


def start_stub():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


# ---------------- 用例 ----------------
def group_a():
    """A 组：分派与配置校验（不触网）。"""
    with provider(P_CLOUDBASE):
        ok = (llm_service.is_configured() is True
              and llm_service.model_label() == settings.CLOUDBASE_AGENT_ID.strip())
        record("A01", "provider=cloudbase 走 ACP 适配器，model_label 取 Agent ID", ok,
               f"configured={llm_service.is_configured()} label={llm_service.model_label()}")
    with provider(P_OPENAI):
        ok = (llm_service.is_configured() is bool(settings.LLM_API_KEY.strip())
              and llm_service.model_label() == settings.LLM_MODEL.strip())
        record("A02", "provider=openai 走 OpenAI 适配器，model_label 取模型名", ok,
               f"label={llm_service.model_label()}")
    with provider("azure"):
        exc = error_of(llm_service.prompt_meta, "hi", timeout=5, max_retries=0)
        label = llm_service.model_label()
        record("A03", "provider 取值非法：prompt_meta 抛错、model_label 不抛错",
               isinstance(exc, llm_service.LlmError) and "取值非法" in str(exc) and label == "azure",
               f"异常={exc} label={label}")
    same_error = (llm_service.LlmError is llm_base.LlmError
                  is llm_openai.LlmError is llm_cloudbase.LlmError)
    result = llm_service.CallResult(text="x", used_tokens=1, stop_reason="stop", elapsed_ms=2)
    same_result = isinstance(result, llm_base.CallResult)
    record("A04", "门面与适配器共用同一套 LlmError / CallResult 类型", same_error and same_result,
           f"LlmError 同一={same_error} CallResult 兼容={same_result}")
    with provider(P_CLOUDBASE, CLOUDBASE_API_KEY=""):
        exc_stream = error_of(llm_service.LlmStream, "hi", timeout=5)
        exc_meta = error_of(llm_service.prompt_meta, "hi", timeout=5, max_retries=0)
        record("A05", "cloudbase 缺 Key：构造流与调用都在发请求前抛错",
               isinstance(exc_stream, llm_service.LlmError) and "CLOUDBASE_API_KEY" in str(exc_stream)
               and isinstance(exc_meta, llm_service.LlmError)
               and llm_service.is_configured() is False,
               f"stream={exc_stream} meta={exc_meta}")
    with provider(P_OPENAI, LLM_API_KEY=""):
        exc_stream = error_of(llm_service.LlmStream, "hi", timeout=5)
        exc_meta = error_of(llm_service.prompt_meta, "hi", timeout=5, max_retries=0)
        record("A06", "openai 缺 Key：构造流与调用都在发请求前抛错",
               isinstance(exc_stream, llm_service.LlmError) and "LLM_API_KEY" in str(exc_stream)
               and isinstance(exc_meta, llm_service.LlmError)
               and llm_service.is_configured() is False,
               f"stream={exc_stream} meta={exc_meta}")


def group_b(base_url):
    """B 组：OpenAI 兼容适配器协议细节（打本地桩）。"""
    cfg = dict(LLM_BASE_URL=base_url + "/v1", LLM_MODEL="stub-model", LLM_API_KEY="stub-key",
               LLM_EXTRA_BODY={"enable_thinking": False},
               LLM_QUESTION_EXTRA_BODY={"enable_thinking": True},
               LLM_TIMEOUT_SECONDS=20, AI_MAX_RETRIES=0)

    reset_stub()
    with provider(P_OPENAI, **cfg):
        r = llm_service.prompt_meta("用户问题", system="系统提示", timeout=20)
        req = last_request()
        body = req.get("body", {})
        messages = body.get("messages", [])
        ok = (r.text == "".join(_STUB_DEFAULTS["pieces"]) and r.used_tokens == 42
              and r.stop_reason == "stop" and r.elapsed_ms >= 0
              and body.get("model") == "stub-model" and body.get("stream") is False
              and "max_tokens" not in body and body.get("enable_thinking") is False
              and messages[:1] == [{"role": "system", "content": "系统提示"}]
              and messages[-1:] == [{"role": "user", "content": "用户问题"}]
              and req.get("path") == "/v1/chat/completions"
              and req["headers"].get("authorization") == "Bearer stub-key")
        record("B01", "非流式请求体与响应解析正确（system role / 透传 / 不带 max_tokens）", ok,
               f"text={r.text[:20]} used={r.used_tokens} stop={r.stop_reason} path={req.get('path')}")

    reset_stub()
    with provider(P_OPENAI, **cfg):
        llm_service.prompt_meta("问题", timeout=20, max_tokens=800)
        body = last_request().get("body", {})
        record("B02", "显式传 max_tokens 时写入请求体", body.get("max_tokens") == 800,
               f"max_tokens={body.get('max_tokens')}")

    reset_stub()
    with provider(P_OPENAI, **cfg):
        got, t0, first = [], time.monotonic(), None
        s = llm_service.LlmStream("问题", system="系统提示", timeout=20, max_tokens=300)
        for piece in s:
            got.append(piece)
            if first is None:
                first = time.monotonic() - t0
        body = last_request().get("body", {})
        ok = (got == _STUB_DEFAULTS["pieces"] and s.result is not None
              and s.result.text == "".join(got) and s.result.used_tokens == 42
              and s.result.stop_reason == "stop" and body.get("stream") is True
              and body.get("stream_options") == {"include_usage": True}
              and body.get("max_tokens") == 300 and first is not None)
        record("B03", "流式逐片产出且索取 usage（stream_options.include_usage）", ok,
               f"分片={len(got)} 首片={first:.2f}s used={s.result.used_tokens if s.result else None}")

    reset_stub()
    with provider(P_OPENAI, **cfg):
        llm_service.prompt("出题提示词", timeout=20)
        body = last_request().get("body", {})
        record("B04", "出题链路 prompt() 用 LLM_QUESTION_EXTRA_BODY 覆盖思考开关",
               body.get("enable_thinking") is True, f"enable_thinking={body.get('enable_thinking')}")

    checks = []
    for mode, keyword, retryable in (("http_401", "鉴权失败", False), ("http_429", "过于频繁", True),
                                     ("http_500", "暂时不可用", True)):
        reset_stub(mode=mode)
        with provider(P_OPENAI, **cfg):
            exc = error_of(llm_service.prompt_meta, "问题", timeout=20)
        checks.append(isinstance(exc, llm_service.LlmError) and keyword in str(exc)
                      and exc.retryable is retryable
                      and "stub-key" not in str(exc))
    reset_stub(finish_reason="length")
    with provider(P_OPENAI, **cfg):
        exc = error_of(llm_service.prompt_meta, "问题", timeout=20)
    checks.append(isinstance(exc, llm_service.LlmError) and "未正常结束" in str(exc)
                  and exc.retryable is False)
    record("B05", "错误映射：401/429/500 与 finish_reason=length 各自正确", all(checks),
           f"四项判定={checks}")

    reset_stub(fail_times=1, fail_status=500)
    with provider(P_OPENAI, **dict(cfg, AI_MAX_RETRIES=1)):
        r = llm_service.prompt_meta("问题", timeout=20)
        calls = STUB["calls"]
    record("B06", "可重试错误按 AI_MAX_RETRIES 重试后成功", r.text != "" and calls == 2,
           f"上游调用次数={calls} text={r.text[:16]}")

    reset_stub(pieces=[])
    with provider(P_OPENAI, **cfg):
        exc = error_of(llm_service.prompt_meta, "问题", timeout=20)
    record("B07", "空正文按「返回空内容」处理且标记可重试",
           isinstance(exc, llm_service.LlmError) and "空内容" in str(exc) and exc.retryable is True,
           f"异常={exc}")


def group_c(base_url):
    """C 组：CloudBase ACP 适配器协议细节（打本地桩）。

    桩地址通过 CLOUDBASE_AGENT_URL 显式指定（否则会按 ENV_ID 拼出公网网关地址）；
    留空时的模板拼接逻辑在 C06 里直接断言 _resolve_url() 的返回值。
    """
    _ACP_PATH = "/v1/aibot/bots/agt-stub-001/acp"
    cfg = dict(CLOUDBASE_ENV_ID="stub-env", CLOUDBASE_AGENT_ID="agt-stub-001",
               CLOUDBASE_API_KEY="stub-cb-key", CLOUDBASE_AGENT_URL=base_url + _ACP_PATH,
               LLM_TIMEOUT_SECONDS=20, AI_MAX_RETRIES=0)

    reset_stub()
    with provider(P_CLOUDBASE, **cfg):
        llm_service.prompt_meta("用户问题", system="系统提示", timeout=20)
        req = last_request()
        body = req.get("body", {})
        prompt = (body.get("params") or {}).get("prompt") or [{}]
        ok = (body.get("jsonrpc") == "2.0" and body.get("method") == "session/prompt"
              and prompt[0].get("type") == "text" and prompt[0].get("text") == "系统提示\n\n用户问题"
              and req["headers"].get("accept") == "text/event-stream"
              and req["headers"].get("authorization") == "Bearer stub-cb-key"
              and req.get("path") == _ACP_PATH)
        record("C01", "ACP 请求体为 JSON-RPC session/prompt，system 前缀拼接", ok,
               f"path={req.get('path')} prompt={prompt[0].get('text')!r}")

    reset_stub()
    with provider(P_CLOUDBASE, **cfg):
        r = llm_service.prompt_meta("用户问题", timeout=20)
        text = "".join(_STUB_DEFAULTS["pieces"])
        record("C02", "SSE 解析：只拼正文，思考/阶段事件忽略，用量与终态被取用",
               r.text == text and "先回顾" not in r.text and r.used_tokens == 42
               and r.stop_reason == "end_turn",
               f"text={r.text[:20]} used={r.used_tokens} stop={r.stop_reason}")

    reset_stub()
    with provider(P_CLOUDBASE, **cfg):
        got = []
        s = llm_service.LlmStream("用户问题", system="系统提示", timeout=20)
        for piece in s:
            got.append(piece)
        non_stream = llm_service.prompt_meta("用户问题", system="系统提示", timeout=20)
        ok = (len(got) > 1 and got == _STUB_DEFAULTS["pieces"] and s.result is not None
              and s.result.text == non_stream.text == "".join(got)
              and s.result.used_tokens == non_stream.used_tokens == 42
              and s.result.stop_reason == non_stream.stop_reason == "end_turn")
        record("C03", "流式分片数 >1 且 result 与非流式同构", ok,
               f"分片={len(got)} 流式={s.result.text[:16]!r} 非流式={non_stream.text[:16]!r}")

    reset_stub()
    with provider(P_CLOUDBASE, **cfg):
        llm_service.prompt_meta("问题", timeout=20, max_tokens=800,
                                extra_body={"enable_thinking": False})
        body = last_request().get("body", {})
        record("C04", "max_tokens / extra_body 不进 ACP 请求体",
               "max_tokens" not in body and "enable_thinking" not in body
               and set(body.keys()) == {"jsonrpc", "id", "method", "params"},
               f"请求体键={sorted(body.keys())}")

    checks = []
    reset_stub(acp_stop="max_tokens")
    with provider(P_CLOUDBASE, **cfg):
        exc = error_of(llm_service.prompt_meta, "问题", timeout=20)
    checks.append(isinstance(exc, llm_service.LlmError) and "未正常结束" in str(exc)
                  and exc.retryable is False)
    reset_stub(pieces=[])
    with provider(P_CLOUDBASE, **cfg):
        exc = error_of(llm_service.prompt_meta, "问题", timeout=20)
    checks.append(isinstance(exc, llm_service.LlmError) and "空内容" in str(exc)
                  and exc.retryable is True)
    record("C05", "stopReason=max_tokens 判为未正常结束；空正文可重试", all(checks),
           f"两项判定={checks}")

    reset_stub()
    with provider(P_CLOUDBASE, **dict(cfg, CLOUDBASE_AGENT_URL=base_url + "/custom/acp")):
        llm_service.prompt_meta("问题", timeout=20)
        explicit_path = last_request().get("path")
    with provider(P_CLOUDBASE, CLOUDBASE_ENV_ID="env-x", CLOUDBASE_AGENT_ID="agt-y",
                  CLOUDBASE_AGENT_URL="", CLOUDBASE_API_KEY="k"):
        composed = llm_cloudbase._resolve_url()
    record("C06", "显式 AGENT_URL 优先；留空时按 ENV_ID/AGENT_ID 模板拼接",
           explicit_path == "/custom/acp"
           and composed == "https://env-x.api.tcloudbasegateway.com/v1/aibot/bots/agt-y/acp",
           f"显式={explicit_path} 拼接={composed}")

    reset_stub(mode="http_401")
    with provider(P_CLOUDBASE, **cfg):
        exc = error_of(llm_service.prompt_meta, "问题", timeout=20)
    record("C07", "401 提示检查 CLOUDBASE_API_KEY 且不泄露密钥",
           isinstance(exc, llm_service.LlmError) and "CLOUDBASE_API_KEY" in str(exc)
           and exc.retryable is False and "stub-cb-key" not in str(exc),
           f"异常={exc}")


_QUESTION_PROMPT = (
    "你是长征主题答题出题助手。请生成 2 道单选题，严格输出 JSON 数组，不要输出任何解释文字。\n"
    '每个元素形如：{"type":"single","question":"题干","options":[{"label":"A","text":"选项"},'
    '{"label":"B","text":"选项"},{"label":"C","text":"选项"},{"label":"D","text":"选项"}],'
    '"answer":["A"],"analysis":"解析"}'
)


def group_d():
    """D 组：真实上游调用（当前 provider 配置齐备时执行）。"""
    if os.getenv("LM_AI_SKIP_LIVE") == "1":
        for cid, name in (("D01", "真实非流式调用"), ("D02", "真实流式调用"),
                          ("D03", "真实出题长输出 JSON")):
            record(cid, name, False, "跳过：LM_AI_SKIP_LIVE=1")
        return
    if not llm_service.is_configured():
        for cid, name in (("D01", "真实非流式调用"), ("D02", "真实流式调用"),
                          ("D03", "真实出题长输出 JSON")):
            record(cid, name, False, f"跳过：{settings.LLM_PROVIDER} 供应商配置不齐备")
        return

    label = llm_service.model_label()
    print(f"  真实调用供应商：{settings.LLM_PROVIDER}（{label}）")
    t0 = time.monotonic()
    exc, r = None, None
    try:
        r = llm_service.prompt_meta("请用一句话介绍遵义会议的意义。", system="你是长征历史助手。",
                                    timeout=120, max_tokens=300)
    except llm_service.LlmError as e:
        exc = e
    record("D01", "真实非流式：拿到非空正文与正常结束原因",
           exc is None and bool(r and r.text) and r.stop_reason in ("stop", "end_turn"),
           f"耗时={time.monotonic()-t0:.1f}s stop={getattr(r,'stop_reason',None)} "
           f"used={getattr(r,'used_tokens',None)} 正文={getattr(r,'text','')[:40]!r} 异常={exc}")

    t0 = time.monotonic()
    exc, pieces, first, s = None, [], None, None
    try:
        s = llm_service.LlmStream("请用两句话介绍红军四渡赤水。", system="你是长征历史助手。",
                                  timeout=120, max_tokens=400)
        for piece in s:
            pieces.append(piece)
            if first is None:
                first = time.monotonic() - t0
    except llm_service.LlmError as e:
        exc = e
    total = time.monotonic() - t0
    result = getattr(s, "result", None)
    record("D02", "真实流式：分片数 >1 且首片早于总耗时（真增量）",
           exc is None and len(pieces) > 1 and first is not None and first < total
           and result is not None and result.text == "".join(pieces),
           f"分片={len(pieces)} 首片={first if first is None else round(first,1)}s 总耗时={total:.1f}s "
           f"字数={len(result.text) if result else 0} 异常={exc}")

    t0 = time.monotonic()
    exc, reply = None, ""
    try:
        reply = llm_service.prompt(_QUESTION_PROMPT, timeout=180)
    except llm_service.LlmError as e:
        exc = e
    parsed = None
    if reply:
        text = reply.strip()
        if text.startswith("```"):  # 供应商可能包代码块，与出题服务同款宽松处理
            text = text.strip("`")
            text = text[text.find("["):] if "[" in text else text
        try:
            parsed = json.loads(text[text.find("["):text.rfind("]") + 1])
        except ValueError:
            parsed = None
    record("D03", "真实出题：长输出 JSON 数组可解析",
           exc is None and isinstance(parsed, list) and len(parsed) >= 1
           and all(isinstance(i, dict) and i.get("question") for i in parsed),
           f"耗时={time.monotonic()-t0:.1f}s 题数={len(parsed) if isinstance(parsed,list) else '解析失败'} "
           f"正文长度={len(reply)} 异常={exc}")


def main():
    server, base_url = start_stub()
    print(f"桩服务器已启动：{base_url}")
    print(f"当前 env：LLM_PROVIDER={settings.LLM_PROVIDER} "
          f"LLM_MODEL={settings.LLM_MODEL or '无'} CLOUDBASE_AGENT_ID={settings.CLOUDBASE_AGENT_ID or '无'} "
          f"openai_key={'有' if settings.LLM_API_KEY.strip() else '无'} "
          f"cloudbase_key={'有' if settings.CLOUDBASE_API_KEY.strip() else '无'}")
    try:
        group_a()
        group_b(base_url)
        group_c(base_url)
        group_d()
    finally:
        server.shutdown()
        server.server_close()

    passed = sum(1 for r in RESULTS if r["ok"])
    summary = {"suite": "s30_llm_provider_switch", "provider": settings.LLM_PROVIDER,
               "total": len(RESULTS), "passed": passed, "failed": len(RESULTS) - passed,
               "results": RESULTS}
    out = os.path.join(_HERE, "s30-llm-provider-switch-results.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
    print(f"\n合计 {len(RESULTS)} 项：通过 {passed}，失败 {len(RESULTS) - passed}")
    print("结果已写入", out)
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
