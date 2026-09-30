"""积分路由：总额与流水。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import PointsDetail
from app.services import points_service

router = APIRouter(prefix="/points", tags=["points"])


@router.get("", response_model=PointsDetail, summary="积分总额与流水")
def points(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {
        "total": points_service.get_total(db, current.id),
        "logs": points_service.get_logs(db, current.id),
    }
