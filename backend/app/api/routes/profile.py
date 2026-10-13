"""个人档案路由：档案聚合、长征足迹时间轴。"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import require_activity_view
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import ProfileSummaryOut, ProfileTimelineOut
from app.services import profile_service

router = APIRouter(prefix="/profile", tags=["profile"])


@router.get("/summary", response_model=ProfileSummaryOut, summary="个人档案聚合")
def summary(current: User = Depends(require_activity_view), db: Session = Depends(get_db)):
    return profile_service.get_summary(db, current)


@router.get("/timeline", response_model=ProfileTimelineOut, summary="我的长征足迹")
def timeline(
    limit: int = Query(50, ge=1, le=200),
    current: User = Depends(require_activity_view),
    db: Session = Depends(get_db),
):
    return {"items": profile_service.get_timeline(db, current.id, limit)}
