"""腾讯云 CloudBase Agent 调用封装（ACP 协议）。

职责单一：发一次提示词、收完整文本回复。按 JSON-RPC 2.0 调用 session/prompt，
解析 SSE 事件流，只拼接 agent_message_chunk 的正文，忽略思考过程与用量事件。

安全约定：API Key 仅在本模块内组装到请求头，不写日志、不进异常消息、不下发前端。
"""
import json
import logging
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
    """


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


def _http_error(status_code: int) -> str:
    """把上游 HTTP 状态码翻译成面向管理员的中文提示（不暴露密钥与内部细节）。"""
    if status_code in (401, 403):
        return "AI 服务鉴权失败，请检查 CLOUDBASE_API_KEY 是否有效"
    if status_code == 404:
        return "AI 服务地址或 Agent ID 不正确"
    if status_code == 429:
        return "AI 服务请求过于频繁，请稍后重试"
    if status_code >= 500:
        return "AI 服务暂时不可用，请稍后重试"
    return f"AI 服务返回异常状态码 {status_code}"


def _consume_line(line: str, chunks: List[str]) -> bool:
    """处理一行 SSE 数据，把正文追加到 chunks；返回 True 表示本轮回复已结束。

    事件形态（实测）：
      data: {"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk",
             "content":{"type":"text","text":"..."}}}}   ← 正文分片
      data: {"id":1,"result":{"stopReason":"end_turn"}}   ← 终态帧
      data: [DONE]                                        ← 流结束
    agent_thought_chunk（思考过程）、usage_update、agent_phase 均不属于正文，直接忽略。
    """
    line = line.strip()
    if not line.startswith("data:"):
        return False
    payload = line[5:].strip()
    if not payload:
        return False
    if payload == _STREAM_DONE:
        return True
    try:
        event = json.loads(payload)
    except json.JSONDecodeError:
        return False
    if not isinstance(event, dict):
        return False
    if event.get("error"):
        raise CloudBaseError("AI 服务返回错误，请重试")
    result = event.get("result")
    if isinstance(result, dict):
        stop_reason = str(result.get("stopReason") or "")
        if stop_reason and stop_reason not in _NORMAL_STOP_REASONS:
            raise CloudBaseError(
                f"AI 回复未正常结束（{stop_reason}），请减少单次生成数量后重试"
            )
        return True
    update = (event.get("params") or {}).get("update") or {}
    if update.get("sessionUpdate") == "agent_message_chunk":
        content = update.get("content") or {}
        if content.get("type") == "text":
            chunks.append(content.get("text") or "")
    return False


def prompt(text: str, timeout: Optional[float] = None) -> str:
    """发送一次提示词，阻塞读取 SSE 直到回复结束，返回拼接后的完整正文。

    失败一律抛 CloudBaseError（中文提示，不含密钥）。
    """
    api_key = settings.CLOUDBASE_API_KEY.strip()
    if not api_key:
        raise CloudBaseError("AI 服务未配置，请在后端环境变量中设置 CLOUDBASE_API_KEY")
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
        "Authorization": f"Bearer {api_key}",
    }
    chunks: List[str] = []
    try:
        with httpx.Client(timeout=timeout or settings.CLOUDBASE_TIMEOUT_SECONDS) as client:
            with client.stream("POST", url, json=body, headers=headers) as response:
                if response.status_code != 200:
                    response.read()
                    raise CloudBaseError(_http_error(response.status_code))
                for line in response.iter_lines():
                    if _consume_line(line, chunks):
                        break
    except CloudBaseError:
        raise
    except httpx.TimeoutException:
        raise CloudBaseError("AI 生成超时，请减少数量或稍后重试")
    except httpx.HTTPError as exc:
        # 只记录异常类型，避免把 URL/请求细节写进日志
        logger.warning("cloudbase request failed: %s", exc.__class__.__name__)
        raise CloudBaseError("AI 服务请求失败，请检查服务器网络后重试")
    reply = "".join(chunks).strip()
    if not reply:
        raise CloudBaseError("AI 服务返回空内容，请重试")
    return reply
