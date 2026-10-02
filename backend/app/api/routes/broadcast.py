"""今日播报路由：全局播报 + 个人进度 + 长征记忆彩蛋 + 实时行军动态。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import ActivitiesOut, BroadcastTodayOut
from app.services import broadcast_service, event_service

router = APIRouter(prefix="/broadcast", tags=["broadcast"])


@router.get("/today", response_model=BroadcastTodayOut, summary="今日播报聚合")
def today(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return broadcast_service.get_today(db, current.id)


@router.get("/activities", response_model=ActivitiesOut, summary="实时行军动态（小程序）")
def activities(
    limit: int = 10,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """全用户成就动态倒序（需求 §8.3/8.5）；实时增量经 WebSocket activity 消息下发。"""
    return {"items": event_service.list_public_activities(db, max(1, min(limit, 50)))}
