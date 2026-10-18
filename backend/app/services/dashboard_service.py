"""管理端驾驶舱 / 数据大屏服务。

dashboard：核心指标 + 路线总览（每节点达成人数，口径与小程序一致——累计步数
达标即视为点亮）；trend：近 N 日总步数/参与人数/新增用户/新增点亮；
activities：user_event 实时动态（关联昵称，文案与小程序足迹同源）；
screen：大屏单接口聚合（指标 + 路线总览 + 7 日趋势 + 动态，组织维度按需求取消）。

库内 created_at / lit_at / event_time 为 UTC 存储，按本地日期分桶时统一经
helpers.to_local / local_to_utc 换算。
"""
from bisect import bisect_left
from datetime import datetime, timedelta
from typing import Dict, List, Optional
import time

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.helpers import local_to_utc, recent_dates, to_local, today_str
from app.models.models import (
    DailySport,
    InviteCode,
    LitNode,
    Organization,
    QuizRecord,
    RouteNode,
    User,
    UserEvent,
    UserMedal,
)
from app.services import event_service, org_service, points_service


def _user_total_steps(db: Session) -> Dict[int, int]:
    """每用户累计步数。"""
    rows = (
        db.query(DailySport.user_id, func.sum(DailySport.steps))
        .group_by(DailySport.user_id)
        .all()
    )
    return {uid: int(total or 0) for uid, total in rows}


def _enabled_nodes(db: Session) -> List[RouteNode]:
    return (
        db.query(RouteNode)
        .filter(RouteNode.is_enabled.is_(True))
        .order_by(RouteNode.sort_order.asc(), RouteNode.id.asc())
        .all()
    )


def get_dashboard(db: Session) -> Dict:
    """驾驶舱聚合：metrics + route_overview。"""
    total_users = db.query(User.id).count()
    today_users = (
        db.query(DailySport.user_id)
        # #2：steps>0 排除失败占位行，today_users 只统计今日真正有步数的用户。
        .filter(DailySport.date == today_str(), DailySport.steps > 0)
        .distinct()
        .count()
    )
    totals = _user_total_steps(db)
    total_steps = sum(totals.values())
    avg_steps = round(total_steps / total_users) if total_users else 0

    nodes = _enabled_nodes(db)
    final_target = nodes[-1].target_steps if nodes else 0
    finished = (
        sum(1 for value in totals.values() if value >= final_target) if final_target else 0
    )
    completion_rate = round(finished / total_users * 100) if total_users else 0

    quiz_users = db.query(QuizRecord.user_id).distinct().count()
    medals_granted = db.query(UserMedal.id).count()

    # 累计步数升序后二分计数：每节点 O(log U)，替代逐节点 O(U) 全量扫描（用户量大时关键路径）
    sorted_totals = sorted(totals.values())
    route_overview = []
    for n in nodes:
        lit_count = len(sorted_totals) - bisect_left(sorted_totals, n.target_steps)
        route_overview.append(
            {
                "node_id": n.id,
                "name": n.name,
                "target_steps": n.target_steps,
                "lit_count": lit_count,
                "completion_rate": (
                    round(lit_count / total_users * 100) if total_users else 0
                ),
            }
        )

    return {
        "metrics": {
            "total_users": total_users,
            "today_users": today_users,
            "total_steps": total_steps,
            "avg_steps": avg_steps,
            "completion_rate": completion_rate,
            "quiz_users": quiz_users,
            "medals_granted": medals_granted,
        },
        "route_overview": route_overview,
    }


def get_trend(db: Session, days: int) -> Dict:
    """近 N 日趋势（本地日期分桶）：总步数/参与人数/新增用户/新增点亮。"""
    dates = recent_dates(days)
    points = {
        d: {"date": d, "total_steps": 0, "active_users": 0, "new_users": 0, "new_lit": 0}
        for d in dates
    }

    sport_rows = (
        db.query(DailySport.date, func.sum(DailySport.steps), func.count(DailySport.id))
        # #2：steps>0 排除失败占位行；total_steps 不受影响（占位行 steps=0），
        # active_users 改为只统计当日真正有步数的用户。
        .filter(DailySport.date.in_(dates), DailySport.steps > 0)
        .group_by(DailySport.date)
        .all()
    )
    for date, steps, cnt in sport_rows:
        if date in points:
            points[date]["total_steps"] = int(steps or 0)
            points[date]["active_users"] = cnt

    # created_at / lit_at 为 UTC 存储：范围按 UTC 过滤，归桶按本地日期
    range_start_utc = local_to_utc(datetime.strptime(dates[0], "%Y-%m-%d"))

    user_rows = db.query(User.created_at).filter(User.created_at >= range_start_utc).all()
    for (created_at,) in user_rows:
        key = to_local(created_at).strftime("%Y-%m-%d")
        if key in points:
            points[key]["new_users"] += 1

    lit_rows = db.query(LitNode.lit_at).filter(LitNode.lit_at >= range_start_utc).all()
    for (lit_at,) in lit_rows:
        key = to_local(lit_at).strftime("%Y-%m-%d")
        if key in points:
            points[key]["new_lit"] += 1

    return {"days": days, "points": [points[d] for d in dates]}


def get_activities(db: Session, limit: int = 50) -> List[Dict]:
    """实时动态（user_event 倒序，关联昵称）。"""
    return [
        {
            "id": r.id,
            "event_type": r.event_type,
            "event_time": r.event_time,
            "user_id": r.user_id,
            "nickname": nickname,
            "text": event_service.build_text(r.event_type, r.event_data or {}),
            "data": r.event_data or {},
        }
        for r, nickname in event_service.recent_events(db, limit)
    ]


def get_screen(db: Session) -> Dict:
    """数据大屏单接口聚合：指标 + 路线总览 + 7 日趋势 + 最近 20 条动态。"""
    dashboard = get_dashboard(db)
    return {
        "metrics": dashboard["metrics"],
        "route_overview": dashboard["route_overview"],
        "trend": get_trend(db, 7)["points"],
        "activities": get_activities(db, 20),
    }


# ---------------- 数据运营分析（点13） ----------------
def get_org_compare(db: Session, org_ids: Optional[List[int]] = None) -> Dict:
    """组织横向对比：成员数 / 累计步数 / 人均步数 / 活跃人数 / 点亮节点数 / 人均积分。

    各维度均按 User.org_id 分组一次性聚合（避免逐组织查询）；org_ids 非空时仅统计这些组织，
    为空时统计全部有成员的组织。组织名用 org_service.get_full_name_map 批量取全路径名。
    """
    def _scoped(query):
        return query.filter(User.org_id.in_(org_ids)) if org_ids else query

    member_rows = _scoped(db.query(User.org_id, func.count(User.id))).group_by(User.org_id).all()
    members = {oid: int(c or 0) for oid, c in member_rows if oid is not None}

    step_rows = (
        _scoped(db.query(User.org_id, func.coalesce(func.sum(DailySport.steps), 0)))
        .join(DailySport, DailySport.user_id == User.id)
        .group_by(User.org_id)
        .all()
    )
    steps = {oid: int(s or 0) for oid, s in step_rows if oid is not None}

    active_rows = (
        _scoped(
            db.query(User.org_id, func.count(func.distinct(DailySport.user_id)))
        )
        .join(DailySport, DailySport.user_id == User.id)
        .filter(DailySport.steps > 0)
        .group_by(User.org_id)
        .all()
    )
    active = {oid: int(c or 0) for oid, c in active_rows if oid is not None}

    lit_rows = (
        _scoped(db.query(User.org_id, func.count(LitNode.id)))
        .join(LitNode, LitNode.user_id == User.id)
        .group_by(User.org_id)
        .all()
    )
    lit = {oid: int(c or 0) for oid, c in lit_rows if oid is not None}

    points_sq = points_service.points_subquery(db)
    # #11：avg_points 分母统一为 member_count（无积分台账的成员记 0 分），与 avg_steps
    # 口径一致；故此处对台账 total 求和（inner join 只累加有台账者，等价于其余记 0），
    # 再在下方除以 members[oid]（该组织全部成员数），避免用 func.avg 只按有台账者取均。
    point_rows = (
        _scoped(db.query(User.org_id, func.coalesce(func.sum(points_sq.c.total), 0)))
        .join(points_sq, points_sq.c.user_id == User.id)
        .group_by(User.org_id)
        .all()
    )
    points_sum = {oid: int(s or 0) for oid, s in point_rows if oid is not None}

    names = org_service.get_full_name_map(db, list(members.keys()))
    items = [
        {
            "org_id": oid,
            "org_name": names.get(oid, ""),
            "member_count": members.get(oid, 0),
            "total_steps": steps.get(oid, 0),
            "avg_steps": round(steps.get(oid, 0) / members[oid]) if members.get(oid) else 0,
            "active_users": active.get(oid, 0),
            "lit_nodes": lit.get(oid, 0),
            "avg_points": (
                round(points_sum.get(oid, 0) / members[oid]) if members.get(oid) else 0
            ),
        }
        for oid in sorted(members.keys())
    ]
    items.sort(key=lambda x: x["total_steps"], reverse=True)
    return {"items": items}


def get_invite_funnel(db: Session) -> Dict:
    """邀请漏斗（按邀请码分组）：扫码校验 → 入驻 → 首次登录 → 首次同步。

    - scans：匿名 INVITE_SCAN 事件按 event_data.invite_id 内存计数（事件量有限，避免 JSON 分组方言差异）；
    - onboarded：users 按 invite_code_id 计数；
    - first_logins：FIRST_LOGIN 事件关联用户后按 invite_code_id 计数；
    - synced：有真实步数（steps>0）记录的用户按 invite_code_id 计数。
    """
    scans: Dict[Optional[int], int] = {}
    scan_rows = (
        db.query(UserEvent.event_data)
        .filter(UserEvent.event_type == event_service.INVITE_SCAN)
        .all()
    )
    for (data,) in scan_rows:
        invite_id = (data or {}).get("invite_id")
        scans[invite_id] = scans.get(invite_id, 0) + 1

    onboarded = {
        oid: int(c or 0)
        for oid, c in db.query(User.invite_code_id, func.count(User.id))
        .group_by(User.invite_code_id)
        .all()
        if oid is not None
    }

    first_logins = {
        oid: int(c or 0)
        for oid, c in db.query(User.invite_code_id, func.count(func.distinct(User.id)))
        .join(UserEvent, UserEvent.user_id == User.id)
        .filter(UserEvent.event_type == event_service.FIRST_LOGIN)
        .group_by(User.invite_code_id)
        .all()
        if oid is not None
    }

    synced = {
        oid: int(c or 0)
        for oid, c in db.query(User.invite_code_id, func.count(func.distinct(User.id)))
        .join(DailySport, DailySport.user_id == User.id)
        .filter(DailySport.steps > 0)
        .group_by(User.invite_code_id)
        .all()
        if oid is not None
    }

    codes = db.query(InviteCode).order_by(InviteCode.id.asc()).all()
    items = [
        {
            "invite_id": code.id,
            "invite_name": code.name,
            "invite_code": code.code,
            "scans": scans.get(code.id, 0),
            "onboarded": onboarded.get(code.id, 0),
            "first_logins": first_logins.get(code.id, 0),
            "synced": synced.get(code.id, 0),
        }
        for code in codes
    ]
    return {"items": items}


def get_sync_failures(db: Session, days: int = 7, limit: int = 200) -> Dict:
    """近 N 日同步失败清单（sync_status='failed'）：只读感知，供运营排查重试。

    synced_at 为 UTC 存储，按 UTC 时间窗过滤；total 为窗口内失败总数，items 最多返回 limit 条
    （按最近失败倒序）。批量取组织全名避免 N+1。
    """
    cutoff = datetime.utcnow() - timedelta(days=days)
    base = db.query(DailySport).filter(
        DailySport.sync_status == "failed", DailySport.synced_at >= cutoff
    )
    total = base.count()
    rows = base.order_by(DailySport.synced_at.desc(), DailySport.id.desc()).limit(limit).all()
    if not rows:
        return {"days": days, "total": total, "items": []}

    user_ids = {r.user_id for r in rows}
    users = dict(
        db.query(User.id, User.nickname).filter(User.id.in_(user_ids)).all()
    )
    org_by_user = dict(
        db.query(User.id, User.org_id).filter(User.id.in_(user_ids)).all()
    )
    names = org_service.get_full_name_map(db, list({o for o in org_by_user.values() if o is not None}))
    items = [
        {
            "user_id": r.user_id,
            "nickname": users.get(r.user_id, ""),
            "org_name": names.get(org_by_user.get(r.user_id), ""),
            "date": r.date,
            "fail_reason": r.fail_reason or "",
            "synced_at": r.synced_at,
        }
        for r in rows
    ]
    return {"days": days, "total": total, "items": items}


def get_points_health(db: Session) -> Dict:
    """积分台账健康度：dry-run 全量核对（fix=False，只读不改），返回差异数与样例。

    复用 points_service.recompute_all 的核对逻辑（不提交、不修复），mismatches>0 表示存在错账，
    运营可在「排名洞察 / 积分核对」页执行 fix=True 修复。

    性能（#6）：recompute_all(fix=False) 会全量核对所有用户台账，成本高；此处加进程内短
    TTL 缓存（_HEALTH_TTL 秒），使反复进入页面不重复全量重算；同时对 samples 做 limit
    截断（_HEALTH_SAMPLES_LIMIT），避免大差异集把响应撑大。修复动作（fix=True）后应调用
    invalidate_points_health_cache() 让缓存立即失效。
    """
    now = time.monotonic()
    cached = _POINTS_HEALTH_CACHE["val"]
    if cached is not None and now - _POINTS_HEALTH_CACHE["at"] < _HEALTH_TTL:
        return cached
    result = points_service.recompute_all(db, fix=False)
    samples = result.get("samples") or []
    if len(samples) > _HEALTH_SAMPLES_LIMIT:
        result = {**result, "samples": samples[:_HEALTH_SAMPLES_LIMIT]}
    _POINTS_HEALTH_CACHE["at"] = now
    _POINTS_HEALTH_CACHE["val"] = result
    return result


# 积分健康度进程内短 TTL 缓存（#6）：全量 dry-run 成本高，缓存 _HEALTH_TTL 秒避免每进页面重算。
_HEALTH_TTL = 300.0
_HEALTH_SAMPLES_LIMIT = 20
_POINTS_HEALTH_CACHE: Dict[str, object] = {"at": 0.0, "val": None}


def invalidate_points_health_cache() -> None:
    """失效积分健康度缓存（执行 fix=True 修复或积分台账变更后调用）。"""
    _POINTS_HEALTH_CACHE["at"] = 0.0
    _POINTS_HEALTH_CACHE["val"] = None

