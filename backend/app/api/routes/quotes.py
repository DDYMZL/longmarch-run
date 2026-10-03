"""每日寄语路由（需求 §16）。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import QuoteTodayOut
from app.services import quote_service
from app.core.helpers import today_str

router = APIRouter(prefix="/quotes", tags=["quotes"])


@router.get("/today", response_model=QuoteTodayOut, summary="今日寄语")
def today(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """今日寄语：当天优先，无当天则取最近一条不晚于今天的寄语；没有则返回 null。"""
    return quote_service.get_today(db, today_str())
