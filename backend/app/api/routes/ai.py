"""AI 智能中心路由（小程序契约，camelCase）：历史助手对话/会话、节点讲解、答题解析。

安全与稳定性：
- 会话归属一律由 JWT 用户确定，读写他人会话按「不存在」处理（404），不接受客户端指定 user_id；
- 统一异常映射：AiDisabledError→403、AiLimitError→429、CloudBaseError→502、ValueError→400；
- 节点讲解为已审核固定内容、答题解析优先取题库已有解析，二者不调模型、不消耗额度，
  AI 总开关关闭时仍可用；仅历史助手对话与「无解析时的答题解析」会真正调用模型。
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_activity_view
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import (
    AiChatOut,
    AiChatRequest,
    AiConversationDetailOut,
    AiConversationListOut,
    AiQuizExplanationOut,
    AiRouteGuideOut,
    MessageOut,
)
from app.services import (
    ai_chat_service,
    ai_config_service,
    ai_usage_service,
    cloudbase_service,
)

router = APIRouter(prefix="/ai", tags=["ai"])

# AI 服务层异常联合类型：均为 ValueError 子类，捕获顺序不影响（由 ai_http_error 内部判定）
AI_ERRORS = (
    ai_config_service.AiDisabledError,
    ai_usage_service.AiLimitError,
    cloudbase_service.CloudBaseError,
    ValueError,
)


def ai_http_error(exc: Exception) -> HTTPException:
    """把 AI 服务层异常映射为 HTTP 状态码（子类先于 ValueError 判定）。管理端 AI 路由复用。"""
    if isinstance(exc, ai_config_service.AiDisabledError):
        return HTTPException(status_code=403, detail=str(exc))
    if isinstance(exc, ai_usage_service.AiLimitError):
        return HTTPException(status_code=429, detail=str(exc))
    if isinstance(exc, cloudbase_service.CloudBaseError):
        return HTTPException(status_code=502, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


@router.post("/chat", response_model=AiChatOut, summary="历史助手提问")
def chat(
    payload: AiChatRequest,
    current: User = Depends(require_activity_view),
    db: Session = Depends(get_db),
):
    """连续对话：conversationId 为空新建会话，非空须为本人会话；返回回答与核验过的知识来源。"""
    try:
        return ai_chat_service.send_message(
            db, current, payload.message, payload.conversation_id, payload.node_id
        )
    except AI_ERRORS as exc:
        raise ai_http_error(exc)


@router.get("/conversations", response_model=AiConversationListOut, summary="我的会话列表")
def conversations(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    total, items = ai_chat_service.list_conversations(db, current.id, page, page_size)
    return {"total": total, "items": items}


@router.get(
    "/conversations/{conversation_id}",
    response_model=AiConversationDetailOut,
    summary="会话详情（含消息）",
)
def conversation_detail(
    conversation_id: int,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        return ai_chat_service.get_conversation(db, current.id, conversation_id)
    except ValueError as exc:
        # 仅「会话不存在」（含越权访问他人会话）会走到这里，统一 404 不泄露归属
        raise HTTPException(status_code=404, detail=str(exc))


@router.delete(
    "/conversations/{conversation_id}", response_model=MessageOut, summary="删除本人会话"
)
def conversation_delete(
    conversation_id: int,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    try:
        ai_chat_service.delete_conversation(db, current.id, conversation_id)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail=str(exc))
    return {"message": "已删除"}


@router.get("/route-guide/{node_id}", response_model=AiRouteGuideOut, summary="节点历史讲解")
def route_guide(
    node_id: int,
    current: User = Depends(require_activity_view),
    db: Session = Depends(get_db),
):
    """返回该节点已审核固定讲解（优先已发布知识资料，否则节点字段拼装）；不调模型、可缓存。"""
    try:
        return ai_chat_service.route_guide(db, node_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get(
    "/quiz-explanation/{question_id}", response_model=AiQuizExplanationOut, summary="答题解析"
)
def quiz_explanation(
    question_id: int,
    current: User = Depends(require_activity_view),
    db: Session = Depends(get_db),
):
    """按题目 ID 返回标准答案与解析：题库已有解析直接返回，无解析才调模型（以库内正确答案为准）。

    仅限本人已作答/已超时的题目，防发作答前经此接口泄露答案；不改动任何答题记录与积分。
    """
    try:
        return ai_chat_service.quiz_explanation(db, current, question_id)
    except AI_ERRORS as exc:
        raise ai_http_error(exc)
