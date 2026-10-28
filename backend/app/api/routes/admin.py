"""管理后台路由：管理员登录、扫码登录、题库维护、组织架构维护与同步。

除 POST /api/admin/login 与扫码登录相关接口外，全部接口依赖 get_current_admin
（超管令牌或微信关联管理员令牌，后者每次请求查库校验授权）。
契约面向根目录 admin 前端项目（Vue3 + TS），字段为 snake_case，独立于小程序 camelCase 契约。
"""
from datetime import datetime
from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import AdminPrincipal, get_current_admin, require_menu
from app.core import rate_limit
from app.core import ws as ws_manager
from app.core.config import settings
from app.core.database import get_db
from app.core.helpers import today_str
from app.core.security import create_admin_token, create_admin_token_for_user
from app.models.models import User
from app.schemas.schemas import (
    AdminActivityListOut,
    AdminActivityPublishRequest,
    AdminActivitySettingOut,
    AdminActivitySettingUpdate,
    AdminAiBatchSaveOut,
    AdminAiBatchSaveRequest,
    AdminAiGenerateOut,
    AdminAiGenerateRequest,
    AdminAuditLogListOut,
    AdminDashboardOut,
    AdminChapterListOut,
    AdminChapterOut,
    AdminChapterReorder,
    AdminChapterUpsert,
    AdminMedalListOut,
    AdminMedalOut,
    AdminMedalUpsert,
    AdminPersonListOut,
    AdminPersonOut,
    AdminPersonUpsert,
    AdminUploadUrlOut,
    AdminLoginOut,
    AdminLoginRequest,
    AdminMeOut,
    AdminMenuOut,
    AdminOperationConfigOut,
    AdminOperationConfigPatchRequest,
    AdminInviteCreate,
    AdminInviteListOut,
    AdminInviteOut,
    AdminInviteQrOut,
    AdminInviteUpdate,
    AdminOrgNodeOut,
    AdminOrgUserListOut,
    AdminPointsVerifyOut,
    AdminPointsVerifyRequest,
    AdminOrgCompareOut,
    AdminInviteFunnelOut,
    AdminSyncFailuresOut,
    AdminQrCreateOut,
    AdminQrStatusOut,
    AdminRankListOut,
    AdminOrgSyncOut,
    AdminOrgTreeOut,
    AdminOrgUpsert,
    AdminImportConfirmOut,
    AdminImportConfirmRequest,
    AdminImportPreviewOut,
    AdminPasteImportOut,
    AdminPasteImportRequest,
    AdminQuestionScoreBatchOut,
    AdminQuestionScoreBatchRequest,
    AdminQuestionListOut,
    AdminQuestionOut,
    AdminQuestionUpsert,
    AdminQuoteCycleOut,
    AdminQuoteCycleUpdate,
    AdminQuoteListOut,
    AdminQuoteOut,
    AdminQuoteUpsert,
    AdminRoleEnabledRequest,
    AdminRoleListOut,
    AdminRoleOut,
    AdminRoleUpsert,
    AdminRouteNodeEnabled,
    AdminRouteNodeListOut,
    AdminRouteNodeOut,
    AdminRouteNodeUpsert,
    AdminScreenOut,
    AdminTrendOut,
    AdminUserListOut,
    AdminUserOrgRequest,
    AdminUserOverviewOut,
    AdminUserRolesRequest,
    AdminUserStatusRequest,
    MessageOut,
)
from app.services import (
    access_service,
    activity_service,
    admin_service,
    ai_question_service,
    audit_service,
    llm_service,
    dashboard_service,
    identity_service,
    import_service,
    invite_service,
    org_service,
    operation_config_service,
    points_service,
    quote_service,
    upload_service,
    wechat_service,
)

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/login", response_model=AdminLoginOut, summary="管理后台登录")
def login(payload: AdminLoginRequest, request: Request):
    """校验管理员账号密码（配置 ADMIN_USERNAME/ADMIN_PASSWORD），签发超管令牌。

    未配置 ADMIN_PASSWORD 时账号登录禁用（不硬编码默认密码），仅允许微信扫码登录。
    """
    rate_limit.require_rate(rate_limit.login_limiter, request, "登录尝试过于频繁，请稍后再试")
    if not settings.ADMIN_PASSWORD:
        raise HTTPException(status_code=403, detail="未配置管理账号密码，请使用微信扫码登录")
    if (
        payload.username != settings.ADMIN_USERNAME
        or payload.password != settings.ADMIN_PASSWORD
    ):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    return {"token": create_admin_token(payload.username), "username": payload.username}


# ---------------- 微信扫码登录 ----------------
@router.post(
    "/wechat/qr",
    response_model=AdminQrCreateOut,
    summary="创建微信扫码登录会话（返回小程序码）",
)
def create_wechat_qr(request: Request, db: Session = Depends(get_db)):
    """生成 qrId + scene 凭证并调用微信接口出小程序码。

    mock 模式（未配置 WX 凭证或调用失败）：image 为 None，返回 scene 明文供开发调试。
    """
    rate_limit.require_rate(rate_limit.qr_create_limiter, request, "操作过于频繁，请稍后再试")
    session, scene_token = identity_service.create_login_session(db)
    png = wechat_service.get_wxacode_png(scene_token)
    mock = png is None
    return {
        "qr_id": session.id,
        "image": None if mock else wechat_service.to_data_url(png),
        "scene": scene_token if mock else None,
        "mock": mock,
        "expires_in": settings.QR_LOGIN_TTL_SECONDS,
    }


@router.get(
    "/wechat/qr/{qr_id}/status",
    response_model=AdminQrStatusOut,
    summary="轮询扫码登录状态",
)
def poll_wechat_qr(qr_id: str, request: Request, db: Session = Depends(get_db)):
    """confirmed 时签发微信关联管理员令牌（单次签发，防重放）；未授权时 failed 带原因。"""
    rate_limit.require_rate(rate_limit.qr_poll_limiter, request, "轮询过于频繁，请稍后再试")
    session = identity_service.poll_login_session(db, qr_id)
    if session is None:
        raise HTTPException(status_code=404, detail="扫码会话不存在")
    expires_in = max(0, int((session.expires_at - datetime.utcnow()).total_seconds()))
    if session.status == "confirmed":
        issued = identity_service.issue_admin_token(db, qr_id)
        if issued is not None:
            _, user = issued
            principal = access_service.build_principal(db, user) or {
                "username": user.nickname,
                "menus": [],
            }
            menus = access_service.get_menu_items(db, principal["menus"])
            return {
                "status": session.status,
                "expires_in": expires_in,
                "token": create_admin_token_for_user(user.id),
                "username": user.nickname,
                "is_super": False,
                "menus": menus,
            }
    return {
        "status": session.status,
        "fail_reason": session.fail_reason,
        "expires_in": expires_in,
    }


@router.get("/me", response_model=AdminMeOut, summary="当前管理员信息与菜单权限")
def admin_me(
    admin: AdminPrincipal = Depends(get_current_admin), db: Session = Depends(get_db)
):
    """前端登录后据此渲染菜单；超管返回全部菜单，微信关联管理员返回角色菜单并集。"""
    if admin.is_super:
        return {
            "username": admin.username,
            "is_super": True,
            "menus": access_service.get_all_menu_items(db),
            "roles": [],
        }
    return {
        "username": admin.username,
        "is_super": False,
        "menus": access_service.get_menu_items(db, admin.menus),
        "roles": admin.roles,
    }


# ---------------- 驾驶舱 / 数据大屏 ----------------
@router.get(
    "/dashboard",
    response_model=AdminDashboardOut,
    summary="驾驶舱聚合（核心指标 + 路线总览）",
    dependencies=[Depends(require_menu("dashboard"))],
)
def dashboard(db: Session = Depends(get_db)):
    return dashboard_service.get_dashboard(db)


@router.get(
    "/dashboard/trend",
    response_model=AdminTrendOut,
    summary="运动趋势（近 N 日）",
    dependencies=[Depends(require_menu("dashboard"))],
)
def dashboard_trend(
    days: int = Query(7, ge=1, le=90), db: Session = Depends(get_db)
):
    return dashboard_service.get_trend(db, days)


@router.get(
    "/activities",
    response_model=AdminActivityListOut,
    summary="实时动态（user_event 关联昵称，倒序）",
    dependencies=[Depends(require_menu("dashboard"))],
)
def activities(
    limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)
):
    return {"items": dashboard_service.get_activities(db, limit)}


@router.get(
    "/screen",
    response_model=AdminScreenOut,
    summary="数据大屏聚合（指标 + 路线总览 + 7 日趋势 + 动态）",
    dependencies=[Depends(require_menu("screen"))],
)
def screen(db: Session = Depends(get_db)):
    return dashboard_service.get_screen(db)


# ---------------- 数据运营分析（点13） ----------------
@router.get(
    "/analytics/orgs",
    response_model=AdminOrgCompareOut,
    summary="组织横向对比（成员/步数/活跃/点亮/人均积分）",
    dependencies=[Depends(require_menu("analytics"))],
)
def analytics_orgs(
    org_id: Optional[int] = Query(None, alias="orgId"),
    db: Session = Depends(get_db),
):
    """按组织维度横向对比运营指标；传 orgId 时统计其子树内各组织，否则统计全部。"""
    org_ids = org_service.subtree_org_ids(db, org_id) if org_id is not None else None
    return dashboard_service.get_org_compare(db, org_ids)


@router.get(
    "/analytics/invite-funnel",
    response_model=AdminInviteFunnelOut,
    summary="邀请漏斗（扫码→入驻→首登→首次同步，按邀请码分组）",
    dependencies=[Depends(require_menu("analytics"))],
)
def analytics_invite_funnel(db: Session = Depends(get_db)):
    return dashboard_service.get_invite_funnel(db)


@router.get(
    "/analytics/sync-failures",
    response_model=AdminSyncFailuresOut,
    summary="近 N 日步数同步失败清单（只读感知）",
    dependencies=[Depends(require_menu("analytics"))],
)
def analytics_sync_failures(
    days: int = Query(7, ge=1, le=90), db: Session = Depends(get_db)
):
    return dashboard_service.get_sync_failures(db, days)


@router.get(
    "/analytics/points-health",
    response_model=AdminPointsVerifyOut,
    summary="积分台账健康度（dry-run 全量核对，不修复）",
    dependencies=[Depends(require_menu("analytics"))],
)
def analytics_points_health(db: Session = Depends(get_db)):
    return dashboard_service.get_points_health(db)


# ---------------- 路线节点维护 ----------------
@router.get(
    "/route-nodes",
    response_model=AdminRouteNodeListOut,
    summary="路线节点列表",
    dependencies=[Depends(require_menu("route_nodes"))],
)
def list_route_nodes(db: Session = Depends(get_db)):
    items = admin_service.list_route_nodes(db)
    return {"total": len(items), "items": items}


@router.post(
    "/route-nodes",
    response_model=AdminRouteNodeOut,
    summary="新增路线节点",
    dependencies=[Depends(require_menu("route_nodes"))],
)
def create_route_node(
    payload: AdminRouteNodeUpsert, db: Session = Depends(get_db)
):
    try:
        return admin_service.create_route_node(db, payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put(
    "/route-nodes/{node_id}",
    response_model=AdminRouteNodeOut,
    summary="编辑路线节点",
    dependencies=[Depends(require_menu("route_nodes"))],
)
def update_route_node(
    node_id: int,
    payload: AdminRouteNodeUpsert,
    db: Session = Depends(get_db),
):
    try:
        node = admin_service.update_route_node(db, node_id, payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if node is None:
        raise HTTPException(status_code=404, detail="路线节点不存在")
    return node


@router.patch(
    "/route-nodes/{node_id}/enabled",
    response_model=AdminRouteNodeOut,
    summary="启用或停用路线节点",
    dependencies=[Depends(require_menu("route_nodes"))],
)
def set_route_node_enabled(
    node_id: int,
    payload: AdminRouteNodeEnabled,
    db: Session = Depends(get_db),
):
    try:
        node = admin_service.set_route_node_enabled(
            db, node_id, payload.is_enabled
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if node is None:
        raise HTTPException(status_code=404, detail="路线节点不存在")
    return node


@router.get(
    "/rankings",
    response_model=AdminRankListOut,
    summary="全员排名与节点到达时间（服务端分页/筛选）",
    dependencies=[Depends(require_menu("rankings"))],
)
def rankings(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    keyword: str = Query("", max_length=64),
    org_id: Optional[int] = Query(None),
    only_changed: bool = Query(False),
    db: Session = Depends(get_db),
):
    return admin_service.get_rank_overview(db, page, page_size, keyword, org_id, only_changed)


@router.post("/points/verify", response_model=AdminPointsVerifyOut, summary="积分台账核对 / 重算")
def verify_points(
    payload: AdminPointsVerifyRequest,
    admin: AdminPrincipal = Depends(require_menu("rankings")),
    db: Session = Depends(get_db),
):
    """按源数据（每日步数 / 答题记录）核对积分台账；fix=True 时修复差异并写审计。"""
    result = points_service.recompute_all(db, fix=payload.fix, user_ids=payload.user_ids)
    if payload.fix:
        actor_type, actor_id = _actor(admin)
        audit_service.record(
            db, actor_type, actor_id, "points.recompute", None,
            {"operator": admin.username, **{k: result[k] for k in ("users", "checked_days", "fixed")}},
        )
        db.commit()
        # #6：修复后台账已变，失效健康度缓存，避免驾驶舱仍读到旧的 dry-run 结果。
        dashboard_service.invalidate_points_health_cache()
    return result


@router.get(
    "/rankings/export",
    summary="按筛选条件流式导出排名 CSV",
    dependencies=[Depends(require_menu("rankings"))],
)
def export_rankings(
    keyword: str = Query("", max_length=64),
    org_id: Optional[int] = Query(None),
    only_changed: bool = Query(False),
):
    filename = quote(f"全员长征排名_{datetime.now().strftime('%Y-%m-%d')}.csv")
    return StreamingResponse(
        admin_service.iter_rank_csv(keyword, org_id, only_changed),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


@router.get(
    "/users/{user_id}/overview",
    response_model=AdminUserOverviewOut,
    summary="人员详情聚合（运动/答题/勋章/长征/积分）",
    dependencies=[Depends(require_menu("rankings"))],
)
def user_overview(user_id: int, db: Session = Depends(get_db)):
    """排名洞察点击人员后展示其全部业务数据；用户不存在返回 404。"""
    overview = admin_service.get_user_overview(db, user_id)
    if overview is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    return overview


# ---------------- 题库维护 ----------------
@router.get(
    "/questions",
    response_model=AdminQuestionListOut,
    summary="题目列表（分页/筛选）",
    dependencies=[Depends(require_menu("questions"))],
)
def list_questions(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: str = Query(""),
    qtype: str = Query(""),
    category: str = Query(""),
    db: Session = Depends(get_db),
):
    total, items = admin_service.list_questions(db, page, page_size, keyword, qtype, category)
    return {"total": total, "items": items}


@router.post(
    "/questions",
    response_model=AdminQuestionOut,
    summary="新增题目",
    dependencies=[Depends(require_menu("questions"))],
)
def create_question(payload: AdminQuestionUpsert, db: Session = Depends(get_db)):
    try:
        return admin_service.create_question(db, payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _xlsx_response(content: bytes, filename: str) -> Response:
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


def _read_import_file(file: UploadFile) -> bytes:
    """校验上传文件类型与大小，返回文件内容。"""
    if not (file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="仅支持 .xlsx 文件，请使用下载的模板")
    content = file.file.read(import_service.MAX_FILE_SIZE + 1)
    if len(content) > import_service.MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="文件大小超过 2MB 限制")
    return content


@router.get(
    "/questions/import-template",
    summary="下载题库导入模板（Excel）",
    dependencies=[Depends(require_menu("questions"))],
)
def download_question_import_template():
    return _xlsx_response(import_service.build_question_template(), "长征步迹_题库导入模板.xlsx")


@router.post(
    "/questions/import-preview",
    response_model=AdminImportPreviewOut,
    summary="题库导入预览（上传 Excel 整批校验）",
)
def preview_question_import(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("questions")),
):
    content = _read_import_file(file)
    try:
        return import_service.preview_question_import(db, content, admin.username)
    except import_service.ImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post(
    "/questions/import-confirm",
    response_model=AdminImportConfirmOut,
    summary="确认题库导入（事务写入，令牌一次性）",
    dependencies=[Depends(require_menu("questions"))],
)
def confirm_question_import(payload: AdminImportConfirmRequest, db: Session = Depends(get_db)):
    try:
        imported = import_service.confirm_question_import(db, payload.preview_token)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"imported": imported}


@router.post(
    "/questions/paste-import",
    response_model=AdminPasteImportOut,
    summary="复制导入题目（一次最多 500 道，默认 20 分）",
    dependencies=[Depends(require_menu("questions"))],
)
def paste_import_questions(payload: AdminPasteImportRequest, db: Session = Depends(get_db)):
    try:
        return import_service.paste_import_questions(
            db, [item.model_dump() for item in payload.questions]
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post(
    "/questions/batch-score",
    response_model=AdminQuestionScoreBatchOut,
    summary="批量设置题目分值",
    dependencies=[Depends(require_menu("questions"))],
)
def update_questions_score(payload: AdminQuestionScoreBatchRequest, db: Session = Depends(get_db)):
    try:
        updated = import_service.update_questions_score(db, payload.ids, payload.score)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"updated": updated}


@router.put(
    "/questions/{question_id}",
    response_model=AdminQuestionOut,
    summary="编辑题目",
    dependencies=[Depends(require_menu("questions"))],
)
def update_question(
    question_id: int, payload: AdminQuestionUpsert, db: Session = Depends(get_db)
):
    try:
        question = admin_service.update_question(db, question_id, payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if question is None:
        raise HTTPException(status_code=404, detail="题目不存在")
    return question


@router.delete(
    "/questions/{question_id}",
    response_model=MessageOut,
    summary="删除题目",
    dependencies=[Depends(require_menu("questions"))],
)
def delete_question(question_id: int, db: Session = Depends(get_db)):
    admin_service.delete_question(db, question_id)
    return {"message": "已删除"}


# ---------------- AI 智能出题 ----------------
# 生成结果一律作为草稿返回，必须由管理员在预览列表确认后调 batch-save 才入库。
@router.post(
    "/ai/generate-questions",
    response_model=AdminAiGenerateOut,
    summary="AI 生成题目草稿（不入库）",
    dependencies=[Depends(require_menu("questions"))],
)
def ai_generate_questions(payload: AdminAiGenerateRequest, db: Session = Depends(get_db)):
    try:
        return ai_question_service.generate_questions(
            db,
            payload.topic,
            payload.count,
            payload.question_type,
            payload.difficulty,
            payload.category,
            payload.extra_requirements,
        )
    except llm_service.LlmError as exc:
        # 先于 ValueError 捕获：LlmError 继承 ValueError，但属上游故障应返回 502
        raise HTTPException(status_code=502, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post(
    "/ai/questions/batch-save",
    response_model=AdminAiBatchSaveOut,
    summary="批量保存审核通过的 AI 题目",
    dependencies=[Depends(require_menu("questions"))],
)
def ai_batch_save_questions(
    payload: AdminAiBatchSaveRequest, db: Session = Depends(get_db)
):
    try:
        return ai_question_service.batch_save_questions(
            db, [item.model_dump() for item in payload.questions]
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------- 每日寄语维护（需求 §16、V1.1 功能二）----------------
@router.get(
    "/quotes",
    response_model=AdminQuoteListOut,
    summary="寄语列表（分页，按循环顺序）",
    dependencies=[Depends(require_menu("quotes"))],
)
def list_quotes(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: str = Query("", max_length=64, description="按内容/出处模糊搜索"),
    db: Session = Depends(get_db),
):
    total, items = quote_service.list_quotes(db, page, page_size, keyword)
    return {"total": total, "items": items}


@router.get(
    "/quotes/cycle",
    response_model=AdminQuoteCycleOut,
    summary="寄语循环概览（起始日期、启用条数、今日寄语）",
    dependencies=[Depends(require_menu("quotes"))],
)
def get_quote_cycle(db: Session = Depends(get_db)):
    return quote_service.get_cycle_info(db, today_str())


@router.put(
    "/quotes/cycle",
    response_model=AdminQuoteCycleOut,
    summary="修改寄语循环起始日期",
    dependencies=[Depends(require_menu("quotes"))],
)
def update_quote_cycle(payload: AdminQuoteCycleUpdate, db: Session = Depends(get_db)):
    try:
        quote_service.set_cycle_start(db, payload.start_date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return quote_service.get_cycle_info(db, today_str())


@router.get(
    "/quotes/import-template",
    summary="下载每日寄语导入模板（Excel）",
    dependencies=[Depends(require_menu("quotes"))],
)
def download_quote_import_template():
    return _xlsx_response(import_service.build_quote_template(), "长征步迹_每日寄语导入模板.xlsx")


@router.post(
    "/quotes/import-preview",
    response_model=AdminImportPreviewOut,
    summary="寄语导入预览（上传 Excel 整批校验）",
)
def preview_quote_import(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("quotes")),
):
    content = _read_import_file(file)
    try:
        return import_service.preview_quote_import(db, content, admin.username)
    except import_service.ImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post(
    "/quotes/import-confirm",
    response_model=AdminImportConfirmOut,
    summary="确认寄语导入（事务写入，令牌一次性）",
    dependencies=[Depends(require_menu("quotes"))],
)
def confirm_quote_import(payload: AdminImportConfirmRequest, db: Session = Depends(get_db)):
    try:
        imported = import_service.confirm_quote_import(db, payload.preview_token)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"imported": imported}


@router.post(
    "/quotes",
    response_model=AdminQuoteOut,
    summary="新增寄语",
    dependencies=[Depends(require_menu("quotes"))],
)
def create_quote(payload: AdminQuoteUpsert, db: Session = Depends(get_db)):
    data = payload.model_dump()
    error = quote_service.validate_quote(db, data["content"], data["source"], data["sort_order"], data["node_id"])
    if error:
        raise HTTPException(status_code=400, detail=error)
    return quote_service.get_admin_out(db, quote_service.create_quote(db, data))


@router.put(
    "/quotes/{quote_id}",
    response_model=AdminQuoteOut,
    summary="编辑寄语",
    dependencies=[Depends(require_menu("quotes"))],
)
def update_quote(quote_id: int, payload: AdminQuoteUpsert, db: Session = Depends(get_db)):
    data = payload.model_dump()
    error = quote_service.validate_quote(db, data["content"], data["source"], data["sort_order"], data["node_id"])
    if error:
        raise HTTPException(status_code=400, detail=error)
    row = quote_service.update_quote(db, quote_id, data)
    if row is None:
        raise HTTPException(status_code=404, detail="寄语不存在")
    return quote_service.get_admin_out(db, row)


@router.delete(
    "/quotes/{quote_id}",
    response_model=MessageOut,
    summary="删除寄语",
    dependencies=[Depends(require_menu("quotes"))],
)
def delete_quote(quote_id: int, db: Session = Depends(get_db)):
    if not quote_service.delete_quote(db, quote_id):
        raise HTTPException(status_code=404, detail="寄语不存在")
    return {"message": "已删除"}


# ---------------- 组织架构维护 ----------------
@router.get(
    "/orgs",
    response_model=AdminOrgTreeOut,
    summary="组织架构树",
    dependencies=[Depends(require_menu("orgs"))],
)
def org_tree(db: Session = Depends(get_db)):
    return admin_service.get_org_tree(db)


@router.get(
    "/orgs/{org_id}/users",
    response_model=AdminOrgUserListOut,
    summary="组织人员明细（直属或含全部下级，分页）",
    dependencies=[Depends(require_menu("orgs"))],
)
def org_users(
    org_id: int,
    scope: str = Query("direct", pattern="^(direct|all)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """scope=direct 仅直属成员（与 direct_user_count 同口径）；scope=all 含全部层级下级（与 total_user_count 同口径）。"""
    result = admin_service.get_org_users(db, org_id, scope, page, page_size)
    if result is None:
        raise HTTPException(status_code=404, detail="组织不存在")
    return result


@router.post(
    "/orgs",
    response_model=AdminOrgNodeOut,
    summary="新增组织",
    dependencies=[Depends(require_menu("orgs"))],
)
def create_org(payload: AdminOrgUpsert, db: Session = Depends(get_db)):
    try:
        return admin_service.create_org(db, payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put(
    "/orgs/{org_id}",
    response_model=AdminOrgNodeOut,
    summary="编辑组织",
    dependencies=[Depends(require_menu("orgs"))],
)
def update_org(org_id: int, payload: AdminOrgUpsert, db: Session = Depends(get_db)):
    try:
        org = admin_service.update_org(db, org_id, payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if org is None:
        raise HTTPException(status_code=404, detail="组织不存在")
    return org


@router.delete(
    "/orgs/{org_id}",
    summary="删除组织（含子树）",
    dependencies=[Depends(require_menu("orgs"))],
)
def delete_org(org_id: int, db: Session = Depends(get_db)) -> MessageOut:
    kept: List[int] = admin_service.delete_org(db, org_id)
    if kept:
        return {"message": f"部分节点仍被用户引用已保留：{kept}"}
    return {"message": "已删除"}


@router.post(
    "/orgs/sync",
    response_model=AdminOrgSyncOut,
    summary="从外部系统同步组织架构",
    dependencies=[Depends(require_menu("orgs"))],
)
def sync_orgs(db: Session = Depends(get_db)):
    """全量对齐外部组织架构；未配置 ORG_SYNC_API_URL 时降级使用内置种子数据。"""
    try:
        return admin_service.sync_orgs(db)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


# ---------------- 人员授权 / 角色管理 / 审计日志 ----------------
def _actor(admin: AdminPrincipal):
    """审计操作人：超管为 (super, None)，微信关联管理员为 (user, user_id)。"""
    return ("super", None) if admin.is_super else ("user", admin.user_id)


@router.get(
    "/users",
    response_model=AdminUserListOut,
    summary="人员分页列表（含角色与后台授权状态）",
)
def list_admin_users(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: str = Query("", max_length=64),
    org_id: Optional[int] = Query(None),
    has_access: Optional[bool] = Query(None),
    status: str = Query("", pattern="^(|active|disabled)$"),
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("access")),
):
    total, items = access_service.list_users(
        db, page, page_size, keyword, org_id, has_access, status
    )
    return {"total": total, "items": items}


@router.patch(
    "/users/{user_id}/status",
    response_model=MessageOut,
    summary="启用或停用用户（停用后小程序与后台即时断权）",
)
def set_user_status(
    user_id: int,
    payload: AdminUserStatusRequest,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("access")),
):
    if not admin.is_super and admin.user_id == user_id:
        raise HTTPException(status_code=400, detail="不能修改自己的账号状态")
    try:
        actor_type, actor_id = _actor(admin)
        invite_service.set_user_status(db, user_id, payload.status, actor_type, actor_id)
    except ValueError as exc:
        status_code = 404 if str(exc) == "用户不存在" else 400
        raise HTTPException(status_code=status_code, detail=str(exc))
    return {"message": "已更新"}


@router.put(
    "/users/{user_id}/org",
    response_model=MessageOut,
    summary="调整用户所属组织（用户侧已锁定，仅管理员可改，写审计）",
)
def set_user_org(
    user_id: int,
    payload: AdminUserOrgRequest,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("access")),
):
    actor_type, actor_id = _actor(admin)
    try:
        changed = org_service.admin_set_user_org(
            db, user_id, payload.org_id, admin.username, actor_type, actor_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    if changed:
        ws_manager.broadcast(ws_manager.build_event("org.select", user_id))
    return {"message": "已更新" if changed else "组织未变化"}


# ---------------- 入驻邀请码 ----------------
@router.get(
    "/invites",
    response_model=AdminInviteListOut,
    summary="入驻邀请码分页列表",
)
def list_invites(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: str = Query("", max_length=64),
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("invites")),
):
    total, items = invite_service.list_invites(db, page, page_size, keyword)
    return {"total": total, "items": items}


@router.post(
    "/invites",
    response_model=AdminInviteOut,
    summary="生成入驻邀请码（可限组织、有效期、使用次数）",
)
def create_invite(
    payload: AdminInviteCreate,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("invites")),
):
    try:
        actor_type, actor_id = _actor(admin)
        return invite_service.create_invite(
            db, payload.model_dump(), actor_type, actor_id, admin.username
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.patch(
    "/invites/{invite_id}",
    response_model=AdminInviteOut,
    summary="编辑/启停入驻邀请码（部分更新）",
)
def update_invite(
    invite_id: int,
    payload: AdminInviteUpdate,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("invites")),
):
    fields = payload.model_dump(exclude_unset=True)
    if any(fields.get(key, "") is None for key in ("name", "is_enabled")):
        raise HTTPException(status_code=400, detail="名称与启用状态不能为空")
    try:
        actor_type, actor_id = _actor(admin)
        return invite_service.update_invite(db, invite_id, fields, actor_type, actor_id)
    except ValueError as exc:
        status_code = 404 if str(exc) == "邀请码不存在" else 400
        raise HTTPException(status_code=status_code, detail=str(exc))


@router.get(
    "/invites/{invite_id}/qrcode",
    response_model=AdminInviteQrOut,
    summary="邀请码小程序码（扫码进入启动页入驻）",
)
def get_invite_qrcode(
    invite_id: int,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("invites")),
):
    """码内仅含启动页路径与 scene=i=<邀请码>，不含 OpenID、Token 或个人信息。"""
    try:
        invite = invite_service.get_invite(db, invite_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    scene = invite_service.scene_of(invite.code)
    image = wechat_service.get_invite_image(scene)
    return {
        "image": None if image is None else wechat_service.to_data_url(image),
        "page": wechat_service.ONBOARD_PAGE,
        "scene": scene,
        "env_version": settings.WXACODE_ENV_VERSION,
        "mock": image is None,
    }


@router.get(
    "/roles",
    response_model=AdminRoleListOut,
    summary="角色列表（含菜单码与授权用户数）",
)
def list_roles(
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("access")),
):
    return {"items": access_service.list_roles(db)}


@router.post(
    "/roles",
    response_model=AdminRoleOut,
    summary="新建角色",
)
def create_role(
    payload: AdminRoleUpsert,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("access")),
):
    try:
        actor_type, actor_id = _actor(admin)
        return access_service.create_role(
            db, payload.name, payload.menus, actor_type, actor_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put(
    "/roles/{role_id}",
    response_model=AdminRoleOut,
    summary="编辑角色（名称 + 全量覆盖菜单）",
)
def update_role(
    role_id: int,
    payload: AdminRoleUpsert,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("access")),
):
    try:
        actor_type, actor_id = _actor(admin)
        return access_service.update_role(
            db, role_id, payload.name, payload.menus, actor_type, actor_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete(
    "/roles/{role_id}",
    response_model=MessageOut,
    summary="删除角色",
)
def delete_role(
    role_id: int,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("access")),
):
    try:
        actor_type, actor_id = _actor(admin)
        access_service.delete_role(db, role_id, actor_type, actor_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"message": "已删除"}


@router.post(
    "/users/{user_id}/roles",
    response_model=MessageOut,
    summary="全量覆盖用户角色授权（新增/移除/重新启用）",
)
def grant_user_roles(
    user_id: int,
    payload: AdminUserRolesRequest,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("access")),
):
    try:
        actor_type, actor_id = _actor(admin)
        access_service.grant_roles(
            db, user_id, payload.role_ids, actor_type, actor_id, admin.username
        )
    except ValueError as exc:
        status_code = 404 if str(exc) == "用户不存在" else 400
        raise HTTPException(status_code=status_code, detail=str(exc))
    return {"message": "已更新授权"}


@router.patch(
    "/users/{user_id}/roles/{role_id}/enabled",
    response_model=MessageOut,
    summary="启用或禁用用户角色（禁用即时生效）",
)
def set_user_role_enabled(
    user_id: int,
    role_id: int,
    payload: AdminRoleEnabledRequest,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("access")),
):
    try:
        actor_type, actor_id = _actor(admin)
        access_service.set_role_enabled(
            db, user_id, role_id, payload.is_enabled, actor_type, actor_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"message": "已更新"}


@router.get(
    "/audit-logs",
    response_model=AdminAuditLogListOut,
    summary="审计日志（分页 + 日期/动作/操作人筛选）",
)
def audit_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    action: str = Query("", max_length=64),
    actor_type: str = Query("", pattern="^(|super|user)$"),
    date: str = Query("", pattern="^(|\\d{4}-\\d{2}-\\d{2})$"),
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("audit")),
):
    total, items = access_service.list_audit_logs(
        db, page, page_size, action, actor_type, date
    )
    return {"total": total, "items": items}


# ---------------- 活动设置（V2.0 需求一） ----------------
@router.get(
    "/activity",
    response_model=AdminActivitySettingOut,
    summary="活动设置与当前状态",
)
def get_activity(
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("activity")),
):
    return activity_service.get_admin_view(db)


@router.put(
    "/activity",
    response_model=AdminActivitySettingOut,
    summary="保存活动设置（即时生效，写审计）",
)
def save_activity(
    payload: AdminActivitySettingUpdate,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("activity")),
):
    actor_type, actor_id = _actor(admin)
    try:
        return activity_service.update(
            db, payload.model_dump(), admin.username, actor_type, actor_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post(
    "/activity/publish",
    response_model=AdminActivitySettingOut,
    summary="发布或撤回活动（即时生效，写审计）",
)
def publish_activity(
    payload: AdminActivityPublishRequest,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("activity")),
):
    actor_type, actor_id = _actor(admin)
    try:
        return activity_service.set_published(
            db, payload.published, admin.username, actor_type, actor_id
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------- 运营参数配置（工作流 A2） ----------------
@router.get(
    "/operation-config",
    response_model=AdminOperationConfigOut,
    summary="读取运营参数（生效值/默认/范围/已覆盖项）",
)
def get_operation_config(
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("operation_config")),
):
    return operation_config_service.get_config_view(db)


@router.put(
    "/operation-config",
    response_model=AdminOperationConfigOut,
    summary="保存运营参数（即时生效，写审计）",
)
def save_operation_config(
    payload: AdminOperationConfigPatchRequest,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("operation_config")),
):
    updates = (
        payload.values.model_dump(exclude_none=True) if payload.values is not None else {}
    )
    try:
        view = operation_config_service.patch_config(db, updates)
        actor_type, actor_id = _actor(admin)
        audit_service.record(
            db, actor_type, actor_id, "operation.config.patch", None,
            {"operator": admin.username, "keys": sorted(updates.keys())},
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return view


# ---------------- 章节维护（工作流 A3） ----------------
@router.get(
    "/chapters",
    response_model=AdminChapterListOut,
    summary="章节列表",
    dependencies=[Depends(require_menu("chapters"))],
)
def list_chapters(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: str = Query(""),
    db: Session = Depends(get_db),
):
    total, items = admin_service.list_chapters(db, page, page_size, keyword)
    return {"total": total, "items": items}


@router.post(
    "/chapters",
    response_model=AdminChapterOut,
    summary="新增章节",
)
def create_chapter(
    payload: AdminChapterUpsert,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("chapters")),
):
    try:
        out = admin_service.create_chapter(db, payload.model_dump())
        actor_type, actor_id = _actor(admin)
        audit_service.record(
            db, actor_type, actor_id, "chapter.create", None,
            {"operator": admin.username, "id": out["id"], "name": out["name"]},
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return out


@router.post(
    "/chapters/reorder",
    response_model=AdminChapterListOut,
    summary="章节重排",
)
def reorder_chapters(
    payload: AdminChapterReorder,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("chapters")),
):
    try:
        items = admin_service.reorder_chapters(db, payload.ordered_ids)
        actor_type, actor_id = _actor(admin)
        audit_service.record(
            db, actor_type, actor_id, "chapter.reorder", None,
            {"operator": admin.username, "ordered_ids": payload.ordered_ids},
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return {"total": len(items), "items": items}


@router.put(
    "/chapters/{chapter_id}",
    response_model=AdminChapterOut,
    summary="编辑章节",
)
def update_chapter(
    chapter_id: int,
    payload: AdminChapterUpsert,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("chapters")),
):
    try:
        out = admin_service.update_chapter(db, chapter_id, payload.model_dump())
        if out is None:
            db.rollback()
            raise HTTPException(status_code=404, detail="章节不存在")
        actor_type, actor_id = _actor(admin)
        audit_service.record(
            db, actor_type, actor_id, "chapter.update", None,
            {"operator": admin.username, "id": chapter_id},
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return out


@router.delete(
    "/chapters/{chapter_id}",
    response_model=MessageOut,
    summary="删除章节",
)
def delete_chapter(
    chapter_id: int,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("chapters")),
):
    deleted = admin_service.delete_chapter(db, chapter_id)
    if not deleted:
        db.rollback()
        raise HTTPException(status_code=404, detail="章节不存在")
    actor_type, actor_id = _actor(admin)
    audit_service.record(
        db, actor_type, actor_id, "chapter.delete", None,
        {"operator": admin.username, "id": chapter_id},
    )
    db.commit()
    return {"message": "已删除"}


# ---------------- 人物志维护（工作流 A4） ----------------
@router.get(
    "/persons",
    response_model=AdminPersonListOut,
    summary="人物列表（含关联节点）",
    dependencies=[Depends(require_menu("persons"))],
)
def list_persons(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: str = Query(""),
    db: Session = Depends(get_db),
):
    total, items = admin_service.list_persons(db, page, page_size, keyword)
    return {"total": total, "items": items}


@router.post(
    "/persons/avatar",
    response_model=AdminUploadUrlOut,
    summary="上传人物头像（仅落盘返回 URL，不绑定人物）",
)
async def upload_person_avatar(
    request: Request,
    file: UploadFile = File(...),
    admin: AdminPrincipal = Depends(require_menu("persons")),
    db: Session = Depends(get_db),
):
    """接收 multipart 字段 file，复用与用户头像同一套校验与静态目录，返回绝对/相对 URL。

    前端拿到 url 后填入人物表单的 avatar 字段，再随 POST/PUT /admin/persons 提交。
    仅支持 jpg/jpeg/png/webp，大小上限见 settings.AVATAR_MAX_BYTES；不合法返回 400。
    分块读取（#5）：累计超限立即中断，不整块 await file.read() 入内存，防内存放大 DoS。
    """
    try:
        content = await upload_service.read_within_limit(file)
        url = upload_service.save_person_avatar(
            db, content, file.filename, str(request.base_url)
        )
    except upload_service.UploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"url": url}


@router.post(
    "/persons",
    response_model=AdminPersonOut,
    summary="新增人物",
)
def create_person(
    payload: AdminPersonUpsert,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("persons")),
):
    try:
        out = admin_service.create_person(db, payload.model_dump())
        actor_type, actor_id = _actor(admin)
        audit_service.record(
            db, actor_type, actor_id, "person.create", None,
            {"operator": admin.username, "id": out["id"], "name": out["name"]},
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return out


@router.put(
    "/persons/{person_id}",
    response_model=AdminPersonOut,
    summary="编辑人物（含关联节点删旧建新）",
)
def update_person(
    person_id: int,
    payload: AdminPersonUpsert,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("persons")),
):
    try:
        out = admin_service.update_person(db, person_id, payload.model_dump())
        if out is None:
            db.rollback()
            raise HTTPException(status_code=404, detail="人物不存在")
        actor_type, actor_id = _actor(admin)
        audit_service.record(
            db, actor_type, actor_id, "person.update", None,
            {"operator": admin.username, "id": person_id},
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return out


@router.delete(
    "/persons/{person_id}",
    response_model=MessageOut,
    summary="删除人物",
)
def delete_person(
    person_id: int,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("persons")),
):
    deleted = admin_service.delete_person(db, person_id)
    if not deleted:
        db.rollback()
        raise HTTPException(status_code=404, detail="人物不存在")
    actor_type, actor_id = _actor(admin)
    audit_service.record(
        db, actor_type, actor_id, "person.delete", None,
        {"operator": admin.username, "id": person_id},
    )
    db.commit()
    return {"message": "已删除"}


# ---------------- 勋章维护（工作流 A4） ----------------
@router.get(
    "/medals",
    response_model=AdminMedalListOut,
    summary="勋章列表",
    dependencies=[Depends(require_menu("medals"))],
)
def list_medals(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: str = Query(""),
    db: Session = Depends(get_db),
):
    total, items = admin_service.list_medals(db, page, page_size, keyword)
    return {"total": total, "items": items}


@router.post(
    "/medals",
    response_model=AdminMedalOut,
    summary="新增勋章（id 留空由后端生成）",
)
def create_medal(
    payload: AdminMedalUpsert,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("medals")),
):
    try:
        out = admin_service.create_medal(db, payload.model_dump())
        actor_type, actor_id = _actor(admin)
        audit_service.record(
            db, actor_type, actor_id, "medal.create", None,
            {"operator": admin.username, "id": out["id"], "name": out["name"]},
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return out


@router.put(
    "/medals/{medal_id}",
    response_model=AdminMedalOut,
    summary="编辑勋章（id 不可改）",
)
def update_medal(
    medal_id: str,
    payload: AdminMedalUpsert,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("medals")),
):
    try:
        out = admin_service.update_medal(db, medal_id, payload.model_dump())
        if out is None:
            db.rollback()
            raise HTTPException(status_code=404, detail="勋章不存在")
        actor_type, actor_id = _actor(admin)
        audit_service.record(
            db, actor_type, actor_id, "medal.update", None,
            {"operator": admin.username, "id": medal_id},
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))
    return out


@router.delete(
    "/medals/{medal_id}",
    response_model=MessageOut,
    summary="删除勋章（并清理已发放记录）",
)
def delete_medal(
    medal_id: str,
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("medals")),
):
    deleted = admin_service.delete_medal(db, medal_id)
    if not deleted:
        db.rollback()
        raise HTTPException(status_code=404, detail="勋章不存在")
    actor_type, actor_id = _actor(admin)
    audit_service.record(
        db, actor_type, actor_id, "medal.delete", None,
        {"operator": admin.username, "id": medal_id},
    )
    db.commit()
    return {"message": "已删除"}
