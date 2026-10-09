"""管理后台路由：管理员登录、题库维护、组织架构维护与同步。

除 POST /api/admin/login 外，全部接口依赖 get_current_admin（role=admin 的 JWT）。
契约面向根目录 admin 前端项目（Vue3 + TS），字段为 snake_case，独立于小程序 camelCase 契约。
"""
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_admin_token
from app.schemas.schemas import (
    AdminActivityListOut,
    AdminDashboardOut,
    AdminLoginOut,
    AdminLoginRequest,
    AdminOrgNodeOut,
    AdminOrgUserListOut,
    AdminRankListOut,
    AdminOrgSyncOut,
    AdminOrgTreeOut,
    AdminOrgUpsert,
    AdminQuestionListOut,
    AdminQuestionOut,
    AdminQuestionUpsert,
    AdminQuoteListOut,
    AdminQuoteOut,
    AdminQuoteUpsert,
    AdminRouteNodeEnabled,
    AdminRouteNodeListOut,
    AdminRouteNodeOut,
    AdminRouteNodeUpsert,
    AdminScreenOut,
    AdminTrendOut,
    AdminUserOverviewOut,
    MessageOut,
)
from app.services import admin_service, dashboard_service, quote_service

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/login", response_model=AdminLoginOut, summary="管理后台登录")
def login(payload: AdminLoginRequest):
    """校验管理员账号密码（配置 ADMIN_USERNAME/ADMIN_PASSWORD），签发 role=admin 令牌。

    未配置 ADMIN_PASSWORD 时账号登录禁用（不硬编码默认密码），仅允许微信扫码登录。
    """
    if not settings.ADMIN_PASSWORD:
        raise HTTPException(status_code=403, detail="未配置管理账号密码，请使用微信扫码登录")
    if (
        payload.username != settings.ADMIN_USERNAME
        or payload.password != settings.ADMIN_PASSWORD
    ):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    return {"token": create_admin_token(payload.username), "username": payload.username}


# ---------------- 驾驶舱 / 数据大屏 ----------------
@router.get(
    "/dashboard",
    response_model=AdminDashboardOut,
    summary="驾驶舱聚合（核心指标 + 路线总览）",
    dependencies=[Depends(get_current_admin)],
)
def dashboard(db: Session = Depends(get_db)):
    return dashboard_service.get_dashboard(db)


@router.get(
    "/dashboard/trend",
    response_model=AdminTrendOut,
    summary="运动趋势（近 N 日）",
    dependencies=[Depends(get_current_admin)],
)
def dashboard_trend(
    days: int = Query(7, ge=1, le=90), db: Session = Depends(get_db)
):
    return dashboard_service.get_trend(db, days)


@router.get(
    "/activities",
    response_model=AdminActivityListOut,
    summary="实时动态（user_event 关联昵称，倒序）",
    dependencies=[Depends(get_current_admin)],
)
def activities(
    limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)
):
    return {"items": dashboard_service.get_activities(db, limit)}


@router.get(
    "/screen",
    response_model=AdminScreenOut,
    summary="数据大屏聚合（指标 + 路线总览 + 7 日趋势 + 动态）",
    dependencies=[Depends(get_current_admin)],
)
def screen(db: Session = Depends(get_db)):
    return dashboard_service.get_screen(db)


# ---------------- 路线节点维护 ----------------
@router.get(
    "/route-nodes",
    response_model=AdminRouteNodeListOut,
    summary="路线节点列表",
    dependencies=[Depends(get_current_admin)],
)
def list_route_nodes(db: Session = Depends(get_db)):
    items = admin_service.list_route_nodes(db)
    return {"total": len(items), "items": items}


@router.post(
    "/route-nodes",
    response_model=AdminRouteNodeOut,
    summary="新增路线节点",
    dependencies=[Depends(get_current_admin)],
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
    dependencies=[Depends(get_current_admin)],
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
    dependencies=[Depends(get_current_admin)],
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
    dependencies=[Depends(get_current_admin)],
)
def rankings(db: Session = Depends(get_db)):
    return admin_service.get_rank_overview(db)


@router.get(
    "/users/{user_id}/overview",
    response_model=AdminUserOverviewOut,
    summary="人员详情聚合（运动/答题/勋章/长征/积分）",
    dependencies=[Depends(get_current_admin)],
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
    summary="题目列表",
    dependencies=[Depends(get_current_admin)],
)
def list_questions(db: Session = Depends(get_db)):
    items = admin_service.list_questions(db)
    return {"total": len(items), "items": items}


@router.post(
    "/questions",
    response_model=AdminQuestionOut,
    summary="新增题目",
    dependencies=[Depends(get_current_admin)],
)
def create_question(payload: AdminQuestionUpsert, db: Session = Depends(get_db)):
    try:
        return admin_service.create_question(db, payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put(
    "/questions/{question_id}",
    response_model=AdminQuestionOut,
    summary="编辑题目",
    dependencies=[Depends(get_current_admin)],
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
    dependencies=[Depends(get_current_admin)],
)
def delete_question(question_id: int, db: Session = Depends(get_db)):
    admin_service.delete_question(db, question_id)
    return {"message": "已删除"}


# ---------------- 每日寄语维护（需求 §16）----------------
@router.get(
    "/quotes",
    response_model=AdminQuoteListOut,
    summary="寄语列表（分页）",
    dependencies=[Depends(get_current_admin)],
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
    dependencies=[Depends(get_current_admin)],
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
    dependencies=[Depends(get_current_admin)],
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
    dependencies=[Depends(get_current_admin)],
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
    dependencies=[Depends(get_current_admin)],
)
def org_tree(db: Session = Depends(get_db)):
    return admin_service.get_org_tree(db)


@router.get(
    "/orgs/{org_id}/users",
    response_model=AdminOrgUserListOut,
    summary="组织人员明细（直属或含全部下级，分页）",
    dependencies=[Depends(get_current_admin)],
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
    dependencies=[Depends(get_current_admin)],
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
    dependencies=[Depends(get_current_admin)],
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
    dependencies=[Depends(get_current_admin)],
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
    dependencies=[Depends(get_current_admin)],
)
def sync_orgs(db: Session = Depends(get_db)):
    """全量对齐外部组织架构；未配置 ORG_SYNC_API_URL 时降级使用内置种子数据。"""
    try:
        return admin_service.sync_orgs(db)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
