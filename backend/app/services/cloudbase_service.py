"""腾讯云 CloudBase Agent 调用封装（ACP 协议）。

职责单一：发一次提示词、收完整文本回复。按 JSON-RPC 2.0 调用 session/prompt，
解析 SSE 事件流，只拼接 agent_message_chunk 的正文，忽略思考过程；同时捕获平台
报告的 usage_update.used 用量与终态 stopReason，供上层落 ai_usage_logs。

多轮对话不依赖网关会话续接（未验证），由上层把最近历史拼进单次提示词（无状态）。
系统提示以「前缀拼接」方式注入，不使用未经核实的 ACP 参数。

安全约定：API Key 仅在本模块内组装到请求头，不写日志、不进异常消息、不下发前端。
"""
import json
import logging
import time
from dataclasses import dataclass, field
from typing import List, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# ACP 端点路径模板；网关会自动建会话，因此无需先调 session/new 传 sessionId
_ACP_PATH = "/v1/aibot/bots/{agent_id}/acp"
_STREAM_DONE = "[DONE]"
# 正常结束原因；其余取值（如 max_tokens）意味着回复被截断，JSON 必然不完整
_NORMAL_STOP_REASONS = ("end_turn", "stop_sequence")


class CloudBaseError(ValueError):
    """CloudBase 调用失败（配置缺失、鉴权失败、超时、服务异常、回复截断）。

    继承 ValueError 以便路由层统一转换，但需先于 ValueError 捕获以映射为 502。
    retryable=True 表示属瞬时故障（超时 / 5xx / 429 / 网络 / 空回复），可重试；
    配置缺失、鉴权失败、回复截断等重试无益，标记为不可重试。
    """

    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class CallResult:
    """一次成功调用的结果。

    used_tokens 为平台 usage_update.used 原值（含义未核实为精确计费口径，如实记录不换算）；
    平台未报告用量时为 None。elapsed_ms 为本次 HTTP 往返耗时。
    """

    text: str
    used_tokens: Optional[int] = None
    stop_reason: str = ""
    elapsed_ms: int = 0


@dataclass
class _StreamState:
    """SSE 消费过程中的累积状态。"""

    chunks: List[str] = field(default_factory=list)
    used_tokens: Optional[int] = None
    stop_reason: str = ""
    done: bool = False


def _resolve_url() -> str:
    """返回 ACP 调用地址：优先取显式配置，否则按环境 ID 与 Agent ID 拼接。"""
    explicit = settings.CLOUDBASE_AGENT_URL.strip()
    if explicit:
        return explicit
    env_id = settings.CLOUDBASE_ENV_ID.strip()
    agent_id = settings.CLOUDBASE_AGENT_ID.strip()
    if not env_id or not agent_id:
        raise CloudBaseError(
            "AI 服务未配置，请在后端环境变量中设置 CLOUDBASE_ENV_ID 与 CLOUDBASE_AGENT_ID"
        )
    return f"https://{env_id}.api.tcloudbasegateway.com{_ACP_PATH.format(agent_id=agent_id)}"


def _http_error(status_code: int) -> CloudBaseError:
    """把上游 HTTP 状态码翻译成面向用户的中文提示（不暴露密钥与内部细节）。"""
    if status_code in (401, 403):
        return CloudBaseError("AI 服务鉴权失败，请检查 CLOUDBASE_API_KEY 是否有效")
    if status_code == 404:
        return CloudBaseError("AI 服务地址或 Agent ID 不正确")
    if status_code == 429:
        return CloudBaseError("AI 服务请求过于频繁，请稍后重试", retryable=True)
    if status_code >= 500:
        return CloudBaseError("AI 服务暂时不可用，请稍后重试", retryable=True)
    return CloudBaseError(f"AI 服务返回异常状态码 {status_code}")


def _consume_line(line: str, state: _StreamState) -> None:
    """处理一行 SSE 数据：正文追加到 chunks，用量/终态写入 state，流结束置 done。

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
    if not line.startswith("data:"):
        return
    payload = line[5:].strip()
    if not payload:
        return
    if payload == _STREAM_DONE:
        state.done = True
        return
    try:
        event = json.loads(payload)
    except json.JSONDecodeError:
        return
    if not isinstance(event, dict):
        return
    if event.get("error"):
        raise CloudBaseError("AI 服务返回错误，请重试", retryable=True)
    result = event.get("result")
    if isinstance(result, dict):
        state.stop_reason = str(result.get("stopReason") or "")
        state.done = True
        return
    update = (event.get("params") or {}).get("update") or {}
    kind = update.get("sessionUpdate")
    if kind == "agent_message_chunk":
        content = update.get("content") or {}
        if content.get("type") == "text":
            state.chunks.append(content.get("text") or "")
    elif kind == "usage_update":
        used = update.get("used")
        if isinstance(used, int):
            state.used_tokens = used


def _request_once(text: str, timeout: float) -> CallResult:
    """发一次 ACP 调用并阻塞读取 SSE 到结束；失败抛 CloudBaseError（不含密钥）。"""
    url = _resolve_url()
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "session/prompt",
        "params": {"prompt": [{"type": "text", "text": text}]},
    }
    headers = {
        # 显式声明 charset，避免中文提示词被上游按其他编码解释
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "text/event-stream",
        "Authorization": f"Bearer {settings.CLOUDBASE_API_KEY.strip()}",
    }
    state = _StreamState()
    started = time.monotonic()
    try:
        with httpx.Client(timeout=timeout) as client:
            with client.stream("POST", url, json=body, headers=headers) as response:
                if response.status_code != 200:
                    response.read()
                    raise _http_error(response.status_code)
                for line in response.iter_lines():
                    _consume_line(line, state)
                    if state.done:
                        break
    except CloudBaseError:
        raise
    except httpx.TimeoutException:
        raise CloudBaseError("AI 生成超时，请稍后重试", retryable=True)
    except httpx.HTTPError as exc:
        # 只记录异常类型，避免把 URL/请求细节写进日志
        logger.warning("cloudbase request failed: %s", exc.__class__.__name__)
        raise CloudBaseError("AI 服务请求失败，请检查服务器网络后重试", retryable=True)
    elapsed_ms = int((time.monotonic() - started) * 1000)
    if state.stop_reason and state.stop_reason not in _NORMAL_STOP_REASONS:
        raise CloudBaseError(
            f"AI 回复未正常结束（{state.stop_reason}），请减少单次生成数量后重试"
        )
    reply = "".join(state.chunks).strip()
    if not reply:
        raise CloudBaseError("AI 服务返回空内容，请重试", retryable=True)
    return CallResult(
        text=reply,
        used_tokens=state.used_tokens,
        stop_reason=state.stop_reason,
        elapsed_ms=elapsed_ms,
    )


def prompt_meta(
    text: str,
    *,
    system: Optional[str] = None,
    timeout: Optional[float] = None,
    max_retries: Optional[int] = None,
) -> CallResult:
    """发送一次提示词并返回含用量的完整结果；对瞬时故障按配置重试。

    system 非空时以「系统提示 + 空行 + 用户输入」拼成单次提示词（无状态多轮由上层拼历史）。
    max_retries 缺省取 settings.AI_MAX_RETRIES；仅对 retryable 错误重试，退避 0.5s×次数。
    """
    if not settings.CLOUDBASE_API_KEY.strip():
        raise CloudBaseError("AI 服务未配置，请在后端环境变量中设置 CLOUDBASE_API_KEY")
    final_text = f"{system.strip()}\n\n{text}" if system and system.strip() else text
    effective_timeout = timeout or settings.CLOUDBASE_TIMEOUT_SECONDS
    attempts = 1 + max(0, settings.AI_MAX_RETRIES if max_retries is None else max_retries)
    last_error: Optional[CloudBaseError] = None
    for attempt in range(attempts):
        try:
            return _request_once(final_text, effective_timeout)
        except CloudBaseError as exc:
            if not exc.retryable or attempt == attempts - 1:
                raise
            last_error = exc
            logger.info("cloudbase retry %d/%d: %s", attempt + 1, attempts - 1, "transient")
            time.sleep(0.5 * (attempt + 1))
    # 理论不可达：循环内要么 return 要么 raise
    raise last_error or CloudBaseError("AI 服务请求失败，请重试")


def prompt(text: str, timeout: Optional[float] = None) -> str:
    """发送一次提示词，返回拼接后的完整正文（向后兼容出题链路）。

    失败一律抛 CloudBaseError（中文提示，不含密钥）。
    """
    return prompt_meta(text, timeout=timeout).text
