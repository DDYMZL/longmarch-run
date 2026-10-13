"""勋章路由：列表、检查发放。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import require_activity_participation, require_activity_view
from app.core import ws as ws_manager
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import MedalGrantResult, MedalListOut
from app.services import activity_service, medal_service

router = APIRouter(prefix="/medal", tags=["medal"])


@router.get("/list", response_model=MedalListOut, summary="勋章列表")
def medal_list(current: User = Depends(require_activity_view), db: Session = Depends(get_db)):
    """活动进行中返回前先检查发放；活动不可参与时只读，不再发放勋章。"""
    if activity_service.is_participation_open(db):
        medal_service.check_and_grant(db, current.id)
    return {
        "medals": medal_service.get_medal_list(db, current.id),
        "owned_count": medal_service.get_owned_count(db, current.id),
    }


@router.post("/check", response_model=MedalGrantResult, summary="检查并发放勋章")
def check(current: User = Depends(require_activity_participation), db: Session = Depends(get_db)):
    """发放新勋章后广播，管理端人员档案可实时刷新勋章模块。"""
    result = medal_service.check_and_grant(db, current.id)
    if result:
        ws_manager.broadcast(ws_manager.build_event("medal.check", current.id))
    return {"newly": result}
