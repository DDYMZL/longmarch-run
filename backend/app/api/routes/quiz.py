"""答题路由：今日题目、提交答卷、记录、重置。"""
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core import ws as ws_manager
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import (
    MessageOut,
    QuizDailyOut,
    QuizKnowledgeOut,
    QuizRecordOut,
    SubmitRequest,
)
from app.services import medal_service, quiz_service

router = APIRouter(prefix="/quiz", tags=["quiz"])


@router.get("/daily", response_model=QuizDailyOut, summary="今日题目")
def daily(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """同一天多次调用返回同一套题；已完成则返回答题记录。"""
    return quiz_service.get_daily(db, current.id)


@router.post("/submit", response_model=QuizRecordOut, summary="提交答卷")
def submit(
    payload: SubmitRequest,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """每日仅可提交一次；后端判分并发放积分，随后刷新勋章。"""
    answers = [{"question_id": a.question_id, "answer": a.answer} for a in payload.answers]
    try:
        record = quiz_service.submit(db, current.id, answers)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    medal_service.check_and_grant(db, current.id)
    ws_manager.broadcast(ws_manager.build_event("quiz.submit", current.id))
    return record


@router.get("/records", response_model=List[QuizRecordOut], summary="答题记录")
def records(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return quiz_service.get_records(db, current.id)


@router.get("/knowledge", response_model=QuizKnowledgeOut, summary="知识画像")
def knowledge(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """按题目分类（历史事件/长征路线/历史人物）聚合历史答题正确率。"""
    return quiz_service.get_knowledge(db, current.id)


@router.post("/reset", response_model=MessageOut, summary="重置今日答题（调试用）")
def reset(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    quiz_service.reset_today(db, current.id)
    ws_manager.broadcast(ws_manager.build_event("quiz.reset", current.id))
    return {"message": "已重置今日答题"}
