"""AI 智能中心路由（小程序契约，camelCase）：历史助手对话/会话、节点讲解、答题解析。

安全与稳定性：
- 会话归属一律由 JWT 用户确定，读写他人会话按「不存在」处理（404），不接受客户端指定 user_id；
- 统一异常映射：AiDisabledError→403、AiLimitError→429、LlmError→502、ValueError→400；
- 节点讲解为已审核固定内容、答题解析优先取题库已有解析，二者不调模型、不消耗额度，
  AI 总开关关闭时仍可用；仅历史助手对话与「无解析时的答题解析」会真正调用模型。
"""
import json
import logging
from typing import Any, Dict, Iterator, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_activity_view
from app.core.config import settings
from app.core.database import SessionLocal, get_db
from app.models.models import User
from app.schemas.schemas import (
    AiChatOut,
    AiChatRequest,
    AiConversationDetailOut,
    AiConversationListOut,
    AiQuizExplanationOut,
    AiRouteGuideOut,
    AiSuggestedQuestionsOut,
    MessageOut,
)
from app.services import (
    ai_chat_service,
    ai_config_service,
    ai_usage_service,
    llm_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ai", tags=["ai"])

# AI 服务层异常联合类型：均为 ValueError 子类，捕获顺序不影响（由 ai_http_error 内部判定）
AI_ERRORS = (
    ai_config_service.AiDisabledError,
    ai_usage_service.AiLimitError,
    llm_service.LlmError,
    ValueError,
)


def ai_http_error(exc: Exception) -> HTTPException:
    """把 AI 服务层异常映射为 HTTP 状态码（子类先于 ValueError 判定）。管理端 AI 路由复用。"""
    if isinstance(exc, ai_config_service.AiDisabledError):
        return HTTPException(status_code=403, detail=str(exc))
    if isinstance(exc, ai_usage_service.AiLimitError):
        return HTTPException(status_code=429, detail=str(exc))
    if isinstance(exc, llm_service.LlmError):
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


# 生产 nginx 默认 proxy_buffering on，会把整条流缓冲完再一次性吐给小程序，逐字效果尽失。
# 该响应头让 nginx 只对本次响应关闭缓冲，无需改动不在仓库内的服务器配置。
_STREAM_HEADERS = {"X-Accel-Buffering": "no", "Cache-Control": "no-cache"}


def _sse(event: Dict[str, Any]) -> str:
    """把一个事件对象编码成 SSE data 行（中文不转义，省一半带宽）。"""
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def _settle_aborted(
    db: Session,
    turn: ai_chat_service.ChatTurn,
    stream: llm_service.LlmStream,
    parts: List[str],
) -> None:
    """客户端中途断开（停止按钮 / 切页 / 断网）的收尾。

    已收到增量就把半截回答落库——会话历史要与用户屏幕上看到的一致，否则刷新后半截
    回答凭空消失；一个增量都没收到则删掉本次提问，不留「只有问没有答」的脏数据。
    """
    try:
        if parts:
            result = stream.result or llm_service.CallResult(
                text="".join(parts).strip(), used_tokens=None, stop_reason="", elapsed_ms=0
            )
            ai_chat_service.finalize_message(db, turn, result)
        else:
            ai_chat_service.discard_message(db, turn)
    except Exception as exc:  # 收尾失败不得掩盖触发它的原始异常
        logger.warning("ai chat stream settle failed: %s", exc.__class__.__name__)
        db.rollback()


@router.post("/chat/stream", summary="历史助手提问（SSE 逐字返回）")
def chat_stream(
    payload: AiChatRequest,
    current: User = Depends(require_activity_view),
    db: Session = Depends(get_db),
):
    """流式连续对话：事件序列 `start` → `delta`* → `done`，中途失败发 `error`。

    - `start`：conversationId + title，让前端立刻更新会话标题；
    - `delta`：一段增量正文（模型按 token 成块推送，前端再做逐字平滑）；
    - `done`：usedTokens + reply（reply 是已落库的权威全文，供前端校正本地拼接结果）；
    - `error`：message。此时 200 与响应头已发出，**状态码无法再改**，故错误只能走事件。

    前置校验（开关/限额/输入/会话归属）与 LlmStream 构造都在返回 StreamingResponse
    之前完成，这类失败仍是普通 JSON + 403/429/400/502，前端无需为它们解析 SSE。
    """
    try:
        turn = ai_chat_service.prepare_message(
            db, current, payload.message, payload.conversation_id, payload.node_id
        )
        stream = llm_service.LlmStream(
            turn.prompt_text,
            system=turn.system_prompt,
            timeout=turn.cfg.request_timeout,
            max_tokens=turn.cfg.max_output_tokens,
        )
    except AI_ERRORS as exc:
        raise ai_http_error(exc)

    def event_stream() -> Iterator[str]:
        # 生成器在依赖注入的会话关闭之后才执行，必须自建会话做收尾落库
        stream_db = SessionLocal()
        parts: List[str] = []
        settled = False
        try:
            yield _sse(
                {
                    "type": "start",
                    "conversationId": turn.conversation_id,
                    "title": turn.title,
                }
            )
            try:
                for piece in stream:
                    parts.append(piece)
                    yield _sse({"type": "delta", "text": piece})
            except llm_service.LlmError as exc:
                ai_chat_service.discard_message(stream_db, turn)
                ai_usage_service.record(
                    stream_db, feature=ai_chat_service.FEATURE_CHAT, user_id=turn.user_id,
                    model=settings.LLM_MODEL, status="error", error_code="llm",
                )
                stream_db.commit()
                settled = True
                yield _sse({"type": "error", "message": str(exc)})
                return
            ai_chat_service.finalize_message(stream_db, turn, stream.result)
            settled = True
            yield _sse(
                {
                    "type": "done",
                    "usedTokens": stream.result.used_tokens,
                    "reply": stream.result.text,
                    "sources": turn.sources,
                }
            )
        finally:
            if not settled:
                _settle_aborted(stream_db, turn, stream, parts)
            stream_db.close()

    return StreamingResponse(
        event_stream(), media_type="text/event-stream", headers=_STREAM_HEADERS
    )


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


@router.get(
    "/suggested-questions", response_model=AiSuggestedQuestionsOut, summary="AI 建议问题"
)
def suggested_questions(
    node_id: Optional[int] = Query(None, alias="nodeId", description="指定节点时附带该节点相关问题"),
    current: User = Depends(require_activity_view),
    db: Session = Depends(get_db),
):
    """通用建议问题（system_settings 可配）+ 指定节点的相关问题；不调模型、AI 关闭时仍可用。"""
    return {"items": ai_chat_service.suggested_questions(db, node_id)}
