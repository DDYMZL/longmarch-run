"""排名路由：全员工总积分榜、部门榜与用户公开摘要卡（与管理端排名同一口径）。"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import require_activity_view
from app.core.database import get_db
from app.models.models import User
from app.schemas.schemas import OrgRankOut, PointsRankOut, RankListOut, UserCardOut
from app.services import rank_service

router = APIRouter(prefix="/rank", tags=["rank"])


@router.get("/points", response_model=PointsRankOut, summary="全员工总积分排行榜")
def points_rank(
    page: int = Query(1, ge=1, description="第 11 名起的分页页码"),
    page_size: int = Query(20, ge=1, le=50),
    page_size_camel: Optional[int] = Query(
        None,
        ge=1,
        le=50,
        alias="pageSize",
        include_in_schema=False,
        description="#16 兼容旧调用方 camelCase；与 page_size 等价，pageSize 优先",
    ),
    org_id: Optional[int] = Query(None, alias="orgId", description="scope=org 时的组织 id，缺省用本人组织"),
    scope: str = Query("all", pattern="^(all|org)$", description="all 全员榜 / org 我的部门榜"),
    current: User = Depends(require_activity_view),
    db: Session = Depends(get_db),
):
    """按总积分降序（同分按累计步数、再按 user_id），top 为前 10 名，list 为第 11 名起分页。

    scope=org 时只统计组织子树成员（名次在子集内重排）；未显式传 orgId 时默认取本人所属组织。
    越权（#17）：orgId 不在本人可见子树内返回 403；本人无组织时退化为全员并在 scopeApplied 标注。
    分页参数（#16）同时接受 page_size 与 pageSize（本页 pageSize 优先）。
    """
    effective_page_size = page_size_camel if page_size_camel is not None else page_size
    try:
        return rank_service.get_points_rank(
            db, current, page, effective_page_size, org_id, scope
        )
    except rank_service.OrgScopeDenied:
        raise HTTPException(status_code=403, detail="无权查看该部门榜单")


@router.get("/orgs", response_model=OrgRankOut, summary="部门榜（按组织聚合）")
def orgs_rank(
    current: User = Depends(require_activity_view),
    db: Session = Depends(get_db),
):
    """按用户所选组织聚合成员数 / 总步数 / 人均积分 / 点亮节点数，按总步数降序。"""
    return rank_service.get_org_rank(db)


@router.get("/user/{user_id}", response_model=UserCardOut, summary="用户公开摘要卡")
def user_card(
    user_id: int,
    current: User = Depends(require_activity_view),
    db: Session = Depends(get_db),
):
    """公开摘要：昵称（按运营参数脱敏）/头像/组织全名/积分/步数/点亮数/勋章数/名次。

    可见范围（#10）：仅本人 / 同组织子树 / 全员公开领奖台内可见，其余一律 404，
    避免通过遍历 user_id 枚举他人是否存在（404 文案统一为「用户不存在」不泄露差异）。
    """
    card = rank_service.get_user_card(db, user_id, current)
    if card is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    return card


@router.get("/steps", response_model=RankListOut, summary="排行榜（旧版契约）")
def steps_rank(current: User = Depends(require_activity_view), db: Session = Depends(get_db)):
    """旧版榜单结构，名次与总积分榜一致。"""
    return rank_service.get_steps_rank(db, current.id)
