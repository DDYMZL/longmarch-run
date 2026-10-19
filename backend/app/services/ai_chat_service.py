"""AI 助手运行时：历史助手对话、路线节点讲解、答题解析。

三条能力共用一套「配置 → 限额 → 检索已发布资料 → 组装提示词 → 调用大模型 →
落 ai_messages/ai_usage_logs」的编排，差异只在提示词与是否调用模型：

- chat（历史助手）：调用模型；无状态多轮，把最近 N 轮历史拼进单次提示词。
- route_guide（节点讲解）：只返回「已审核固定内容」，优先取该节点已发布知识资料，
  否则用节点自身字段拼装；不调用模型、不消耗额度、可缓存，AI 关闭时仍可用。
- quiz_explanation（答题解析）：题库已有解析则直接返回（不调模型）；仅在无解析时
  才调用模型，且以库内正确答案为准，绝不采信客户端提交的答案/积分，也不写回题库。

安全：会话归属一律由传入的 user 决定，读写他人会话一律按「不存在」处理；
提示词只注入公开史实与已发布资料，用户输入被当作普通文本（防提示词注入）。
"""
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.helpers import now_utc
from app.models.models import (
    AiConversation,
    AiMessage,
    Question,
    QuizAnswer,
    RouteNode,
    User,
)
from app.services import (
    ai_config_service,
    ai_knowledge_service,
    ai_usage_service,
    llm_service,
    setting_service,
)

logger = logging.getLogger(__name__)

FEATURE_CHAT = "chat"
FEATURE_ROUTE = "route_guide"
FEATURE_QUIZ = "quiz_explanation"
_TITLE_LEN = 24
_NOT_FOUND = "会话不存在"


# ---------------- 会话管理（归属校验） ----------------
def _owned_conversation(db: Session, user_id: int, conversation_id: int) -> Optional[AiConversation]:
    return (
        db.query(AiConversation)
        .filter(AiConversation.id == conversation_id, AiConversation.user_id == user_id)
        .first()
    )


def list_conversations(
    db: Session, user_id: int, page: int = 1, page_size: int = 20
) -> Tuple[int, List[Dict[str, Any]]]:
    """我的会话列表（active），按最近活跃倒序，含最后一条消息预览。"""
    query = db.query(AiConversation).filter(
        AiConversation.user_id == user_id, AiConversation.status == "active"
    )
    total = query.count()
    rows = (
        query.order_by(AiConversation.updated_at.desc(), AiConversation.id.desc())
        .offset((max(1, page) - 1) * page_size)
        .limit(page_size)
        .all()
    )
    items: List[Dict[str, Any]] = []
    for conv in rows:
        last = (
            db.query(AiMessage)
            .filter(AiMessage.conversation_id == conv.id)
            .order_by(AiMessage.id.desc())
            .first()
        )
        items.append(
            {
                "conversation_id": conv.id,
                "title": conv.title or "新的对话",
                "updated_at": conv.updated_at,
                "created_at": conv.created_at,
                "preview": (last.content[:40] if last else ""),
                "message_count": db.query(AiMessage)
                .filter(AiMessage.conversation_id == conv.id)
                .count(),
            }
        )
    return total, items


def get_conversation(db: Session, user_id: int, conversation_id: int) -> Dict[str, Any]:
    """取单个会话与其全部消息；非本人或不存在一律报「会话不存在」（不泄露归属）。"""
    conv = _owned_conversation(db, user_id, conversation_id)
    if conv is None:
        raise ValueError(_NOT_FOUND)
    messages = (
        db.query(AiMessage)
        .filter(AiMessage.conversation_id == conv.id)
        .order_by(AiMessage.id.asc())
        .all()
    )
    return {
        "conversation_id": conv.id,
        "title": conv.title or "新的对话",
        "created_at": conv.created_at,
        "updated_at": conv.updated_at,
        "messages": [
            {
                "id": m.id,
                "role": m.role,
                "content": m.content,
                "sources": m.sources or [],
                "created_at": m.created_at,
            }
            for m in messages
        ],
    }


def delete_conversation(db: Session, user_id: int, conversation_id: int) -> None:
    """删除本人会话（连同消息）；非本人或不存在报「会话不存在」。调用方负责 commit。"""
    conv = _owned_conversation(db, user_id, conversation_id)
    if conv is None:
        raise ValueError(_NOT_FOUND)
    # 显式删子表，不依赖数据库级联（SQLite 默认不强制外键，行为需与 openGauss 一致）
    db.query(AiMessage).filter(AiMessage.conversation_id == conv.id).delete()
    db.delete(conv)
    db.flush()


# ---------------- 提示词组装 ----------------
def _history_block(db: Session, conversation_id: Optional[int], turns: int) -> str:
    """取最近 turns 轮（user/assistant 交替）历史，拼成提示词对话历史段。"""
    if not conversation_id or turns <= 0:
        return ""
    recent = (
        db.query(AiMessage)
        .filter(AiMessage.conversation_id == conversation_id, AiMessage.role.in_(("user", "assistant")))
        .order_by(AiMessage.id.desc())
        .limit(turns * 2)
        .all()
    )
    if not recent:
        return ""
    recent = list(reversed(recent))
    lines = [("用户：" if m.role == "user" else "助手：") + m.content for m in recent]
    return "[对话历史]\n" + "\n".join(lines)


def _node_block(db: Session, node_id: Optional[int]) -> Tuple[str, List[Any]]:
    """节点背景段 + 该节点已发布知识资料（供追问时作为参考资料）。"""
    if not node_id:
        return "", []
    node = db.query(RouteNode).filter(RouteNode.id == node_id).first()
    if node is None:
        return "", []
    knowledge = ai_knowledge_service.published_for_node(db, node_id)
    parts = [f"节点名称：{node.name}"]
    if node.historical_time:
        parts.append(f"历史时间：{node.historical_time}")
    if node.location:
        parts.append(f"地点：{node.location}")
    if node.brief:
        parts.append(f"简介：{node.brief}")
    return "[节点背景]\n" + "\n".join(parts), knowledge


def _output_hint(cfg: ai_config_service.AiConfig) -> str:
    """把输出上限转成温和的字数提示（token≈0.6 字），软约束、不宣称硬截断。"""
    budget = max(100, int(cfg.max_output_tokens * 0.6))
    return f"（请把回答控制在约 {budget} 字以内，简明扼要）"


def _join_blocks(*blocks: str) -> str:
    return "\n\n".join(b for b in blocks if b)


# ---------------- 历史助手对话 ----------------
def send_message(
    db: Session,
    user: User,
    text: str,
    conversation_id: Optional[int] = None,
    node_id: Optional[int] = None,
) -> Dict[str, Any]:
    """处理一次提问：校验开关/限额 → 检索资料 → 调模型 → 落库并返回回答与来源。

    conversation_id 为空则新建会话；非空必须是本人会话，否则报「会话不存在」。
    仅统计成功调用；模型失败回滚本次用户消息，另记 error 日志后抛出（路由映射 502）。
    """
    cfg = ai_config_service.ensure_enabled(db)
    question = (text or "").strip()
    if not question:
        raise ValueError("请输入你的问题")
    if len(question) > cfg.max_input_chars:
        raise ValueError(f"单次提问不能超过 {cfg.max_input_chars} 字")
    ai_usage_service.check_limits(db, cfg, user.id)

    if conversation_id is not None:
        conv = _owned_conversation(db, user.id, conversation_id)
        if conv is None:
            raise ValueError(_NOT_FOUND)
    else:
        conv = AiConversation(user_id=user.id, title=question[:_TITLE_LEN])
        db.add(conv)
        db.flush()

    node_ctx, node_knowledge = _node_block(db, node_id)
    rows = node_knowledge or ai_knowledge_service.search_published(
        db, question, cfg.knowledge_top_k
    )
    if node_knowledge:
        # 节点追问：既有节点资料，也补充按问题检索到的资料（去重、限量）
        extra = ai_knowledge_service.search_published(db, question, cfg.knowledge_top_k)
        seen_ids = {r.id for r in rows}
        rows = rows + [r for r in extra if r.id not in seen_ids]
        rows = rows[: cfg.knowledge_top_k]
    references = ai_knowledge_service.format_context(rows)
    history = _history_block(db, conv.id, cfg.context_turns)

    prompt_text = _join_blocks(
        node_ctx,
        f"[参考资料]\n{references}" if references else "",
        history,
        f"[当前问题]\n{question}\n{_output_hint(cfg)}",
    )

    db.add(AiMessage(conversation_id=conv.id, role="user", content=question))
    db.flush()

    try:
        result = llm_service.prompt_meta(
            prompt_text,
            system=ai_config_service.get_prompt(db, "chat"),
            timeout=cfg.request_timeout,
            max_retries=cfg.max_retries,
            max_tokens=cfg.max_output_tokens,
        )
    except llm_service.LlmError as exc:
        db.rollback()  # 丢弃本次用户消息与新建会话，避免残留半截对话
        ai_usage_service.record(
            db, feature=FEATURE_CHAT, user_id=user.id, model=settings.LLM_MODEL,
            status="error", error_code="llm", elapsed_ms=None,
        )
        db.commit()
        raise

    sources = ai_knowledge_service.format_sources(rows)
    assistant = AiMessage(
        conversation_id=conv.id,
        role="assistant",
        content=result.text,
        sources=sources,
        used_tokens=result.used_tokens,
    )
    db.add(assistant)
    conv.updated_at = now_utc()
    ai_usage_service.record(
        db, feature=FEATURE_CHAT, user_id=user.id, conversation_id=conv.id,
        model=settings.LLM_MODEL, used_tokens=result.used_tokens,
        elapsed_ms=result.elapsed_ms, status="success",
    )
    db.commit()
    return {
        "conversation_id": conv.id,
        "title": conv.title or "新的对话",
        "reply": result.text,
        "sources": sources,
        "used_tokens": result.used_tokens,
    }


# ---------------- 路线节点讲解（固定内容，不调模型） ----------------
def route_guide(db: Session, node_id: int) -> Dict[str, Any]:
    """返回节点的已审核固定讲解：优先已发布知识资料，否则用节点字段拼装。

    未发布资料绝不出现；不调用模型、不消耗额度，AI 总开关关闭时依然可用（可缓存）。
    """
    node = db.query(RouteNode).filter(RouteNode.id == node_id).first()
    if node is None:
        raise ValueError("节点不存在")

    knowledge = ai_knowledge_service.published_for_node(db, node_id)
    if knowledge:
        top = knowledge[0]
        related = list(top.related or [])
        if not related:
            related = _default_related(node.name)
        return {
            "node_id": node.id,
            "name": node.name,
            "title": top.title,
            "content": top.content,
            "source": top.source or "",
            "source_type": "knowledge",
            "knowledge_id": top.id,
            "related_questions": related[:6],
        }

    content = _node_fallback_content(node)
    return {
        "node_id": node.id,
        "name": node.name,
        "title": node.name,
        "content": content,
        "source": "",
        "source_type": "node",
        "knowledge_id": None,
        "related_questions": _default_related(node.name),
    }


def _node_fallback_content(node: RouteNode) -> str:
    """无已发布知识资料时，用节点自身已审核字段拼装讲解正文。"""
    blocks: List[str] = []
    if node.brief:
        blocks.append(node.brief)
    if node.significance:
        blocks.append(f"历史意义：{node.significance}")
    if node.figures:
        blocks.append(f"相关人物：{node.figures}")
    if node.location:
        blocks.append(f"地点：{node.location}")
    if node.description and not blocks:
        blocks.append(node.description)
    return "\n\n".join(blocks) or (node.description or "暂无讲解内容")


def _default_related(node_name: str) -> List[str]:
    """节点无自定义相关问题时的兜底追问建议。"""
    return [
        f"{node_name}在长征中发生了什么？",
        f"{node_name}有哪些重要的历史意义？",
    ]


# AI 建议问题（工作流 A6）：通用问题默认文案，system_settings 键 ai_suggested_general 可覆盖
# （存 JSON 字符串数组）。前端不再硬编码，AI 总开关关闭时本能力仍可用（不调模型）。
_DEFAULT_SUGGESTED_GENERAL: List[str] = [
    "长征为什么要进行战略转移？",
    "遵义会议为什么是生死攸关的转折点？",
    "红军是如何飞夺泸定桥的？",
    "长征胜利有哪些伟大意义？",
]


def _general_questions(db: Session) -> List[str]:
    """通用建议问题：优先读 system_settings.ai_suggested_general（JSON 数组），缺失/非法回退默认。"""
    raw = setting_service.get_value(db, "ai_suggested_general")
    if raw and raw.strip():
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            parsed = None
        if isinstance(parsed, list):
            items = [str(x).strip() for x in parsed if str(x).strip()]
            if items:
                return items
    return list(_DEFAULT_SUGGESTED_GENERAL)


def suggested_questions(db: Session, node_id: Optional[int] = None) -> List[Dict[str, str]]:
    """AI 建议问题：通用问题 + （指定 nodeId 时）该节点的相关问题，返回 [{"text": ...}]。

    节点相关问题优先取该节点已发布知识资料的 related，否则用节点名兜底模板；
    与通用问题去重后追加。不调用模型、不消耗额度。
    """
    texts: List[str] = _general_questions(db)
    if node_id is not None:
        node = db.query(RouteNode).filter(RouteNode.id == node_id).first()
        if node is not None:
            related: List[str] = []
            knowledge = ai_knowledge_service.published_for_node(db, node_id)
            if knowledge:
                related = list(knowledge[0].related or [])
            if not related:
                related = _default_related(node.name)
            for q in related:
                q = (q or "").strip()
                if q and q not in texts:
                    texts.append(q)
    return [{"text": t} for t in texts]


# ---------------- 答题解析（题库优先，无解析才调模型） ----------------
def quiz_explanation(db: Session, user: User, question_id: int) -> Dict[str, Any]:
    """按题目 ID 返回标准答案与解析。

    题库已有解析 → 直接返回（source_type=bank，不调模型、不消耗额度）；
    无解析 → 校验开关/限额后调模型，以库内正确答案为准生成解析（source_type=ai），
    不写回题库、不改动任何答题记录与积分。
    """
    question = db.query(Question).filter(Question.id == question_id).first()
    if question is None:
        raise ValueError("题目不存在")

    # 防作弊：仅允许查看「本人已作答/已超时」题目的解析，避免作答前经此接口泄露正确答案。
    answered = (
        db.query(QuizAnswer.id)
        .filter(
            QuizAnswer.user_id == user.id,
            QuizAnswer.question_id == question_id,
            QuizAnswer.status.in_(("answered", "timeout")),
        )
        .first()
    )
    if answered is None:
        raise ValueError("请先完成该题作答后再查看解析")

    correct = _correct_labels(question)
    existing = (question.analysis or "").strip()
    base = {
        "question_id": question.id,
        "question": question.question,
        "options": question.options or [],
        "answer": correct,
    }
    if existing:
        return {**base, "analysis": existing, "source_type": "bank", "sources": []}

    cfg = ai_config_service.ensure_enabled(db)
    ai_usage_service.check_limits(db, cfg, user.id)

    rows = ai_knowledge_service.search_published(db, question.question, cfg.knowledge_top_k)
    references = ai_knowledge_service.format_context(rows)
    prompt_text = _join_blocks(
        _question_block(question, correct),
        f"[参考资料]\n{references}" if references else "",
        _output_hint(cfg),
    )
    try:
        result = llm_service.prompt_meta(
            prompt_text,
            system=ai_config_service.get_prompt(db, "quiz"),
            timeout=cfg.request_timeout,
            max_retries=cfg.max_retries,
            max_tokens=cfg.max_output_tokens,
        )
    except llm_service.LlmError:
        db.rollback()
        ai_usage_service.record(
            db, feature=FEATURE_QUIZ, user_id=user.id, model=settings.LLM_MODEL,
            status="error", error_code="llm",
        )
        db.commit()
        raise

    sources = ai_knowledge_service.format_sources(rows)
    ai_usage_service.record(
        db, feature=FEATURE_QUIZ, user_id=user.id, model=settings.LLM_MODEL,
        used_tokens=result.used_tokens, elapsed_ms=result.elapsed_ms, status="success",
    )
    db.commit()
    return {**base, "analysis": result.text, "source_type": "ai", "sources": sources}


def _correct_labels(question: Question) -> List[str]:
    """库内正确答案（label 数组），绝不采信客户端提交值。"""
    answer = question.answer or []
    if isinstance(answer, str):
        return [answer]
    return [str(a) for a in answer]


def _question_block(question: Question, correct: List[str]) -> str:
    """把题目、选项、正确答案拼成解析提示词段。"""
    lines = [f"题目：{question.question}"]
    for opt in question.options or []:
        if isinstance(opt, dict):
            lines.append(f"{opt.get('label', '')}. {opt.get('text', '')}")
        else:
            lines.append(str(opt))
    lines.append(f"【正确答案】{'、'.join(correct)}")
    return "[题目]\n" + "\n".join(lines)
