"""今日播报路由：全局播报 + 个人进度 + 长征记忆彩蛋。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import BroadcastTodayOut
from app.services import broadcast_service

router = APIRouter(prefix="/broadcast", tags=["broadcast"])


@router.get("/today", response_model=BroadcastTodayOut, summary="今日播报聚合")
def today(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return broadcast_service.get_today(db, current.id)
