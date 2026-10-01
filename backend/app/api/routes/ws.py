"""WebSocket 路由：管理端数据变更实时推送。

小程序侧任何用户数据写入（步数同步、答题提交、节点点亮、组织选定、登录、
勋章发放）成功后都会向所有已连接的管理端广播 data_changed 事件，管理端据此
自动刷新，无需轮询。
"""
from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.core import ws as ws_manager
from app.core.database import get_db
from app.core.security import decode_token
from app.models.models import User

router = APIRouter(prefix="/ws", tags=["ws"])


@router.websocket("/updates")
async def updates(
    ws: WebSocket,
    token: str = Query("", description="JWT（浏览器原生 WebSocket 无法携带请求头）"),
    db: Session = Depends(get_db),
):
    """建立数据变更长链接；鉴权失败以 4401 关闭，仅向客户端推送事件不接收数据。

    同时接受小程序用户令牌与管理端令牌（role=admin），管理端页面用自身登录令牌接入。
    """
    payload = decode_token(token)
    is_admin = bool(payload and payload.get("role") == "admin")
    user = None
    if not is_admin and payload and payload.get("sub"):
        try:
            user = db.query(User).filter(User.id == int(payload["sub"])).first()
        except (TypeError, ValueError):
            user = None
    if not is_admin and user is None:
        await ws.close(code=4401)
        return
    await ws_manager.connect(ws)
    try:
        while True:
            # 客户端心跳等消息统一忽略
            await ws.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)
