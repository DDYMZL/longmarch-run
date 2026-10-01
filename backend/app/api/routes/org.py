"""组织架构路由：逐级下钻、我的组织、选定/修改组织。"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core import ws as ws_manager
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import OrgChildrenOut, SelectOrgRequest, UserOrgOut
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
