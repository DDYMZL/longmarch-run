"""大模型调用封装（OpenAI Chat Completions 兼容协议）。

职责单一：发一次提示词、收完整文本回复。非流式 POST 到 {LLM_BASE_URL}/chat/completions，
系统提示走标准 system role（不再前缀拼进用户输入），并取回 usage.total_tokens 与
finish_reason 供上层落 ai_usage_logs。

多轮对话不依赖服务端会话续接，由上层把最近历史拼进单次提示词（无状态）。

协议与厂商解耦：只依赖 OpenAI 兼容契约，换供应商时改 LLM_BASE_URL / LLM_MODEL / LLM_API_KEY
即可，无需改动本模块与上层业务代码；厂商专有参数一律走 LLM_EXTRA_BODY /
LLM_QUESTION_EXTRA_BODY 透传（换厂商时需一并清理，如 Qwen 的 enable_thinking）。

安全约定：API Key 仅在本模块内组装到请求头，不写日志、不进异常消息、不下发前端。
"""
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

_CHAT_PATH = "/chat/completions"
# 正常结束原因；其余取值（如 length）意味着回复被截断——出题链路的 JSON 必然不完整，
# 对话链路则会给出半截回答，两者都不应作为成功结果返回
_NORMAL_STOP_REASONS = ("stop",)


class LlmError(ValueError):
    """模型调用失败（配置缺失、鉴权失败、超时、服务异常、回复截断）。

    继承 ValueError 以便路由层统一转换，但需先于 ValueError 捕获以映射为 502。
    retryable=True 表示属瞬时故障（超时 / 5xx / 429 / 网络 / 空回复），可重试；
    配置缺失、鉴权失败、欠费、回复截断等重试无益，标记为不可重试。
    """

    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class CallResult:
    """一次成功调用的结果。

    used_tokens 取 usage.total_tokens（输入 + 输出，与按量计费口径一致）；上游未报告
    用量时为 None。elapsed_ms 为本次 HTTP 往返耗时。
    """

    text: str
    used_tokens: Optional[int] = None
    stop_reason: str = ""
    elapsed_ms: int = 0


def _resolve_url() -> str:
    """返回 Chat Completions 调用地址：base_url 去掉尾部斜杠后拼接固定路径。"""
    base = settings.LLM_BASE_URL.strip().rstrip("/")
    if not base:
        raise LlmError("AI 服务未配置，请在后端环境变量中设置 LLM_BASE_URL")
    return f"{base}{_CHAT_PATH}"


def _resolve_model() -> str:
    model = settings.LLM_MODEL.strip()
    if not model:
        raise LlmError("AI 服务未配置，请在后端环境变量中设置 LLM_MODEL")
    return model


def _http_error(status_code: int, code: str = "") -> LlmError:
    """把上游 HTTP 状态码翻译成面向用户的中文提示（不暴露密钥与内部细节）。

    code 为供应商错误码，仅写日志辅助排障，不进用户可见文案。
    """
    if code:
        logger.warning("llm upstream error: http=%d code=%s", status_code, code)
    if status_code in (401, 403):
        return LlmError("AI 服务鉴权失败，请检查 LLM_API_KEY 是否有效")
    if status_code == 402:
        return LlmError("AI 服务账户余额不足，请充值后重试")
    if status_code == 404:
        return LlmError("AI 服务地址或模型名称不正确")
    if status_code == 429:
        return LlmError("AI 服务请求过于频繁，请稍后重试", retryable=True)
    if status_code >= 500:
        return LlmError("AI 服务暂时不可用，请稍后重试", retryable=True)
    return LlmError(f"AI 服务返回异常状态码 {status_code}")


def _error_code(payload: Any) -> str:
    """从错误响应体中取供应商错误码；结构不符时返回空串（不影响主流程）。"""
    if not isinstance(payload, dict):
        return ""
    error = payload.get("error")
    if isinstance(error, dict):
        return str(error.get("code") or error.get("type") or "")
    return str(payload.get("code") or "")


def _build_messages(text: str, system: Optional[str]) -> List[Dict[str, str]]:
    """组装消息数组：系统提示独立成 system role，用户输入不与提示词混在一条消息里。"""
    messages: List[Dict[str, str]] = []
    if system and system.strip():
        messages.append({"role": "system", "content": system.strip()})
    messages.append({"role": "user", "content": text})
    return messages


def _parse_reply(payload: Any, elapsed_ms: int) -> CallResult:
    """从 Chat Completions 响应体中取正文、用量与结束原因；结构异常按空回复处理。"""
    if not isinstance(payload, dict):
        raise LlmError("AI 服务返回内容格式异常，请重试", retryable=True)
    choices = payload.get("choices")
    first = choices[0] if isinstance(choices, list) and choices else {}
    if not isinstance(first, dict):
        first = {}
    usage = payload.get("usage")
    used = usage.get("total_tokens") if isinstance(usage, dict) else None
    return CallResult(
        text=str((first.get("message") or {}).get("content") or "").strip(),
        used_tokens=used if isinstance(used, int) else None,
        stop_reason=str(first.get("finish_reason") or ""),
        elapsed_ms=elapsed_ms,
    )


def _request_once(
    text: str,
    system: Optional[str],
    timeout: float,
    max_tokens: Optional[int],
    extra_body: Optional[Dict[str, Any]] = None,
) -> CallResult:
    """发一次 Chat Completions 调用；失败抛 LlmError（不含密钥）。"""
    body: Dict[str, Any] = {
        "model": _resolve_model(),
        "messages": _build_messages(text, system),
        "stream": False,
    }
    # 未显式指定时不传，交由供应商默认值；出题链路依赖长输出，不能被对话的 800 上限截断
    if max_tokens:
        body["max_tokens"] = max_tokens
    # 供应商专有参数（如 Qwen 的 enable_thinking）由配置透传，本模块不感知具体厂商
    body.update(settings.LLM_EXTRA_BODY)
    if extra_body:
        body.update(extra_body)
    headers = {
        # 显式声明 charset，避免中文提示词被上游按其他编码解释
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": f"Bearer {settings.LLM_API_KEY.strip()}",
    }
    started = time.monotonic()
    try:
        response = httpx.post(_resolve_url(), json=body, headers=headers, timeout=timeout)
    except httpx.TimeoutException:
        raise LlmError("AI 生成超时，请稍后重试", retryable=True)
    except httpx.HTTPError as exc:
        # 只记录异常类型，避免把 URL/请求细节写进日志
        logger.warning("llm request failed: %s", exc.__class__.__name__)
        raise LlmError("AI 服务请求失败，请检查服务器网络后重试", retryable=True)
    elapsed_ms = int((time.monotonic() - started) * 1000)

    try:
        payload = response.json()
    except ValueError:
        payload = None
    if response.status_code != 200:
        raise _http_error(response.status_code, _error_code(payload))
    result = _parse_reply(payload, elapsed_ms)
    if result.stop_reason and result.stop_reason not in _NORMAL_STOP_REASONS:
        raise LlmError(
            f"AI 回复未正常结束（{result.stop_reason}），请缩短输入或减少单次生成数量后重试"
        )
    if not result.text:
        raise LlmError("AI 服务返回空内容，请重试", retryable=True)
    return result


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

    system 非空时作为独立 system role 下发（无状态多轮由上层把历史拼进 text）。
    max_retries 缺省取 settings.AI_MAX_RETRIES；仅对 retryable 错误重试，退避 0.5s×次数。
    extra_body 在 settings.LLM_EXTRA_BODY 之后合并，供单个场景覆盖供应商参数。
    """
    if not settings.LLM_API_KEY.strip():
        raise LlmError("AI 服务未配置，请在后端环境变量中设置 LLM_API_KEY")
    effective_timeout = timeout or settings.LLM_TIMEOUT_SECONDS
    attempts = 1 + max(0, settings.AI_MAX_RETRIES if max_retries is None else max_retries)
    last_error: Optional[LlmError] = None
    for attempt in range(attempts):
        try:
            return _request_once(text, system, effective_timeout, max_tokens, extra_body)
        except LlmError as exc:
            if not exc.retryable or attempt == attempts - 1:
                raise
            last_error = exc
            logger.info("llm retry %d/%d: transient", attempt + 1, attempts - 1)
            time.sleep(0.5 * (attempt + 1))
    # 理论不可达：循环内要么 return 要么 raise
    raise last_error or LlmError("AI 服务请求失败，请重试")


def prompt(text: str, timeout: Optional[float] = None) -> str:
    """发送一次提示词，返回完整正文（出题链路专用）。

    出题要求严格 JSON 数组：实测关闭思考模式后批次解析失败率明显上升（5 批挂 1 批），
    故本入口叠加 LLM_QUESTION_EXTRA_BODY 恢复思考模式。出题由管理员触发且分批并发，
    可承受其额外时延与 token 开销；对话链路走 prompt_meta，保持思考关闭以压低时延与成本。

    失败一律抛 LlmError（中文提示，不含密钥）。
    """
    return prompt_meta(
        text, timeout=timeout, extra_body=settings.LLM_QUESTION_EXTRA_BODY
    ).text
