"""积分路由：积分概览（总/步行/答题/今日/名次）与按日明细。"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import require_activity_view
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import PointsDailyOut, PointsSummaryOut
from app.services import points_service, rank_service

router = APIRouter(prefix="/points", tags=["points"])


@router.get("", response_model=PointsSummaryOut, summary="积分概览")
def points(current: User = Depends(require_activity_view), db: Session = Depends(get_db)):
    """total = walk + quiz，全部由后端台账计算；rank 与排行榜同一口径。"""
    return {
        **points_service.get_summary(db, current.id),
        "rank": rank_service.get_user_rank(db, current.id),
    }


@router.get("/daily", response_model=PointsDailyOut, summary="积分明细（按自然日）")
def daily(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current: User = Depends(require_activity_view),
    db: Session = Depends(get_db),
):
    return points_service.get_daily_details(db, current.id, page, page_size)
