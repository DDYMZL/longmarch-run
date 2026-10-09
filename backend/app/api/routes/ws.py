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
from app.services import access_service

router = APIRouter(prefix="/ws", tags=["ws"])


@router.websocket("/updates")
async def updates(
    ws: WebSocket,
    token: str = Query("", description="JWT（浏览器原生 WebSocket 无法携带请求头）"),
    db: Session = Depends(get_db),
):
    """建立数据变更长链接；鉴权失败 4401 关闭，管理员授权被撤销 4403 关闭。

    同时接受小程序用户令牌与管理端令牌（role=admin）：超管令牌直接放行；
    微信关联管理员令牌建连时查库校验启用角色，权限撤销/禁用即时断权。
    """
    payload = decode_token(token)
    if not payload or not payload.get("sub"):
        await ws.close(code=4401)
        return
    is_super_admin = bool(
        payload.get("role") == "admin" and payload.get("typ") != "user"
    )
    try:
        user = db.query(User).filter(User.id == int(payload["sub"])).first()
    except (TypeError, ValueError):
        user = None
    if is_super_admin:
        pass
    elif user is None:
        await ws.close(code=4401)
        return
    elif payload.get("role") == "admin" and access_service.build_principal(db, user) is None:
        await ws.close(code=4403)
        return
    await ws_manager.connect(ws)
    try:
        while True:
            # 客户端心跳等消息统一忽略
            await ws.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)
