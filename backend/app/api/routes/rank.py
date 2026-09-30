"""排名路由：全员工累计步数总榜。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import RankListOut
from app.services import rank_service

router = APIRouter(prefix="/rank", tags=["rank"])


@router.get("/steps", response_model=RankListOut, summary="全员工累计步数排行榜")
def steps_rank(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """跨所有组织的员工个人总榜，按累计步数降序，标记我的名次。"""
    return rank_service.get_steps_rank(db, current.id)
