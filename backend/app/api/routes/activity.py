"""活动状态路由（公开）。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.schemas import ActivityStatusOut
from app.services import activity_service

router = APIRouter(prefix="/activity", tags=["activity"])


@router.get("/status", response_model=ActivityStatusOut, summary="活动状态（公开）")
def status(db: Session = Depends(get_db)):
    """公开接口（无需登录）：小程序启动页在登录前即需判定活动状态以决定是否进入；
    仅返回活动名称、起止时间、状态与提示文案，不含任何用户数据。"""
    return activity_service.get_status(db)
