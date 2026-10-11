"""每日寄语路由（需求 §16、V1.1 功能二）。"""
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import QuoteTodayOut
from app.services import quote_service
from app.core.helpers import today_str

router = APIRouter(prefix="/quotes", tags=["quotes"])


@router.get("/today", response_model=Optional[QuoteTodayOut], summary="今日寄语")
def today(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """今日寄语：启用寄语按天循环；没有启用寄语时返回 null。"""
    return quote_service.get_today(db, today_str())
