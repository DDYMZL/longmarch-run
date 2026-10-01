"""WebSocket 连接管理：向管理端实时推送数据变更事件。

同步路由（业务写操作）运行在请求线程中，broadcast 通过
run_coroutine_threadsafe 把发送任务投递到事件循环，不阻塞业务请求。
首个连接建立时记录事件循环引用；无连接或事件循环不可用时广播静默跳过。
"""
import asyncio
import json
import time
from typing import Any, List, Optional

from fastapi import WebSocket

_connections: List[WebSocket] = []
_loop: Optional[asyncio.AbstractEventLoop] = None


def _now_ms() -> int:
    """当前毫秒时间戳。"""
    return int(time.time() * 1000)


def build_event(reason: str, user_id: int) -> dict:
    """构造数据变更事件（仅事件类型与元信息，不含业务数据）。"""
    return {"type": "data_changed", "reason": reason, "user_id": user_id, "at": _now_ms()}


def build_activity(event_type: str, user_id: int, nickname: str, text: str) -> dict:
    """构造实时动态事件（管理端驾驶舱/大屏动态流直接展示 text）。"""
    return {
        "type": "activity",
        "eventType": event_type,
        "userId": user_id,
        "nickname": nickname,
        "text": text,
        "at": _now_ms(),
    }


async def connect(ws: WebSocket) -> None:
    """接受连接并登记；同时记录事件循环供同步代码投递。"""
    global _loop
    await ws.accept()
    _loop = asyncio.get_running_loop()
    _connections.append(ws)


def disconnect(ws: WebSocket) -> None:
    """移除连接（断线时由路由调用）。"""
    if ws in _connections:
        _connections.remove(ws)


async def _safe_send(ws: WebSocket, text: str) -> None:
    """单条发送，连接已关闭时静默忽略。"""
    try:
        await ws.send_text(text)
    except Exception:
        pass


def broadcast(event: dict) -> None:
    """从同步代码广播事件；投递失败静默忽略，不影响业务请求。"""
    if not _connections or _loop is None:
        return
    text = json.dumps(event, ensure_ascii=False)
    for ws in list(_connections):
        try:
            asyncio.run_coroutine_threadsafe(_safe_send(ws, text), _loop)
        except Exception:
            pass
