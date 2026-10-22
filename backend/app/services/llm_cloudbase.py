"""大模型适配器 · 腾讯云 CloudBase Agent（ACP 私有协议）。

按 JSON-RPC 2.0 调用 `session/prompt`，解析 SSE 事件流：只拼接 `agent_message_chunk`
的正文，忽略 `agent_thought_chunk`（思考过程）与 `agent_phase`；同时捕获平台报告的
`usage_update.used` 用量与终态 `stopReason`，供上层落 ai_usage_logs。

与 OpenAI 兼容适配器的三处协议差异（换回本供应商时须知道）：
1. **系统提示只能前缀拼接**进用户输入——ACP 的 system 参数未经核实，沿用迁移前做法；
2. **不接受 max_tokens / extra_body**：ACP 无可核实的对应参数，二者由门面传入后在此忽略，
   输出长度只能靠提示词软约束（`ai_config_service` 的提示词里已写「不超过 N 字」）；
3. **流式粒度粗**：实测一次简短提问的正文只推 1 个 chunk，故小程序逐字效果主要由前端
   平滑动画承担，不像百炼那样按 token 连续推送。

多轮对话不依赖网关会话续接（未验证），由上层把最近历史拼进单次提示词（无状态）。
网关会自动建会话，因此无需先调 `session/new` 传 sessionId。

安全约定：API Key 仅在本模块内组装到请求头，不写日志、不进异常消息、不下发前端。
"""
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional

import httpx

from app.core.config import settings
from app.services.llm_base import CallResult, LlmError, ensure_complete

logger = logging.getLogger(__name__)

# ACP 端点路径模板
_ACP_PATH = "/v1/aibot/bots/{agent_id}/acp"
_SSE_DATA_PREFIX = "data:"
_STREAM_DONE = "[DONE]"
# 正常结束原因；其余取值（如 max_tokens）意味着回复被截断，出题的 JSON 必然不完整
_NORMAL_STOP_REASONS = ("end_turn", "stop_sequence")


@dataclass
class _StreamState:
    """SSE 消费过程中的累积状态。"""

    chunks: List[str] = field(default_factory=list)
    used_tokens: Optional[int] = None
    stop_reason: str = ""
    done: bool = False


def is_configured() -> bool:
    """本适配器所需配置是否齐备（供门面统一判定，不抛异常）。"""
    if not settings.CLOUDBASE_API_KEY.strip():
        return False
    if settings.CLOUDBASE_AGENT_URL.strip():
        return True
    return bool(settings.CLOUDBASE_ENV_ID.strip() and settings.CLOUDBASE_AGENT_ID.strip())


def model_label() -> str:
    """写入 ai_usage_logs.model 的模型标识：ACP 不暴露真实模型名，沿用迁移前的 Agent ID。"""
    return settings.CLOUDBASE_AGENT_ID.strip() or "cloudbase-agent"


def _resolve_url() -> str:
    """返回 ACP 调用地址：优先取显式配置，否则按环境 ID 与 Agent ID 拼接。"""
    explicit = settings.CLOUDBASE_AGENT_URL.strip()
    if explicit:
        return explicit
    env_id = settings.CLOUDBASE_ENV_ID.strip()
    agent_id = settings.CLOUDBASE_AGENT_ID.strip()
    if not env_id or not agent_id:
        raise LlmError(
            "AI 服务未配置，请在后端环境变量中设置 CLOUDBASE_ENV_ID 与 CLOUDBASE_AGENT_ID"
        )
    return f"https://{env_id}.api.tcloudbasegateway.com{_ACP_PATH.format(agent_id=agent_id)}"


def _require_key() -> str:
    key = settings.CLOUDBASE_API_KEY.strip()
    if not key:
        raise LlmError("AI 服务未配置，请在后端环境变量中设置 CLOUDBASE_API_KEY")
    return key


def _http_error(status_code: int) -> LlmError:
    """把上游 HTTP 状态码翻译成面向用户的中文提示（不暴露密钥与内部细节）。"""
    if status_code in (401, 403):
        return LlmError("AI 服务鉴权失败，请检查 CLOUDBASE_API_KEY 是否有效")
    if status_code == 404:
        return LlmError("AI 服务地址或 Agent ID 不正确")
    if status_code == 429:
        return LlmError("AI 服务请求过于频繁，请稍后重试", retryable=True)
    if status_code >= 500:
        return LlmError("AI 服务暂时不可用，请稍后重试", retryable=True)
    return LlmError(f"AI 服务返回异常状态码 {status_code}")


def _consume_line(line: str, state: _StreamState) -> Optional[str]:
    """处理一行 SSE 数据：正文追加到 chunks，用量/终态写入 state，流结束置 done。

    返回本次新增的正文片段（无正文时返回 None），供流式模式直接往下游推增量。

    事件形态（实测）：
      data: {"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk",
             "content":{"type":"text","text":"..."}}}}                     ← 正文分片
      data: {"method":"session/update","params":{"update":{"sessionUpdate":"usage_update",
             "used":19234,"size":0}}}                                      ← 用量（平台报告）
      data: {"id":1,"result":{"stopReason":"end_turn"}}                    ← 终态帧
      data: [DONE]                                                         ← 流结束
    agent_thought_chunk（思考过程）、agent_phase 均不属于正文，直接忽略。
    """
    line = line.strip()
    if not line.startswith(_SSE_DATA_PREFIX):
        return None
    payload = line[len(_SSE_DATA_PREFIX) :].strip()
    if not payload:
        return None
    if payload == _STREAM_DONE:
        state.done = True
        return None
    try:
        event = json.loads(payload)
    except json.JSONDecodeError:
        # 丢一片只少几个字，中断整条流会让已显示的半截回答失去下文
        logger.warning("cloudbase stream: skip unparsable chunk")
        return None
    if not isinstance(event, dict):
        return None
    if event.get("error"):
        raise LlmError("AI 服务返回错误，请重试", retryable=True)
    result = event.get("result")
    if isinstance(result, dict):
        state.stop_reason = str(result.get("stopReason") or "")
        state.done = True
        return None
    update = (event.get("params") or {}).get("update") or {}
    kind = update.get("sessionUpdate")
    if kind == "agent_message_chunk":
        content = update.get("content") or {}
        if content.get("type") == "text":
            piece = content.get("text") or ""
            if piece:
                state.chunks.append(piece)
                return piece
        return None
    if kind == "usage_update":
        used = update.get("used")
        if isinstance(used, int):
            state.used_tokens = used
    return None


def _build_body(text: str) -> Dict[str, Any]:
    """组装 ACP session/prompt 请求体（JSON-RPC 2.0）。"""
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "session/prompt",
        "params": {"prompt": [{"type": "text", "text": text}]},
    }


def _auth_headers() -> Dict[str, str]:
    """组装鉴权头。API Key 只在此处出现，不写日志、不进异常消息。"""
    return {
        # 显式声明 charset，避免中文提示词被上游按其他编码解释
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "text/event-stream",
        "Authorization": f"Bearer {_require_key()}",
    }


def _join_system(system: Optional[str], text: str) -> str:
    """系统提示以「前缀 + 空行」拼进单次提示词（ACP 无经核实的 system 参数）。"""
    return f"{system.strip()}\n\n{text}" if system and system.strip() else text


def _finish(state: _StreamState, started: float) -> CallResult:
    """把累积状态收敛成 CallResult，并校验完整性（截断 / 空回复均不算成功）。"""
    result = CallResult(
        text="".join(state.chunks).strip(),
        used_tokens=state.used_tokens,
        stop_reason=state.stop_reason,
        elapsed_ms=int((time.monotonic() - started) * 1000),
    )
    ensure_complete(result, _NORMAL_STOP_REASONS)
    return result


def _request_once(text: str, timeout: float) -> CallResult:
    """发一次 ACP 调用并阻塞读取 SSE 到结束；失败抛 LlmError（不含密钥）。"""
    url = _resolve_url()
    state = _StreamState()
    started = time.monotonic()
    try:
        with httpx.Client(timeout=timeout) as client:
            with client.stream(
                "POST", url, json=_build_body(text), headers=_auth_headers()
            ) as response:
                if response.status_code != 200:
                    response.read()
                    raise _http_error(response.status_code)
                for line in response.iter_lines():
                    _consume_line(line, state)
                    if state.done:
                        break
    except LlmError:
        raise
    except httpx.TimeoutException:
        raise LlmError("AI 生成超时，请稍后重试", retryable=True)
    except httpx.HTTPError as exc:
        # 只记录异常类型，避免把 URL/请求细节写进日志
        logger.warning("cloudbase request failed: %s", exc.__class__.__name__)
        raise LlmError("AI 服务请求失败，请检查服务器网络后重试", retryable=True)
    return _finish(state, started)


def prompt_meta(
    text: str,
    *,
    system: Optional[str] = None,
    timeout: Optional[float] = None,
    max_retries: Optional[int] = None,
    max_tokens: Optional[int] = None,
    extra_body: Optional[Dict[str, Any]] = None,
) -> CallResult:
    """发送一次提示词并返回含用量的完整结果；对瞬时故障按配置重试。

    max_retries 缺省取 settings.AI_MAX_RETRIES；仅对 retryable 错误重试，退避 0.5s×次数。
    max_tokens / extra_body 为门面统一签名而保留，ACP 无对应参数，此处忽略（见模块 docstring）。
    """
    _require_key()
    final_text = _join_system(system, text)
    effective_timeout = timeout or settings.LLM_TIMEOUT_SECONDS
    attempts = 1 + max(0, settings.AI_MAX_RETRIES if max_retries is None else max_retries)
    last_error: Optional[LlmError] = None
    for attempt in range(attempts):
        try:
            return _request_once(final_text, effective_timeout)
        except LlmError as exc:
            if not exc.retryable or attempt == attempts - 1:
                raise
            last_error = exc
            logger.info("cloudbase retry %d/%d: transient", attempt + 1, attempts - 1)
            time.sleep(0.5 * (attempt + 1))
    # 理论不可达：循环内要么 return 要么 raise
    raise last_error or LlmError("AI 服务请求失败，请重试")


class CloudBaseStream:
    """一次流式 ACP 调用：迭代取增量正文，迭代结束后 `result` 给出用量与结束原因。

    构造即校验配置（api_key / 调用地址），使「未配置」在响应头发出之前就以普通 JSON + 502
    返回，而不是退化成流中途的 error 事件（此时状态码已无法更改）。

    与 `prompt_meta` 一样**不做自动重试**：增量可能已推给用户，重发会导致正文重复。
    消费方提前退出（客户端断开）时 `result` 保持 None，调用方须自行判定，不得据此落库。
    """

    def __init__(
        self,
        text: str,
        *,
        system: Optional[str] = None,
        timeout: Optional[float] = None,
        max_tokens: Optional[int] = None,
        extra_body: Optional[Dict[str, Any]] = None,
    ):
        _require_key()
        self._url = _resolve_url()
        self._body = _build_body(_join_system(system, text))
        self._timeout = timeout or settings.LLM_TIMEOUT_SECONDS
        self.result: Optional[CallResult] = None

    def __iter__(self) -> Iterator[str]:
        state = _StreamState()
        started = time.monotonic()
        try:
            with httpx.Client(timeout=self._timeout) as client:
                with client.stream(
                    "POST", self._url, json=self._body, headers=_auth_headers()
                ) as response:
                    if response.status_code != 200:
                        response.read()
                        raise _http_error(response.status_code)
                    for line in response.iter_lines():
                        piece = _consume_line(line, state)
                        if piece:
                            yield piece
                        if state.done:
                            break
        except LlmError:
            raise
        except httpx.TimeoutException:
            raise LlmError("AI 生成超时，请稍后重试", retryable=True)
        except httpx.HTTPError as exc:
            logger.warning("cloudbase stream failed: %s", exc.__class__.__name__)
            raise LlmError("AI 服务请求失败，请检查服务器网络后重试", retryable=True)
        self.result = _finish(state, started)


def stream(
    text: str,
    *,
    system: Optional[str] = None,
    timeout: Optional[float] = None,
    max_tokens: Optional[int] = None,
    extra_body: Optional[Dict[str, Any]] = None,
) -> CloudBaseStream:
    """创建一次流式调用（适配器契约：门面 LlmStream 转发到此）。

    max_tokens / extra_body 为本适配器忽略的参数，仅为与门面签名一致而保留。
    """
    return CloudBaseStream(
        text,
        system=system,
        timeout=timeout,
        max_tokens=max_tokens,
        extra_body=extra_body,
    )
