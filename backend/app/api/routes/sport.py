"""运动路由：今日步数、同步、最近记录、行军日历、手动补充。"""
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core import ws as ws_manager
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import (
    AddStepsRequest,
    RecentItem,
    SportCalendarOut,
    SportSync,
    SportToday,
)
from app.services import medal_service, sport_service

router = APIRouter(prefix="/sport", tags=["sport"])


@router.get("/today", response_model=SportToday, summary="今日步数概况")
def today(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return sport_service.get_today(db, current.id)


@router.post("/sync", response_model=SportSync, summary="同步今日步数")
def sync(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """同步微信运动步数（未接入真实数据时按日期模拟），并刷新勋章。"""
    result = sport_service.sync_today(db, current.id)
    medal_service.check_and_grant(db, current.id)
    ws_manager.broadcast(ws_manager.build_event("sport.sync", current.id))
    return result


@router.get("/recent", response_model=List[RecentItem], summary="最近 n 天运动记录")
def recent(
    n: int = Query(7, ge=1, le=90),
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return sport_service.get_recent(db, current.id, n)


@router.get("/calendar", response_model=SportCalendarOut, summary="行军日历")
def calendar(
    month: str = Query(..., description="月份，格式 YYYY-MM"),
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if len(month) != 7 or month[4] != "-" or not month.replace("-", "").isdigit():
        raise HTTPException(status_code=400, detail="month 格式应为 YYYY-MM")
    return sport_service.get_calendar(db, current.id, month)


@router.post("/add", response_model=SportToday, summary="手动补充步数（演示用）")
def add_steps(
    payload: AddStepsRequest,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sport_service.add_steps(db, current.id, payload.delta)
    medal_service.check_and_grant(db, current.id)
    ws_manager.broadcast(ws_manager.build_event("sport.add", current.id))
    return sport_service.get_today(db, current.id)
