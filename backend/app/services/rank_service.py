"""排名服务：全员工「总积分」总榜（跨所有组织，小程序与管理端同一口径）。

口径：
  总积分 = 步行积分 + 答题积分（points_service 台账）从高到低；
  同分按累计步数降序，再按 user_id 升序，保证名次稳定且两端一致。
排名在数据库内用窗口函数计算，只取榜单所需的少量行，用户量大时不做全量加载。
"""
from typing import Dict, List, Optional

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.models import DailySport, User
from app.services import org_service, points_service

TOP_LIMIT = 100  # 旧版 /rank/steps 榜单条数
ELITE_SIZE = 10  # 小程序领奖台 + 荣誉卡区（第 1~10 名）始终返回


def ranked_users_subquery(db: Session):
    """全员排名子查询：列 user_id / steps / points / walk_points / quiz_points / rank。"""
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
    return (
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
        .subquery()
    )


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


def get_points_rank(db: Session, current_user_id: int, page: int = 1, page_size: int = 20) -> Dict:
    """总积分榜：top 为第 1~10 名；list 为第 11 名起的第 page 页；me 为当前用户（始终返回）。"""
    ranked = ranked_users_subquery(db)
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
    total = db.query(func.count(User.id)).scalar() or 0
    return {
        "top": top,
        "list": rest[: min(len(page_rows), page_size)],
        "me": rest[-1] if me_rows else None,
        "page": page,
        "page_size": page_size,
        "has_more": len(page_rows) > page_size,
        "total": int(total),
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
