"""大模型调用门面：按 `LLM_PROVIDER` 选择上游适配器，对业务层暴露唯一入口。

AI 问答、路线讲解、答题解析、后台出题四条链路都只 import 本模块，不感知具体供应商。
换供应商只改 env 的 `LLM_PROVIDER` 一行（两套凭证常驻配置文件，无需改代码）：

| LLM_PROVIDER | 适配器 | 协议 | 生效配置 |
| --- | --- | --- | --- |
| `openai`（默认） | `llm_openai` | OpenAI Chat Completions 兼容 | `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_EXTRA_BODY` |
| `cloudbase` | `llm_cloudbase` | 腾讯云 CloudBase Agent ACP | `CLOUDBASE_ENV_ID` / `CLOUDBASE_AGENT_ID` / `CLOUDBASE_API_KEY` |

`LLM_TIMEOUT_SECONDS` 两家共用。适配器须实现同一组约定：`is_configured()`、
`model_label()`、`prompt_meta()`，以及 `stream()`（返回一个「迭代产出增量正文、
迭代结束后给出 `result`」的对象）；新增供应商只需再加一个适配器模块并在 `_ADAPTERS` 里登记。

对外符号（业务层与测试脚本均按此引用，勿改名）：
- `LlmError` / `CallResult`：从 `llm_base` 重新导出，与各适配器抛出/构造的是同一个类对象；
- `prompt_meta` / `prompt`：非流式，一次拿完整正文；
- `LlmStream`：流式，迭代取增量正文，迭代结束后 `.result` 给出用量与结束原因；
- `model_label`：写入 `ai_usage_logs.model` 的模型标识（随供应商取值不同）。

安全约定：API Key 只在适配器内组装到请求头，不写日志、不进异常消息、不下发前端。
"""
from typing import Any, Dict, Iterator, Optional

from app.core.config import settings
from app.services import llm_cloudbase, llm_openai
from app.services.llm_base import CallResult, LlmError

__all__ = [
    "CallResult",
    "LlmError",
    "LlmStream",
    "is_configured",
    "model_label",
    "prompt",
    "prompt_meta",
]

PROVIDER_OPENAI = "openai"
PROVIDER_CLOUDBASE = "cloudbase"
_ADAPTERS = {PROVIDER_OPENAI: llm_openai, PROVIDER_CLOUDBASE: llm_cloudbase}


def _current():
    """当前 LLM_PROVIDER 对应的适配器模块；取值非法时返回 None（不抛异常）。"""
    return _ADAPTERS.get(settings.LLM_PROVIDER.strip().lower())


def _adapter():
    """当前生效的适配器模块；取值非法时抛 LlmError（路由层映射 502）。"""
    adapter = _current()
    if adapter is None:
        provider = settings.LLM_PROVIDER.strip().lower()
        raise LlmError(
            f"AI 服务未配置：LLM_PROVIDER 取值非法（{provider}），"
            f"应为 {' / '.join(sorted(_ADAPTERS))} 之一"
        )
    return adapter


def is_configured() -> bool:
    """当前供应商所需配置是否齐备（供冒烟脚本判定能否跑真实调用，不抛异常）。"""
    adapter = _current()
    return bool(adapter and adapter.is_configured())


def model_label() -> str:
    """写入 `ai_usage_logs.model` 的模型标识：openai 取真实模型名，cloudbase 取 Agent ID。

    仅供落库与排障展示，故**不抛异常**：供应商取值非法时原样返回该值（此时真正的
    报错由 prompt_meta / LlmStream 给出），避免在异常收尾路径里再抛一次掩盖原始错误。
    """
    adapter = _current()
    return adapter.model_label() if adapter else (settings.LLM_PROVIDER.strip() or "unknown")


def prompt_meta(
    text: str,
    *,
    system: Optional[str] = None,
    timeout: Optional[float] = None,
    max_retries: Optional[int] = None,
    max_tokens: Optional[int] = None,
    extra_body: Optional[Dict[str, Any]] = None,
) -> CallResult:
    """发送一次提示词并返回含用量的完整结果（出题链路需要完整 JSON 才能解析）。

    system 非空时作为系统提示下发（openai 走 system role，cloudbase 前缀拼接）；
    max_tokens / extra_body 在 cloudbase 下被忽略（ACP 无对应参数）。
    失败抛 LlmError；瞬时故障由适配器按 settings.AI_MAX_RETRIES 重试。
    """
    return _adapter().prompt_meta(
        text,
        system=system,
        timeout=timeout,
        max_retries=max_retries,
        max_tokens=max_tokens,
        extra_body=extra_body,
    )


def prompt(text: str, timeout: Optional[float] = None) -> str:
    """发送一次提示词，返回完整正文（出题链路专用）。

    出题要求严格 JSON 数组：百炼实测关闭思考模式后批次解析失败率明显上升（5 批挂 1 批），
    故此处叠加 LLM_QUESTION_EXTRA_BODY 恢复思考模式；出题由管理员触发且分批并发，
    可承受其额外时延与 token 开销。CloudBase 无思考开关，该覆盖项被适配器忽略。

    失败一律抛 LlmError（中文提示，不含密钥）。
    """
    return prompt_meta(
        text, timeout=timeout, extra_body=settings.LLM_QUESTION_EXTRA_BODY
    ).text


class LlmStream:
    """一次流式调用：迭代取增量正文，迭代结束后 `result` 给出用量与结束原因。

    仅做转发——实际协议由当前适配器实现。构造即校验配置，使「未配置 / 供应商取值非法」
    这类错误在响应头发出之前就以普通 JSON + 502 返回，而不是退化成流中途的 error 事件
    （此时状态码已无法更改）。

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
        self._impl = _adapter().stream(
            text,
            system=system,
            timeout=timeout,
            max_tokens=max_tokens,
            extra_body=extra_body,
        )

    def __iter__(self) -> Iterator[str]:
        for piece in self._impl:
            yield piece

    @property
    def result(self) -> Optional[CallResult]:
        return self._impl.result
