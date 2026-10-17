"""AI 智能中心管理端路由：知识库维护、题目工坊（持久化任务/草稿/导入）、配置中心。

契约面向 admin 前端（Vue3 + TS），字段 snake_case。安全约定：
- 每个接口都用 require_menu 在后端校验管理员菜单权限，不依赖前端隐藏按钮；
- 配置接口只读写 AI 运行参数与提示词，绝不返回任何明文密钥（CloudBase API Key 等）；
- 敏感/不可逆操作（知识增删改与发布、配置变更、题目导入）写 audit_logs，与业务同事务提交。
异常映射复用小程序 AI 路由的 ai_http_error（AiDisabled→403 / Limit→429 / CloudBase→502 / Value→400）。
"""
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import AdminPrincipal, require_menu
from app.api.routes.ai import ai_http_error, AI_ERRORS
from app.core.database import get_db
from app.models.models import AiKnowledge
from app.schemas.schemas import (
    AdminAiConfigOut,
    AdminAiConfigPatchRequest,
    AdminAiDraftListOut,
    AdminAiDraftOut,
    AdminAiDraftStatusRequest,
    AdminAiDraftUpdateRequest,
    AdminAiImportOut,
    AdminAiImportRequest,
    AdminAiJobCreateRequest,
    AdminAiJobListOut,
    AdminAiJobOut,
    AdminAiKnowledgeListOut,
    AdminAiKnowledgeOut,
    AdminAiKnowledgeStatusRequest,
    AdminAiKnowledgeUpsert,
    MessageOut,
)
from app.services import (
    ai_config_service,
    ai_knowledge_service,
    ai_question_service,
    audit_service,
)

router = APIRouter(prefix="/admin/ai", tags=["admin-ai"])

_PROMPT_KEYS = {"chat": "ai_prompt_chat", "route": "ai_prompt_route", "quiz": "ai_prompt_quiz"}


def _audit(db: Session, admin: AdminPrincipal, action: str, detail: Optional[Dict] = None) -> None:
    """写审计（不提交）：操作人超管为 (super, None)，微信关联管理员为 (user, user_id)。"""
    actor_type, actor_id = ("super", None) if admin.is_super else ("user", admin.user_id)
    audit_service.record(
        db, actor_type, actor_id, action, None, {"operator": admin.username, **(detail or {})}
    )


def _knowledge_out(r: AiKnowledge) -> Dict[str, Any]:
    """ORM → 契约 dict：本库空串按 NULL 存储，可空文本列读取时统一回退空值。"""
    return {
        "id": r.id,
        "title": r.title,
        "content": r.content,
        "source": r.source or "",
        "related": r.related or [],
        "category": r.category or "",
        "node_id": r.node_id,
        "status": r.status,
        "created_by": r.created_by or "",
        "reviewed_by": r.reviewed_by or "",
        "created_at": r.created_at,
        "updated_at": r.updated_at,
        "published_at": r.published_at,
    }


# ---------------- 知识库维护 ----------------
@router.get(
    "/knowledge",
    response_model=AdminAiKnowledgeListOut,
    summary="知识资料列表（分页）",
    dependencies=[Depends(require_menu("ai_knowledge"))],
)
def list_knowledge(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: str = Query("", max_length=64, description="按标题/正文模糊搜索"),
    status: str = Query("", max_length=16),
    category: str = Query("", max_length=20),
    node_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
):
    total, items = ai_knowledge_service.list_knowledge(
        db, page, page_size, keyword, status, category, node_id
    )
    return {"total": total, "items": [_knowledge_out(r) for r in items]}


@router.post(
    "/knowledge",
    response_model=AdminAiKnowledgeOut,
    summary="新增知识资料",
    dependencies=[Depends(require_menu("ai_knowledge"))],
)
def create_knowledge(
    payload: AdminAiKnowledgeUpsert,
    admin: AdminPrincipal = Depends(require_menu("ai_knowledge")),
    db: Session = Depends(get_db),
):
    try:
        row = ai_knowledge_service.create_knowledge(db, payload.model_dump(), admin.username)
        out = _knowledge_out(row)
        _audit(db, admin, "ai.knowledge.create", {"id": row.id, "status": row.status})
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return out


@router.get(
    "/knowledge/{kid}",
    response_model=AdminAiKnowledgeOut,
    summary="知识资料详情",
    dependencies=[Depends(require_menu("ai_knowledge"))],
)
def get_knowledge(kid: int, db: Session = Depends(get_db)):
    row = ai_knowledge_service.get_knowledge(db, kid)
    if row is None:
        raise HTTPException(status_code=404, detail="知识资料不存在")
    return _knowledge_out(row)


@router.put(
    "/knowledge/{kid}",
    response_model=AdminAiKnowledgeOut,
    summary="编辑知识资料",
    dependencies=[Depends(require_menu("ai_knowledge"))],
)
def update_knowledge(
    kid: int,
    payload: AdminAiKnowledgeUpsert,
    admin: AdminPrincipal = Depends(require_menu("ai_knowledge")),
    db: Session = Depends(get_db),
):
    try:
        row = ai_knowledge_service.update_knowledge(db, kid, payload.model_dump(), admin.username)
        out = _knowledge_out(row)
        _audit(db, admin, "ai.knowledge.update", {"id": kid, "status": row.status})
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return out


@router.patch(
    "/knowledge/{kid}/status",
    response_model=AdminAiKnowledgeOut,
    summary="知识资料状态流转（发布/驳回/归档）",
    dependencies=[Depends(require_menu("ai_knowledge"))],
)
def set_knowledge_status(
    kid: int,
    payload: AdminAiKnowledgeStatusRequest,
    admin: AdminPrincipal = Depends(require_menu("ai_knowledge")),
    db: Session = Depends(get_db),
):
    try:
        row = ai_knowledge_service.set_status(db, kid, payload.status, admin.username)
        out = _knowledge_out(row)
        _audit(db, admin, "ai.knowledge.status", {"id": kid, "status": payload.status})
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return out


@router.delete(
    "/knowledge/{kid}",
    response_model=MessageOut,
    summary="删除知识资料",
    dependencies=[Depends(require_menu("ai_knowledge"))],
)
def delete_knowledge(
    kid: int,
    admin: AdminPrincipal = Depends(require_menu("ai_knowledge")),
    db: Session = Depends(get_db),
):
    try:
        ai_knowledge_service.delete_knowledge(db, kid)
        _audit(db, admin, "ai.knowledge.delete", {"id": kid})
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return {"message": "已删除"}


# ---------------- 题目工坊（持久化任务 / 草稿 / 导入）----------------
@router.post(
    "/jobs",
    response_model=AdminAiJobOut,
    summary="发起出题任务（落库为持久化草稿）",
    dependencies=[Depends(require_menu("ai_workshop"))],
)
def run_job(
    payload: AdminAiJobCreateRequest,
    admin: AdminPrincipal = Depends(require_menu("ai_workshop")),
    db: Session = Depends(get_db),
):
    """生成并持久化任务与草稿；任务记录本身即操作留痕（含 created_by/params/时间）。"""
    try:
        return ai_question_service.run_job(
            db,
            admin.username,
            payload.topic,
            payload.count,
            payload.question_type,
            payload.difficulty,
            payload.category,
            payload.extra_requirements,
            payload.knowledge_ids,
        )
    except AI_ERRORS as exc:
        raise ai_http_error(exc)


@router.get(
    "/jobs",
    response_model=AdminAiJobListOut,
    summary="出题任务列表",
    dependencies=[Depends(require_menu("ai_workshop"))],
)
def list_jobs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    total, items = ai_question_service.list_jobs(db, page, page_size)
    return {"total": total, "items": items}


@router.get(
    "/jobs/{job_id}",
    response_model=AdminAiJobOut,
    summary="出题任务详情（含草稿）",
    dependencies=[Depends(require_menu("ai_workshop"))],
)
def get_job(job_id: int, db: Session = Depends(get_db)):
    try:
        return ai_question_service.get_job(db, job_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get(
    "/drafts",
    response_model=AdminAiDraftListOut,
    summary="题目草稿列表",
    dependencies=[Depends(require_menu("ai_workshop"))],
)
def list_drafts(
    job_id: Optional[int] = Query(None),
    status: str = Query("", max_length=16),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    total, items = ai_question_service.list_drafts(db, job_id, status, page, page_size)
    return {"total": total, "items": items}


@router.put(
    "/drafts/{draft_id}",
    response_model=AdminAiDraftOut,
    summary="编辑题目草稿",
    dependencies=[Depends(require_menu("ai_workshop"))],
)
def update_draft(
    draft_id: int,
    payload: AdminAiDraftUpdateRequest,
    admin: AdminPrincipal = Depends(require_menu("ai_workshop")),
    db: Session = Depends(get_db),
):
    try:
        view = ai_question_service.update_draft(db, draft_id, payload.data, admin.username)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return view


@router.patch(
    "/drafts/{draft_id}/status",
    response_model=AdminAiDraftOut,
    summary="审核题目草稿（通过/驳回）",
    dependencies=[Depends(require_menu("ai_workshop"))],
)
def set_draft_status(
    draft_id: int,
    payload: AdminAiDraftStatusRequest,
    admin: AdminPrincipal = Depends(require_menu("ai_workshop")),
    db: Session = Depends(get_db),
):
    try:
        view = ai_question_service.set_draft_status(db, draft_id, payload.status, admin.username)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return view


@router.post(
    "/drafts/import",
    response_model=AdminAiImportOut,
    summary="幂等导入审核通过的草稿到题库",
    dependencies=[Depends(require_menu("ai_workshop"))],
)
def import_drafts(
    payload: AdminAiImportRequest,
    admin: AdminPrincipal = Depends(require_menu("ai_workshop")),
    db: Session = Depends(get_db),
):
    try:
        result = ai_question_service.import_drafts(db, payload.draft_ids, admin.username)
        _audit(
            db,
            admin,
            "ai.draft.import",
            {"imported": result["imported"], "skipped": result["skipped"], "failed": result["failed"]},
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return result


# ---------------- 配置中心 ----------------
@router.get(
    "/config",
    response_model=AdminAiConfigOut,
    summary="读取 AI 配置（生效值/默认/范围/提示词，不含密钥）",
    dependencies=[Depends(require_menu("ai_config"))],
)
def get_config(db: Session = Depends(get_db)):
    return ai_config_service.get_config_view(db)


@router.patch(
    "/config",
    response_model=AdminAiConfigOut,
    summary="更新 AI 配置（运行参数/提示词/版本号）",
    dependencies=[Depends(require_menu("ai_config"))],
)
def patch_config(
    payload: AdminAiConfigPatchRequest,
    admin: AdminPrincipal = Depends(require_menu("ai_config")),
    db: Session = Depends(get_db),
):
    updates: Dict[str, Any] = {}
    if payload.values is not None:
        for key, value in payload.values.model_dump(exclude_none=True).items():
            updates[f"ai_{key}"] = value
    if payload.prompts:
        for kind, text in payload.prompts.items():
            if kind not in _PROMPT_KEYS:
                raise HTTPException(status_code=400, detail=f"未知提示词类型：{kind}")
            updates[_PROMPT_KEYS[kind]] = text
    if payload.prompt_version is not None:
        updates["ai_prompt_version"] = payload.prompt_version
    try:
        view = ai_config_service.patch_config(db, updates)
        _audit(db, admin, "ai.config.patch", {"keys": sorted(updates.keys())})
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return view
