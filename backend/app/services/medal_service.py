"""勋章服务（迁移自前端 services/medal.js）。

勋章由后端根据用户行为自动发放，业务数据变化后调用 check_and_grant 刷新。
条件：
  first-step 完成首次运动同步；learner 完成 10 次答题；master 累计积分 ≥ 500；
  luding / snow 点亮对应节点（id 6 / 7）；victory 点亮全部节点。
"""
from typing import Dict, List, Set

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.data.seed import MEDALS, MEDAL_NODE_MAP
from app.models.models import (
    DailySport,
    LitNode,
    MedalDef,
    PointsLog,
    QuizRecord,
    RouteNode,
    UserMedal,
)


def _owned_ids(db: Session, user_id: int) -> Set[str]:
    rows = db.query(UserMedal.medal_id).filter(UserMedal.user_id == user_id).all()
    return {r[0] for r in rows}


def _total_points(db: Session, user_id: int) -> int:
    total = (
        db.query(func.coalesce(func.sum(PointsLog.delta), 0))
        .filter(PointsLog.user_id == user_id)
        .scalar()
    )
    return int(total or 0)


def check_and_grant(db: Session, user_id: int) -> List[str]:
    """检查并发放勋章，返回本次新获得的勋章 id 列表。"""
    owned = _owned_ids(db, user_id)

    has_sport = (
        db.query(DailySport.id).filter(DailySport.user_id == user_id).first() is not None
    )
    quiz_count = db.query(QuizRecord.id).filter(QuizRecord.user_id == user_id).count()
    total_points = _total_points(db, user_id)

    total_steps = sum(
        (r[0] or 0)
        for r in db.query(DailySport.steps).filter(DailySport.user_id == user_id).all()
    )
    lit: Set[int] = {
        r[0] for r in db.query(LitNode.node_id).filter(LitNode.user_id == user_id).all()
    }
    all_nodes = db.query(RouteNode).all()
    # 与 march 服务口径一致：步数达标的节点视为已点亮
    for n in all_nodes:
        if total_steps >= n.target_steps:
            lit.add(n.id)

    candidates: List[str] = []
    if has_sport:
        candidates.append("first-step")
    if quiz_count >= 10:
        candidates.append("learner")
    if total_points >= 500:
        candidates.append("master")
    if MEDAL_NODE_MAP.get("luding") in lit:
        candidates.append("luding")
    if MEDAL_NODE_MAP.get("snow") in lit:
        candidates.append("snow")
    if all_nodes and all(n.id in lit for n in all_nodes):
        candidates.append("victory")

    newly: List[str] = []
    for mid in candidates:
        if mid not in owned:
            db.add(UserMedal(user_id=user_id, medal_id=mid))
            owned.add(mid)
            newly.append(mid)
    if newly:
        db.commit()
    return newly


def get_medal_list(db: Session, user_id: int) -> List[Dict]:
    """勋章列表（含未获得状态），按定义顺序返回。"""
    owned = _owned_ids(db, user_id)
    defs = {m.id: m for m in db.query(MedalDef).all()}
    result: List[Dict] = []
    for seed in MEDALS:  # 保持 seed 中定义的展示顺序
        m = defs.get(seed["id"])
        if m is None:
            continue
        result.append(
            {
                "id": m.id,
                "name": m.name,
                "icon": m.icon,
                "desc": m.desc,
                "owned": m.id in owned,
            }
        )
    return result


def get_owned_count(db: Session, user_id: int) -> int:
    """已获得勋章数量。"""
    return db.query(UserMedal.id).filter(UserMedal.user_id == user_id).count()
