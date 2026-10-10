"""管理后台路由：管理员登录、扫码登录、题库维护、组织架构维护与同步。

除 POST /api/admin/login 与扫码登录相关接口外，全部接口依赖 get_current_admin
（超管令牌或微信关联管理员令牌，后者每次请求查库校验授权）。
契约面向根目录 admin 前端项目（Vue3 + TS），字段为 snake_case，独立于小程序 camelCase 契约。
"""
import base64
from datetime import datetime
from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import AdminPrincipal, get_current_admin, require_menu
from app.core import rate_limit
from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_admin_token, create_admin_token_for_user
from app.models.models import User
from app.schemas.schemas import (
    AdminActivityListOut,
    AdminAuditLogListOut,
    AdminDashboardOut,
    AdminLoginOut,
    AdminLoginRequest,
    AdminMeOut,
    AdminMenuOut,
    AdminOnboardingQrOut,
    AdminOrgNodeOut,
    AdminOrgUserListOut,
    AdminQrCreateOut,
    AdminQrStatusOut,
    AdminRankListOut,
    AdminOrgSyncOut,
    AdminOrgTreeOut,
    AdminOrgUpsert,
    AdminImportConfirmOut,
    AdminImportConfirmRequest,
    AdminImportPreviewOut,
    AdminQuestionListOut,
    AdminQuestionOut,
    AdminQuestionUpsert,
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
    AdminUserOverviewOut,
    AdminUserRolesRequest,
    MessageOut,
)
from app.services import (
    access_service,
    admin_service,
    dashboard_service,
    identity_service,
    import_service,
    quote_service,
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
        "image": None if mock else "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
        "scene": scene_token if mock else None,
        "mock": mock,
        "expires_in": settings.QR_LOGIN_TTL_SECONDS,
    }


@router.get(
    "/onboarding-qrcode",
    response_model=AdminOnboardingQrOut,
    summary="通用入驻小程序码（员工扫码进入小程序自动登录）",
)
def get_onboarding_qrcode(_: AdminPrincipal = Depends(get_current_admin)):
    """码内仅含启动页路径与固定渠道标记，不含任何个人信息、OpenID 或 Token。"""
    png = wechat_service.get_onboarding_png()
    return {
        "image": None if png is None else "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
        "page": wechat_service.ONBOARD_PAGE,
        "scene": wechat_service.ONBOARD_SCENE,
        "env_version": settings.WXACODE_ENV_VERSION,
        "mock": png is None,
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
    summary="全员排名与节点到达时间",
    dependencies=[Depends(require_menu("rankings"))],
)
def rankings(db: Session = Depends(get_db)):
    return admin_service.get_rank_overview(db)


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


@router.get(
    "/questions/import-template",
    summary="下载题库导入模板（Excel）",
    dependencies=[Depends(require_menu("questions"))],
)
def download_question_import_template():
    content = import_service.build_question_template()
    filename = quote("长征步迹_题库导入模板.xlsx")
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


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
    if not (file.filename or "").lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="仅支持 .xlsx 文件，请使用下载的模板")
    content = file.file.read(import_service.MAX_FILE_SIZE + 1)
    if len(content) > import_service.MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="文件大小超过 2MB 限制")
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


# ---------------- 每日寄语维护（需求 §16）----------------
@router.get(
    "/quotes",
    response_model=AdminQuoteListOut,
    summary="寄语列表（分页）",
    dependencies=[Depends(require_menu("quotes"))],
)
def list_quotes(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    total, items = quote_service.list_quotes(db, page, page_size)
    return {"total": total, "items": items}


@router.post(
    "/quotes",
    response_model=AdminQuoteOut,
    summary="新增寄语",
    dependencies=[Depends(require_menu("quotes"))],
)
def create_quote(payload: AdminQuoteUpsert, db: Session = Depends(get_db)):
    error = quote_service.validate_quote(db, payload.date, payload.content, payload.source, payload.node_id)
    if error:
        raise HTTPException(status_code=400, detail=error)
    if quote_service.date_taken(db, payload.date):
        raise HTTPException(status_code=400, detail="该日期已有寄语")
    row = quote_service.create_quote(db, payload.date, payload.content, payload.source, payload.node_id)
    return quote_service.get_admin_out(db, row)


@router.put(
    "/quotes/{quote_id}",
    response_model=AdminQuoteOut,
    summary="编辑寄语",
    dependencies=[Depends(require_menu("quotes"))],
)
def update_quote(quote_id: int, payload: AdminQuoteUpsert, db: Session = Depends(get_db)):
    error = quote_service.validate_quote(db, payload.date, payload.content, payload.source, payload.node_id)
    if error:
        raise HTTPException(status_code=400, detail=error)
    if quote_service.date_taken(db, payload.date, exclude_id=quote_id):
        raise HTTPException(status_code=400, detail="该日期已有寄语")
    row = quote_service.update_quote(db, quote_id, payload.date, payload.content, payload.source, payload.node_id)
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
    db: Session = Depends(get_db),
    admin: AdminPrincipal = Depends(require_menu("access")),
):
    total, items = access_service.list_users(
        db, page, page_size, keyword, org_id, has_access
    )
    return {"total": total, "items": items}


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
