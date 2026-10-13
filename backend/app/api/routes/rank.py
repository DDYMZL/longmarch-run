"""排名路由：全员工总积分榜（与管理端排名同一口径）。"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import require_activity_view
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import PointsRankOut, RankListOut
from app.services import rank_service

router = APIRouter(prefix="/rank", tags=["rank"])


@router.get("/points", response_model=PointsRankOut, summary="全员工总积分排行榜")
def points_rank(
    page: int = Query(1, ge=1, description="第 11 名起的分页页码"),
    page_size: int = Query(20, ge=1, le=50),
    current: User = Depends(require_activity_view),
    db: Session = Depends(get_db),
):
    """按总积分降序（同分按累计步数、再按 user_id），top 为前 10 名，list 为第 11 名起分页。"""
    return rank_service.get_points_rank(db, current.id, page, page_size)


@router.get("/steps", response_model=RankListOut, summary="排行榜（旧版契约）")
def steps_rank(current: User = Depends(require_activity_view), db: Session = Depends(get_db)):
    """旧版榜单结构，名次与总积分榜一致。"""
    return rank_service.get_steps_rank(db, current.id)
