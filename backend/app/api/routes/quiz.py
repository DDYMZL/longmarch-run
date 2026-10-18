"""答题路由：今日状态、开题、逐题提交、记录、重置。"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import require_activity_participation, require_activity_view
from app.core import ws as ws_manager
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import (
    MessageOut,
    QuizAnswerOut,
    QuizAnswerRequest,
    QuizDailyOut,
    QuizKnowledgeOut,
    QuizRecordsOut,
)
from app.services import medal_service, quiz_service

router = APIRouter(prefix="/quiz", tags=["quiz"])


@router.get("/daily", response_model=QuizDailyOut, summary="今日答题状态")
def daily(current: User = Depends(require_activity_view), db: Session = Depends(get_db)):
    """逐题进度与当前作答题（含服务器截止时间）；未开题时 current 为空，已完成返回含逐题结果的记录。"""
    return quiz_service.get_daily(db, current.id)


@router.post("/start", response_model=QuizDailyOut, summary="开始/继续当前题")
def start(current: User = Depends(require_activity_participation), db: Session = Depends(get_db)):
    """幂等：作答中则返回同一题与剩余时间；当前题已截止则判超时并开下一题（每题 90 秒，服务器计时）。"""
    state = quiz_service.start(db, current.id)
    if state["completed"]:
        medal_service.check_and_grant(db, current.id)
    return state


@router.post("/answer", response_model=QuizAnswerOut, summary="提交当前题答案")
def answer(
    payload: QuizAnswerRequest,
    current: User = Depends(require_activity_participation),
    db: Session = Depends(get_db),
):
    """每题仅可提交一次，超时（服务器时间）拒绝；即时判定并同步答题积分，最后一题后生成当日记录。"""
    try:
        result = quiz_service.answer(db, current.id, payload.question_id, payload.answer)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if result["finished"]:
        medal_service.check_and_grant(db, current.id)
    ws_manager.broadcast(ws_manager.build_event("quiz.answer", current.id))
    return result


@router.get("/records", response_model=QuizRecordsOut, summary="答题记录（分页）")
def records(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    page_size_camel: Optional[int] = Query(
        None, ge=1, le=100, alias="pageSize", include_in_schema=False
    ),
    current: User = Depends(require_activity_view),
    db: Session = Depends(get_db),
):
    """分页返回答题记录（新到旧），附带基于全量（非当页）的累计答对/平均得分汇总。

    #16：分页参数同时接受 page_size 与 pageSize（pageSize 优先），避免旧调用方静默失效。
    """
    effective_page_size = page_size_camel if page_size_camel is not None else page_size
    return quiz_service.get_records(db, current.id, page, effective_page_size)


@router.get("/knowledge", response_model=QuizKnowledgeOut, summary="知识画像")
def knowledge(current: User = Depends(require_activity_view), db: Session = Depends(get_db)):
    """按题目分类（历史事件/长征路线/历史人物）聚合历史答题正确率。"""
    return quiz_service.get_knowledge(db, current.id)


@router.post("/reset", response_model=MessageOut, summary="重置今日答题（调试用）")
def reset(current: User = Depends(require_activity_participation), db: Session = Depends(get_db)):
    quiz_service.reset_today(db, current.id)
    ws_manager.broadcast(ws_manager.build_event("quiz.reset", current.id))
    return {"message": "已重置今日答题"}
