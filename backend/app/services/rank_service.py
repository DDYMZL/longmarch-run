"""排名服务：全员工「总积分」总榜（跨所有组织，小程序与管理端同一口径）。

口径：
  总积分 = 步行积分 + 答题积分（points_service 台账）从高到低；
  同分按累计步数降序，再按 user_id 升序，保证名次稳定且两端一致。
排名在数据库内用窗口函数计算，只取榜单所需的少量行，用户量大时不做全量加载。
"""
from typing import Dict, List, Optional

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.models.models import DailySport, LitNode, Organization, User, UserMedal
from app.services import event_service, operation_config_service, org_service, points_service

TOP_LIMIT = 100  # 旧版 /rank/steps 榜单条数
ELITE_SIZE = 10  # 小程序领奖台 + 荣誉卡区（第 1~10 名）始终返回


class OrgScopeDenied(Exception):
    """#17：scope=org 请求的 orgId 不在当前用户可见组织子树内（越权），路由层转 403。"""


def ranked_users_subquery(db: Session, org_ids: Optional[List[int]] = None):
    """全员排名子查询：列 user_id / steps / points / walk_points / quiz_points / rank。

    org_ids 非空时只统计该组织集合内成员（名次在子集内重排），用于「我的部门」榜。
    """
    totals = (
        db.query(
            DailySport.user_id.label("user_id"),
            func.sum(DailySport.steps).label("steps"),
        )
        .group_by(DailySport.user_id)
        .subquery()
    )
    pts = points_service.points_subquery(db)
    steps = func.coalesce(totals.c.steps, 0)
    points = func.coalesce(pts.c.total, 0)
    query = (
        db.query(
            User.id.label("user_id"),
            steps.label("steps"),
            points.label("points"),
            func.coalesce(pts.c.walk, 0).label("walk_points"),
            func.coalesce(pts.c.quiz, 0).label("quiz_points"),
            func.row_number().over(order_by=(points.desc(), steps.desc(), User.id.asc())).label("rank"),
        )
        .outerjoin(totals, totals.c.user_id == User.id)
        .outerjoin(pts, pts.c.user_id == User.id)
    )
    if org_ids is not None:
        query = query.filter(User.org_id.in_(org_ids))
    return query.subquery()


def _board_query(db: Session, ranked):
    return (
        db.query(
            ranked.c.rank,
            ranked.c.steps,
            ranked.c.points,
            ranked.c.walk_points,
            ranked.c.quiz_points,
            User.id.label("user_id"),
            User.nickname,
            User.avatar,
            User.org_id,
        )
        .join(User, User.id == ranked.c.user_id)
        .order_by(ranked.c.rank)
    )


def _items(db: Session, rows: List, current_user_id: int) -> List[Dict]:
    org_names = org_service.get_full_name_map(db, [r.org_id for r in rows if r.org_id])
    return [
        {
            "rank": int(r.rank),
            "user_id": r.user_id,
            "nickname": r.nickname,
            "avatar": r.avatar,
            "org_name": org_names.get(r.org_id, "") if r.org_id else "",
            "steps": int(r.steps),
            "points": int(r.points),
            "walk_points": int(r.walk_points),
            "quiz_points": int(r.quiz_points),
            "is_me": r.user_id == current_user_id,
        }
        for r in rows
    ]


def get_user_rank(db: Session, user_id: int) -> Optional[int]:
    ranked = ranked_users_subquery(db)
    rank = db.query(ranked.c.rank).filter(ranked.c.user_id == user_id).scalar()
    return int(rank) if rank is not None else None


def get_points_rank(
    db: Session,
    current_user: User,
    page: int = 1,
    page_size: int = 20,
    org_id: Optional[int] = None,
    scope: str = "all",
) -> Dict:
    """总积分榜：top 为第 1~10 名；list 为第 11 名起的第 page 页；me 为当前用户（始终返回）。

    scope="org"（#17）：
      - 调用者无组织：退化为全员榜，scope_applied='all'；
      - 调用者有组织：目标组织取 org_id（缺省用本人组织），必须落在本人可见子树
        subtree_org_ids(caller_org) 内，否则抛 OrgScopeDenied（路由转 403）；生效时
        只统计该组织子树成员（名次在子集内重排），scope_applied='org'。
    scope="all" 为全员榜，scope_applied='all'。
    """
    current_user_id = current_user.id
    caller_org = current_user.org_id
    org_ids: Optional[List[int]] = None
    scope_applied = "all"
    if scope == "org" and caller_org is not None:
        target_org = org_id if org_id is not None else caller_org
        if target_org not in org_service.subtree_org_ids(db, caller_org):
            raise OrgScopeDenied()
        org_ids = org_service.subtree_org_ids(db, target_org)
        scope_applied = "org"
    ranked = ranked_users_subquery(db, org_ids)
    query = _board_query(db, ranked)
    top_rows = query.filter(ranked.c.rank <= ELITE_SIZE).all()
    page_rows = (
        query.filter(ranked.c.rank > ELITE_SIZE)
        .offset((page - 1) * page_size)
        .limit(page_size + 1)
        .all()
    )
    me_rows = query.filter(ranked.c.user_id == current_user_id).all()
    items = _items(db, top_rows + page_rows[:page_size] + me_rows, current_user_id)
    top, rest = items[: len(top_rows)], items[len(top_rows):]
    count_query = db.query(func.count(User.id))
    if org_ids is not None:
        count_query = count_query.filter(User.org_id.in_(org_ids))
    total = count_query.scalar() or 0
    return {
        "top": top,
        "list": rest[: min(len(page_rows), page_size)],
        "me": rest[-1] if me_rows else None,
        "page": page,
        "page_size": page_size,
        "has_more": len(page_rows) > page_size,
        "total": int(total),
        "scope_applied": scope_applied,
    }


def get_org_rank(db: Session) -> Dict:
    """部门榜（需求 §8）：按用户所选组织聚合成员数 / 总步数 / 人均积分 / 点亮节点数。

    仅统计已选组织（org_id 非空）的成员；按总步数降序。人均积分四舍五入取整。
    """
    ranked = ranked_users_subquery(db)
    rows = (
        db.query(
            User.org_id.label("org_id"),
            func.count(User.id).label("member_count"),
            func.coalesce(func.sum(ranked.c.steps), 0).label("total_steps"),
            func.coalesce(func.avg(ranked.c.points), 0).label("avg_points"),
        )
        .join(ranked, ranked.c.user_id == User.id)
        .filter(User.org_id.isnot(None))
        .group_by(User.org_id)
        .order_by(func.sum(ranked.c.steps).desc(), User.org_id.asc())
        .all()
    )
    org_ids = [r.org_id for r in rows]
    lit_by_org: Dict[int, int] = {}
    names: Dict[int, str] = {}
    if org_ids:
        lit_by_org = {
            oid: int(cnt)
            for oid, cnt in (
                db.query(User.org_id, func.count(LitNode.id))
                .join(LitNode, LitNode.user_id == User.id)
                .filter(User.org_id.in_(org_ids))
                .group_by(User.org_id)
                .all()
            )
        }
        names = dict(
            db.query(Organization.id, Organization.name)
            .filter(Organization.id.in_(org_ids))
            .all()
        )
    return {
        "items": [
            {
                "org_id": r.org_id,
                "org_name": names.get(r.org_id, ""),
                "member_count": int(r.member_count),
                "total_steps": int(r.total_steps or 0),
                "avg_points": int(round(float(r.avg_points or 0))),
                "lit_nodes": lit_by_org.get(r.org_id, 0),
            }
            for r in rows
        ]
    }


def _user_points_steps(db: Session, user_id: int) -> tuple:
    """取单个用户的总积分与累计步数（无台账/无步数记 0）。"""
    pts = points_service.points_subquery(db)
    points = db.query(pts.c.total).filter(pts.c.user_id == user_id).scalar()
    steps = (
        db.query(func.coalesce(func.sum(DailySport.steps), 0))
        .filter(DailySport.user_id == user_id)
        .scalar()
    )
    return int(points or 0), int(steps or 0)


def _rank_by_count(db: Session, user_id: int, my_points: int, my_steps: int) -> int:
    """以「比大小计数」求名次（#10 降本）：统计严格优于目标用户的人数 +1。

    排序口径与窗口函数一致（积分降序、同分步数降序、再同 user_id 升序）；用一次
    count 聚合替代对全量用户物化 row_number，单卡查询成本更低。
    """
    pts = points_service.points_subquery(db)
    totals = (
        db.query(DailySport.user_id.label("uid"), func.sum(DailySport.steps).label("s"))
        .group_by(DailySport.user_id)
        .subquery()
    )
    per = (
        db.query(
            User.id.label("uid"),
            func.coalesce(pts.c.total, 0).label("p"),
            func.coalesce(totals.c.s, 0).label("s"),
        )
        .outerjoin(pts, pts.c.user_id == User.id)
        .outerjoin(totals, totals.c.uid == User.id)
        .subquery()
    )
    better = (
        db.query(func.count(per.c.uid))
        .filter(
            or_(
                per.c.p > my_points,
                and_(per.c.p == my_points, per.c.s > my_steps),
                and_(per.c.p == my_points, per.c.s == my_steps, per.c.uid < user_id),
            )
        )
        .scalar()
    )
    return int(better or 0) + 1


def get_user_card(db: Session, user_id: int, current_user: User) -> Optional[Dict]:
    """用户公开摘要卡（需求 §8）：昵称按 activity_mask_nickname 脱敏，含组织全名与名次。

    不含 openid 等敏感字段。可见范围（#10，防越权枚举）：仅当目标为本人、或与调用者
    同组织子树（org_service.subtree_org_ids）、或位于全员公开领奖台（rank<=ELITE_SIZE）
    时才返回；否则返回 None（路由转 404），使任意 user_id 枚举无法探知他人是否存在。
    """
    row = db.query(User).filter(User.id == user_id).first()
    if row is None:
        return None

    # 名次一次算好，既用于可见性判定（公开领奖台）也用于响应展示。
    my_points, my_steps = _user_points_steps(db, user_id)
    rank = _rank_by_count(db, user_id, my_points, my_steps)

    visible = user_id == current_user.id
    if not visible and current_user.org_id and row.org_id:
        visible = row.org_id in org_service.subtree_org_ids(db, current_user.org_id)
    if not visible and rank <= ELITE_SIZE:
        visible = True
    if not visible:
        return None

    lit_nodes = (
        db.query(func.count(LitNode.id)).filter(LitNode.user_id == user_id).scalar() or 0
    )
    medal_count = (
        db.query(func.count(UserMedal.id)).filter(UserMedal.user_id == user_id).scalar() or 0
    )
    nickname = row.nickname or ""
    if operation_config_service.get_effective(db).activity_mask_nickname:
        nickname = event_service.mask_nickname(nickname)
    org_name = (
        org_service.get_full_name_map(db, [row.org_id]).get(row.org_id, "")
        if row.org_id
        else ""
    )
    return {
        "nickname": nickname,
        "avatar": row.avatar or "",
        "org_name": org_name,
        "points": my_points,
        "steps": my_steps,
        "lit_nodes": int(lit_nodes),
        "medal_count": int(medal_count),
        "rank": rank,
    }


def get_steps_rank(db: Session, current_user_id: int) -> Dict:
    """旧版榜单契约（前 TOP_LIMIT 名 + 当前用户），名次与总积分榜一致。"""
    ranked = ranked_users_subquery(db)
    rows = (
        _board_query(db, ranked)
        .filter(or_(ranked.c.rank <= TOP_LIMIT, ranked.c.user_id == current_user_id))
        .all()
    )
    board = _items(db, rows, current_user_id)
    me = next((item for item in board if item["is_me"]), None)
    total = db.query(func.count(User.id)).scalar() or 0
    return {
        "list": board,
        "my_rank": me["rank"] if me else None,
        "my_steps": me["steps"] if me else 0,
        "total": int(total),
    }
