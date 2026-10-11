"""勋章服务（迁移自前端 services/medal.js）。

勋章由后端根据用户行为自动发放，业务数据变化后调用 check_and_grant 刷新。
条件：
  first-step 完成首次运动同步；learner 完成 10 次答题；master 累计积分 ≥ 500；
  luding / snow 点亮对应节点（id 6 / 7）；victory 点亮全部节点；
  persistence 连续行军 ≥7 天；streak-30 连续行军 ≥30 天；
  day-10k 单日 ≥10000 步；steps-100k / steps-500k 累计 ≥10万 / 50万 步；
  fearless（隐藏）连续 7 天每天 ≥10000 步。
新获勋章写 BADGE_UNLOCK 事件（我的足迹与管理端动态同源）。
"""
from typing import Dict, List, Set

from sqlalchemy.orm import Session

from app.data.seed import MEDALS, MEDAL_NODE_MAP
from app.models.models import (
    DailySport,
    LitNode,
    MedalDef,
    QuizRecord,
    RouteNode,
    UserMedal,
)
from app.services import event_service, points_service, streak_service


def _owned_ids(db: Session, user_id: int) -> Set[str]:
    rows = db.query(UserMedal.medal_id).filter(UserMedal.user_id == user_id).all()
    return {r[0] for r in rows}


def check_and_grant(db: Session, user_id: int) -> List[str]:
    """检查并发放勋章，返回本次新获得的勋章 id 列表。"""
    owned = _owned_ids(db, user_id)

    # 运动类条件只查一次 daily_sport（每用户每日一行），在内存中派生全部指标
    sport_rows = (
        db.query(DailySport.date, DailySport.steps, DailySport.is_goal_completed)
        .filter(DailySport.user_id == user_id)
        .all()
    )
    has_sport = bool(sport_rows)
    total_steps = sum((steps or 0) for _d, steps, _g in sport_rows)
    goal_days = {d for d, _s, goal in sport_rows if goal}
    days_10k = {d for d, steps, _g in sport_rows if (steps or 0) >= 10000}
    quiz_count = db.query(QuizRecord.id).filter(QuizRecord.user_id == user_id).count()
    total_points = points_service.get_total(db, user_id)

    lit: Set[int] = {
        r[0] for r in db.query(LitNode.node_id).filter(LitNode.user_id == user_id).all()
    }
    all_nodes = (
        db.query(RouteNode.id, RouteNode.target_steps)
        .filter(RouteNode.is_enabled.is_(True))
        .all()
    )
    # 与 march 服务口径一致：步数达标的节点视为已点亮
    for node_id, target_steps in all_nodes:
        if total_steps >= target_steps:
            lit.add(node_id)

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
    if all_nodes and all(node_id in lit for node_id, _t in all_nodes):
        candidates.append("victory")

    # 连续行军与步数挑战类（以 daily_sport 记录为准实时计算）
    best_streak = streak_service.streaks_of(goal_days)[1]
    if best_streak >= 7:
        candidates.append("persistence")
    if best_streak >= 30:
        candidates.append("streak-30")
    if days_10k:
        candidates.append("day-10k")
    if total_steps >= 100000:
        candidates.append("steps-100k")
    if total_steps >= 500000:
        candidates.append("steps-500k")
    if streak_service.longest_run(days_10k) >= 7:
        candidates.append("fearless")

    newly: List[str] = []
    for mid in candidates:
        if mid not in owned:
            db.add(UserMedal(user_id=user_id, medal_id=mid))
            owned.add(mid)
            newly.append(mid)
    if newly:
        db.commit()
        defs = {m.id: m for m in db.query(MedalDef).filter(MedalDef.id.in_(newly)).all()}
        for mid in newly:
            medal_def = defs.get(mid)
            event_service.record(
                db,
                user_id,
                "BADGE_UNLOCK",
                {
                    "medalId": mid,
                    "medalName": medal_def.name if medal_def else mid,
                    "hidden": bool(medal_def.hidden) if medal_def else False,
                },
            )
    return newly


def get_medal_list(db: Session, user_id: int) -> List[Dict]:
    """勋章列表（含未获得状态），按定义顺序返回。

    扩展字段（功能 9 勋章墙）：category / hidden / sort_order / granted_at /
    condition_desc（隐藏且未获得时不公开获取条件）。
    """
    owned_rows = db.query(UserMedal).filter(UserMedal.user_id == user_id).all()
    granted_at = {r.medal_id: r.granted_at for r in owned_rows}
    defs = {m.id: m for m in db.query(MedalDef).all()}
    result: List[Dict] = []
    for seed in MEDALS:  # 保持 seed 中定义的展示顺序
        m = defs.get(seed["id"])
        if m is None:
            continue
        owned = m.id in granted_at
        hidden = bool(m.hidden)
        return_desc = m.desc or ""
        result.append(
            {
                "id": m.id,
                "name": m.name,
                "icon": m.icon,
                "desc": m.desc or "",
                "owned": owned,
                "category": m.category or "",
                "hidden": hidden,
                "sort_order": m.sort_order,
                "granted_at": granted_at.get(m.id),
                "condition_desc": "获得条件暂未公布" if (hidden and not owned) else return_desc,
            }
        )
    return result


def get_owned_count(db: Session, user_id: int) -> int:
    """已获得勋章数量。"""
    return db.query(UserMedal.id).filter(UserMedal.user_id == user_id).count()
