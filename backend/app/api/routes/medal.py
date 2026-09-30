"""勋章路由：列表、检查发放。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import MedalGrantResult, MedalListOut
from app.services import medal_service

router = APIRouter(prefix="/medal", tags=["medal"])


@router.get("/list", response_model=MedalListOut, summary="勋章列表")
def medal_list(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """返回前先检查发放，确保展示与用户当前行为一致。"""
    medal_service.check_and_grant(db, current.id)
    return {
        "medals": medal_service.get_medal_list(db, current.id),
        "owned_count": medal_service.get_owned_count(db, current.id),
    }


@router.post("/check", response_model=MedalGrantResult, summary="检查并发放勋章")
def check(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"newly": medal_service.check_and_grant(db, current.id)}
