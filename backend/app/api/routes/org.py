"""组织架构路由：逐级下钻、我的组织、选定/修改组织。"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core import ws as ws_manager
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import (
    OrgChildrenOut,
    OrgCompanionsOut,
    OrgMarchOut,
    SelectOrgRequest,
    UserOrgOut,
)
from app.services import org_service

router = APIRouter(prefix="/org", tags=["org"])


@router.get("/children", response_model=OrgChildrenOut, summary="按层级获取下级组织")
def children(
    parent_id: Optional[int] = Query(None, alias="parentId", description="上级组织 id，留空返回顶级"),
    db: Session = Depends(get_db),
):
    """不鉴权也可浏览组织树；返回该层级全部组织及是否有下级。"""
    return {"nodes": org_service.get_children(db, parent_id)}


@router.get("/mine", response_model=UserOrgOut, summary="我的所属组织")
def mine(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return org_service.get_user_org(db, current)


@router.get("/companions", response_model=OrgCompanionsOut, summary="同组织同行者")
def companions(
    limit: int = Query(6, description="同行者列表条数（1~50）"),
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """我的组织同行概况（需求 §9）：同行人数 / 今日共同前进 / 同行者（今日步数倒序，限量）。"""
    return org_service.get_companions(db, current, max(1, min(limit, 50)))


@router.get("/march", response_model=OrgMarchOut, summary="组织共同长征目标")
def org_march(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """组织集体长征（需求 §10）：组织累计步数 = 子树成员累计有效步数之和，路线进度按此计算。"""
    return org_service.get_org_march(db, current)


@router.post("/select", response_model=UserOrgOut, summary="选定/修改所属组织")
def select(
    payload: SelectOrgRequest,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """可选定任意层级组织；组织不存在返回 404。"""
    user = org_service.set_user_org(db, current.id, payload.org_id)
    if user is None:
        raise HTTPException(status_code=404, detail="组织不存在")
    ws_manager.broadcast(ws_manager.build_event("org.select", current.id))
    return org_service.get_user_org(db, user)
