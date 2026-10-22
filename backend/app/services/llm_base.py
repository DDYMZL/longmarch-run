"""大模型适配层共用类型（供应商无关）。

单独成模块的原因：门面 `llm_service` 需要 import 各供应商适配器，适配器又要共用同一套
异常与结果结构；若把这两个类型定义在门面里，就会形成 `llm_service` ↔ 适配器 的循环 import。

- `LlmError`：所有上游故障（配置缺失、鉴权失败、超时、5xx、回复截断）的统一异常类型。
  继承 ValueError 以便路由层沿用既有映射，但需先于 ValueError 捕获以映射为 502。
- `CallResult`：一次成功调用的正文 / 用量 / 结束原因 / 耗时，供上层落 `ai_usage_logs`。
- `ensure_complete`：截断与空回复都不作为成功结果返回。两家供应商「正常结束」的取值不同
  （OpenAI 兼容协议为 `stop`，ACP 为 `end_turn` / `stop_sequence`），故白名单由适配器传入。
"""
from dataclasses import dataclass
from typing import Optional, Tuple


class LlmError(ValueError):
    """模型调用失败。

    retryable=True 表示属瞬时故障（超时 / 5xx / 429 / 网络 / 空回复），可重试；
    配置缺失、鉴权失败、欠费、回复截断等重试无益，标记为不可重试。
    """

    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class CallResult:
    """一次成功调用的结果。

    used_tokens 口径随供应商而异（OpenAI 兼容协议取 usage.total_tokens，即输入+输出、
    与按量计费一致；CloudBase 取平台 usage_update.used 原值，含义未经核实，如实记录不换算）；
    上游未报告用量时为 None。elapsed_ms 为本次 HTTP 往返耗时。
    """

    text: str
    used_tokens: Optional[int] = None
    stop_reason: str = ""
    elapsed_ms: int = 0


def ensure_complete(result: CallResult, normal_stop_reasons: Tuple[str, ...]) -> None:
    """校验回复完整性：截断与空回复都抛 LlmError，不作为成功结果交给上层。

    截断意味着出题链路的 JSON 必然不完整、对话链路只给出半截回答，两者都不可用；
    空回复多为上游瞬时异常，标记为可重试。
    """
    if result.stop_reason and result.stop_reason not in normal_stop_reasons:
        raise LlmError(
            f"AI 回复未正常结束（{result.stop_reason}），请缩短输入或减少单次生成数量后重试"
        )
    if not result.text:
        raise LlmError("AI 服务返回空内容，请重试", retryable=True)
