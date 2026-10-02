"""长征路线路由：路线进度、节点详情、点亮。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core import ws as ws_manager
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import (
    FootprintsOut,
    GlobalGoalOut,
    LightUpResult,
    NodeDetailOut,
    RouteNodeConfigListOut,
    RouteOut,
)
from app.services import march_service, medal_service

router = APIRouter(prefix="/march", tags=["march"])


@router.get(
    "/route-nodes",
    response_model=RouteNodeConfigListOut,
    summary="启用的路线节点配置",
)
def route_nodes(
    current: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    return {"nodes": march_service.get_route_nodes(db)}


@router.get("/route", response_model=RouteOut, summary="长征路线进度")
def route(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return march_service.get_route(db, current.id)


@router.get("/global", response_model=GlobalGoalOut, summary="全员共同长征目标")
def global_goal(
    current: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """全员共同目标（需求 §11）：全员累计步数对 2 亿步总目标的进度与阶段里程碑。"""
    return march_service.get_global_goal(db)


@router.get("/footprints", response_model=FootprintsOut, summary="我的长征足迹")
def footprints(
    current: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    """我的长征足迹（需求 §7）：已点亮节点的点亮日期/当日步数/累计步数（时间+路线结合）。"""
    return march_service.get_footprints(db, current.id)


@router.get("/node/{node_id}", response_model=NodeDetailOut, summary="节点详情")
def node_detail(
    node_id: int,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """任意状态节点均可查看历史详情（含未解锁）。"""
    detail = march_service.get_node_detail(db, current.id, node_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="节点不存在")
    return detail


@router.post("/light-up", response_model=LightUpResult, summary="点亮达标节点")
def light_up(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """按当前累计步数点亮达标节点、发放积分，并刷新勋章；同时判定章节完成。"""
    newly, new_chapters = march_service.light_up_nodes(db, current.id)
    medal_service.check_and_grant(db, current.id)
    ws_manager.broadcast(ws_manager.build_event("march.light-up", current.id))
    return {"newly_lit": newly, "newly_completed_chapters": new_chapters}
