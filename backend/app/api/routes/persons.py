"""长征人物志路由（需求 §14）。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import PersonDetailOut
from app.services import person_service

router = APIRouter(prefix="/persons", tags=["persons"])


@router.get("/{person_id}", response_model=PersonDetailOut, summary="人物志详情")
def detail(person_id: int, current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """人物头像/名称/简介 + 相关历史事件（路线节点）与历史时间。"""
    person = person_service.get_person_detail(db, person_id)
    if person is None:
        raise HTTPException(status_code=404, detail="人物不存在")
    return person
