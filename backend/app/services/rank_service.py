"""排名服务：全员工「累计步数」总榜（跨所有组织）。

口径：
  以每个用户 DailySport.steps 之和作为成绩，从高到低排名；
  榜单为所有员工的总榜，返回名次、组织名，并标记当前用户与「我的名次」。
"""
from typing import Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.models import DailySport, User
from app.services import org_service

# 榜单最多返回条数（防止用户量过大时响应过长）；当前用户始终包含
TOP_LIMIT = 100


def get_steps_rank(db: Session, current_user_id: int) -> Dict:
    """全员工累计步数排行榜。

    返回：{list, my_rank, my_steps, total}
      list 每项：{rank, user_id, nickname, avatar, org_name, steps, is_me}
    """
    # 每个用户的累计步数（无运动记录者计 0，仍参与榜单）
    steps_rows = dict(
        db.query(DailySport.user_id, func.coalesce(func.sum(DailySport.steps), 0))
        .group_by(DailySport.user_id)
        .all()
    )

    users = db.query(User).all()
    # 组织全路径名整表一次加载（避免逐组织逐层回溯查询）
    org_names = org_service.get_full_name_map(db, [u.org_id for u in users])

    entries: List[Dict] = []
    for u in users:
        entries.append(
            {
                "user_id": u.id,
                "nickname": u.nickname,
                "avatar": u.avatar,
                "org_name": org_names.get(u.org_id, "") if u.org_id else "",
                "steps": int(steps_rows.get(u.id, 0)),
                "is_me": u.id == current_user_id,
            }
        )

    # 步数降序；同分按 user_id 升序，保证名次稳定
    entries.sort(key=lambda e: (-e["steps"], e["user_id"]))

    my_rank: Optional[int] = None
    my_steps = 0
    for idx, e in enumerate(entries):
        e["rank"] = idx + 1
        if e["is_me"]:
            my_rank = e["rank"]
            my_steps = e["steps"]

    total = len(entries)
    # 截取前 TOP_LIMIT，但确保当前用户在榜单内
    board = entries[:TOP_LIMIT]
    if my_rank is not None and my_rank > TOP_LIMIT:
        me = next(e for e in entries if e["is_me"])
        board = board + [me]

    return {"list": board, "my_rank": my_rank, "my_steps": my_steps, "total": total}
