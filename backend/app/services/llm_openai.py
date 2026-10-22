"""大模型适配器 · OpenAI Chat Completions 兼容协议（阿里云百炼等）。

职责单一：发一次提示词、收文本回复。POST 到 `{LLM_BASE_URL}/chat/completions`，
系统提示走标准 system role（不前缀拼进用户输入），并取回 usage.total_tokens 与
finish_reason 供上层落 ai_usage_logs。

两种调用模式，按场景选择：
- `prompt_meta`：非流式，一次拿完整正文（出题需要完整 JSON 才能解析）；
- `OpenAiStream`：流式，边生成边推增量正文（小程序 AI 问答用它把首字延迟从整段耗时
  压到 1~2 秒），迭代结束后同样给出用量与结束原因。

多轮对话不依赖服务端会话续接，由上层把最近历史拼进单次提示词（无状态）。

本模块只依赖 OpenAI 兼容契约，不感知具体厂商：换同类供应商只改 LLM_BASE_URL /
LLM_MODEL / LLM_API_KEY；厂商专有参数一律走 LLM_EXTRA_BODY / LLM_QUESTION_EXTRA_BODY
透传（换厂商时需一并清理，如 Qwen 的 enable_thinking）。

安全约定：API Key 仅在本模块内组装到请求头，不写日志、不进异常消息、不下发前端。
"""
import json
import logging
import time
from typing import Any, Dict, Iterator, List, Optional

import httpx

from app.core.config import settings
from app.services.llm_base import CallResult, LlmError, ensure_complete

logger = logging.getLogger(__name__)

_CHAT_PATH = "/chat/completions"
# 正常结束原因；其余取值（如 length）意味着回复被截断
_NORMAL_STOP_REASONS = ("stop",)
# SSE 分片格式：正文行以 data: 开头，流结束标记为 data: [DONE]
_SSE_DATA_PREFIX = "data:"
_SSE_DONE = "[DONE]"


def is_configured() -> bool:
    """本适配器所需配置是否齐备（供门面统一判定，不抛异常）。"""
    return bool(
        settings.LLM_BASE_URL.strip()
        and settings.LLM_MODEL.strip()
        and settings.LLM_API_KEY.strip()
    )


def model_label() -> str:
    """写入 ai_usage_logs.model 的模型标识：真实模型名。"""
    return settings.LLM_MODEL.strip()


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


def _require_key() -> str:
    key = settings.LLM_API_KEY.strip()
    if not key:
        raise LlmError("AI 服务未配置，请在后端环境变量中设置 LLM_API_KEY")
    return key


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


def _build_body(
    text: str,
    system: Optional[str],
    max_tokens: Optional[int],
    extra_body: Optional[Dict[str, Any]],
    stream: bool,
) -> Dict[str, Any]:
    """组装请求体：非流式与流式共用，差异只在 stream 相关字段。"""
    body: Dict[str, Any] = {
        "model": _resolve_model(),
        "messages": _build_messages(text, system),
        "stream": stream,
    }
    # 未显式指定时不传，交由供应商默认值；出题链路依赖长输出，不能被对话的 800 上限截断
    if max_tokens:
        body["max_tokens"] = max_tokens
    # 供应商专有参数（如 Qwen 的 enable_thinking）由配置透传，本模块不感知具体厂商
    body.update(settings.LLM_EXTRA_BODY)
    if extra_body:
        body.update(extra_body)
    if stream:
        # 上游默认不在流式响应里报用量，须显式索取，否则 ai_usage_logs 的 used_tokens 恒为空
        body["stream_options"] = {"include_usage": True}
    return body


def _auth_headers() -> Dict[str, str]:
    """组装鉴权头。API Key 只在此处出现，不写日志、不进异常消息。"""
    return {
        # 显式声明 charset，避免中文提示词被上游按其他编码解释
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": f"Bearer {_require_key()}",
    }


def _read_json(response: "httpx.Response") -> Any:
    """读取流式响应的错误体：httpx 要求先 read() 才能 json()，失败按无错误体处理。"""
    try:
        response.read()
        return response.json()
    except (ValueError, httpx.HTTPError):
        return None


def _request_once(
    text: str,
    system: Optional[str],
    timeout: float,
    max_tokens: Optional[int],
    extra_body: Optional[Dict[str, Any]] = None,
) -> CallResult:
    """发一次 Chat Completions 调用；失败抛 LlmError（不含密钥）。"""
    body = _build_body(text, system, max_tokens, extra_body, stream=False)
    started = time.monotonic()
    try:
        response = httpx.post(
            _resolve_url(), json=body, headers=_auth_headers(), timeout=timeout
        )
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
    ensure_complete(result, _NORMAL_STOP_REASONS)
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
    _require_key()
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


class OpenAiStream:
    """一次流式 Chat Completions 调用：迭代取增量正文，迭代结束后 `result` 给出用量与结束原因。

    构造即校验配置（base_url / model / api_key），使「未配置」这类错误在响应头发出之前
    就以普通 JSON + 502 返回，而不是退化成流中途的 error 事件（此时状态码已无法更改）。

    与非流式 `prompt_meta` 的关键差异：**不做自动重试**。重试意味着重新生成整段回答，
    而增量可能已经推给了用户，重发会导致正文重复；瞬时故障改由前端「停止 / 重试」兜底。

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
        self._body = _build_body(text, system, max_tokens, extra_body, stream=True)
        self._timeout = timeout or settings.LLM_TIMEOUT_SECONDS
        self.result: Optional[CallResult] = None

    def __iter__(self) -> Iterator[str]:
        started = time.monotonic()
        parts: List[str] = []
        used_tokens: Optional[int] = None
        stop_reason = ""
        try:
            with httpx.stream(
                "POST",
                _resolve_url(),
                json=self._body,
                headers=_auth_headers(),
                timeout=self._timeout,
            ) as response:
                if response.status_code != 200:
                    raise _http_error(
                        response.status_code, _error_code(_read_json(response))
                    )
                for line in response.iter_lines():
                    if not line.startswith(_SSE_DATA_PREFIX):
                        continue
                    payload = line[len(_SSE_DATA_PREFIX) :].strip()
                    if payload == _SSE_DONE:
                        break
                    try:
                        chunk = json.loads(payload)
                    except ValueError:
                        # 丢一片只少几个字，中断整条流会让已显示的半截回答失去下文
                        logger.warning("llm stream: skip unparsable chunk")
                        continue
                    if not isinstance(chunk, dict):
                        continue
                    usage = chunk.get("usage")
                    if isinstance(usage, dict):
                        total = usage.get("total_tokens")
                        if isinstance(total, int):
                            used_tokens = total
                    choices = chunk.get("choices")
                    # 只带 usage 的收尾分片没有 choices，跳过即可
                    if not isinstance(choices, list) or not choices:
                        continue
                    first = choices[0] if isinstance(choices[0], dict) else {}
                    if first.get("finish_reason"):
                        stop_reason = str(first["finish_reason"])
                    # 只取正文增量：reasoning_content 是思考过程，既不展示给用户也不入库
                    piece = (first.get("delta") or {}).get("content")
                    if piece:
                        parts.append(piece)
                        yield piece
        except httpx.TimeoutException:
            raise LlmError("AI 生成超时，请稍后重试", retryable=True)
        except httpx.HTTPError as exc:
            logger.warning("llm stream failed: %s", exc.__class__.__name__)
            raise LlmError("AI 服务请求失败，请检查服务器网络后重试", retryable=True)

        self.result = CallResult(
            text="".join(parts).strip(),
            used_tokens=used_tokens,
            stop_reason=stop_reason,
            elapsed_ms=int((time.monotonic() - started) * 1000),
        )
        ensure_complete(self.result, _NORMAL_STOP_REASONS)


def stream(
    text: str,
    *,
    system: Optional[str] = None,
    timeout: Optional[float] = None,
    max_tokens: Optional[int] = None,
    extra_body: Optional[Dict[str, Any]] = None,
) -> OpenAiStream:
    """创建一次流式调用（适配器契约：门面 LlmStream 转发到此）。"""
    return OpenAiStream(
        text,
        system=system,
        timeout=timeout,
        max_tokens=max_tokens,
        extra_body=extra_body,
    )
