"""排名服务：全员工「累计步数」总榜（跨所有组织）。

口径：
  以每个用户 DailySport.steps 之和作为成绩，从高到低排名（同分按 user_id 升序）；
  榜单为所有员工的总榜，返回名次、组织名，并标记当前用户与「我的名次」。
排名在数据库内用窗口函数计算，只取榜单所需的少量行，用户量大时不做全量加载。
"""
from typing import Dict, List, Optional

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.models import DailySport, User
from app.services import org_service

# 榜单最多返回条数（防止用户量过大时响应过长）；当前用户始终包含
TOP_LIMIT = 100


def ranked_users_subquery(db: Session):
    """全员排名子查询：列 user_id / steps（累计步数，无记录计 0）/ rank（名次）。"""
    totals = (
        db.query(
            DailySport.user_id.label("user_id"),
            func.sum(DailySport.steps).label("steps"),
        )
        .group_by(DailySport.user_id)
        .subquery()
    )
    steps = func.coalesce(totals.c.steps, 0)
    return (
        db.query(
            User.id.label("user_id"),
            steps.label("steps"),
            func.row_number().over(order_by=(steps.desc(), User.id.asc())).label("rank"),
        )
        .outerjoin(totals, totals.c.user_id == User.id)
        .subquery()
    )


def get_steps_rank(db: Session, current_user_id: int) -> Dict:
    """全员工累计步数排行榜。

    返回：{list, my_rank, my_steps, total}
      list 每项：{rank, user_id, nickname, avatar, org_name, steps, is_me}
      list 为前 TOP_LIMIT 名，当前用户在榜外时追加到末尾。
    """
    ranked = ranked_users_subquery(db)
    rows = (
        db.query(ranked.c.rank, ranked.c.steps, User.id, User.nickname, User.avatar, User.org_id)
        .join(User, User.id == ranked.c.user_id)
        .filter(or_(ranked.c.rank <= TOP_LIMIT, ranked.c.user_id == current_user_id))
        .order_by(ranked.c.rank)
        .all()
    )
    org_names = org_service.get_full_name_map(db, [row.org_id for row in rows])

    board: List[Dict] = []
    my_rank: Optional[int] = None
    my_steps = 0
    for rank, steps, user_id, nickname, avatar, org_id in rows:
        is_me = user_id == current_user_id
        if is_me:
            my_rank, my_steps = int(rank), int(steps)
        board.append(
            {
                "rank": int(rank),
                "user_id": user_id,
                "nickname": nickname,
                "avatar": avatar,
                "org_name": org_names.get(org_id, "") if org_id else "",
                "steps": int(steps),
                "is_me": is_me,
            }
        )

    total = db.query(func.count(User.id)).scalar() or 0
    return {"list": board, "my_rank": my_rank, "my_steps": my_steps, "total": int(total)}
