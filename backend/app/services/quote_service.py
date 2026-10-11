"""每日寄语服务（需求 §16、V1.1 功能二）：后台维护的有出处语录，按天循环展示。

循环规则：启用寄语按 (sort_order, id) 升序排列，共 N 条；循环起始日期 start 对应第 1 条。
今日索引 = (today - start).days % N，按日期即时计算，同一天所有用户结果一致，
不依赖定时任务、不受重启影响；today 早于 start 时兜底展示第 1 条；N = 0 时不展示。
增删、启停、调整排序后按最新启用列表重新计算。寄语可关联路线节点，供前端跳转节点详情。
"""
import re
from datetime import date
from typing import Dict, List, Optional, Tuple

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.models import DailyQuote, RouteNode
from app.services import setting_service

CYCLE_START_KEY = "quote_cycle_start"
# 未配置时的兜底起始日期（013 迁移会写入配置，此值仅用于空配置环境）
DEFAULT_CYCLE_START = "2026-10-01"
CONTENT_MAX_LEN = 200
SOURCE_MAX_LEN = 200
SORT_ORDER_MAX = 999999

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_date(value: str) -> Optional[date]:
    """解析 YYYY-MM-DD；格式或日期非法返回 None。"""
    if not _DATE_RE.match(value or ""):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _node_names(db: Session, node_ids: List[int]) -> Dict[int, str]:
    if not node_ids:
        return {}
    rows = db.query(RouteNode.id, RouteNode.name).filter(RouteNode.id.in_(node_ids)).all()
    return {r[0]: r[1] for r in rows}


# ---------------- 循环计算 ----------------


def get_cycle_start(db: Session) -> str:
    return setting_service.get_value(db, CYCLE_START_KEY) or DEFAULT_CYCLE_START


def set_cycle_start(db: Session, start_date: str) -> None:
    if parse_date(start_date) is None:
        raise ValueError("循环起始日期格式须为 YYYY-MM-DD")
    setting_service.set_value(db, CYCLE_START_KEY, start_date)
    db.commit()


def _pick(db: Session, today: str) -> Tuple[Optional[DailyQuote], int, int]:
    """返回 (今日寄语, 索引, 启用总数)；无启用寄语时寄语为 None、索引为 -1。"""
    enabled = db.query(DailyQuote).filter(DailyQuote.is_enabled.is_(True))
    total = enabled.count()
    if total == 0:
        return None, -1, 0
    start = parse_date(get_cycle_start(db)) or date.fromisoformat(DEFAULT_CYCLE_START)
    days = (date.fromisoformat(today) - start).days
    index = days % total if days >= 0 else 0
    row = enabled.order_by(DailyQuote.sort_order.asc(), DailyQuote.id.asc()).offset(index).limit(1).first()
    return row, index, total


def get_today(db: Session, today: str) -> Optional[Dict]:
    """今日寄语（date 为当天业务日期）；没有启用寄语时返回 None。"""
    row, _, _ = _pick(db, today)
    if row is None:
        return None
    node = None
    if row.node_id is not None:
        name = _node_names(db, [row.node_id]).get(row.node_id)
        if name:
            node = {"id": row.node_id, "name": name}
    return {"id": row.id, "date": today, "content": row.content, "source": row.source, "node": node}


def get_cycle_info(db: Session, today: str) -> Dict:
    """管理端循环概览：起始日期、启用条数、今日寄语 id 与其在循环中的序号（从 1 起）。"""
    row, index, total = _pick(db, today)
    return {
        "start_date": get_cycle_start(db),
        "enabled_count": total,
        "today_quote_id": row.id if row else None,
        "today_position": index + 1 if row else 0,
    }


# ---------------- 管理端维护 ----------------


def check_fields(content: str, source: str, sort_order: int) -> Optional[str]:
    """校验寄语文本与排序号（不查库），返回错误信息（None 表示通过）。"""
    if not (content or "").strip():
        return "寄语内容不能为空"
    if len(content.strip()) > CONTENT_MAX_LEN:
        return f"寄语内容不能超过 {CONTENT_MAX_LEN} 字"
    if not (source or "").strip():
        return "出处不能为空"
    if len(source.strip()) > SOURCE_MAX_LEN:
        return f"出处不能超过 {SOURCE_MAX_LEN} 字"
    if not 0 <= sort_order <= SORT_ORDER_MAX:
        return f"排序号须为 0~{SORT_ORDER_MAX} 的整数"
    return None


def validate_quote(db: Session, content: str, source: str, sort_order: int, node_id: Optional[int]) -> Optional[str]:
    """校验寄语字段与关联节点，返回错误信息（None 表示通过）。"""
    error = check_fields(content, source, sort_order)
    if error:
        return error
    if node_id is not None and db.query(RouteNode.id).filter(RouteNode.id == node_id).first() is None:
        return "关联节点不存在"
    return None


def _admin_item(row: DailyQuote, node_name: str) -> Dict:
    return {
        "id": row.id,
        "content": row.content,
        "source": row.source,
        "sort_order": row.sort_order,
        "is_enabled": row.is_enabled,
        "node_id": row.node_id,
        "node_name": node_name,
    }


def list_quotes(db: Session, page: int, page_size: int, keyword: str = "") -> Tuple[int, List[Dict]]:
    """分页列出寄语（按循环顺序 sort_order、id 升序）；keyword 按内容/出处模糊匹配。"""
    query = db.query(DailyQuote)
    word = keyword.strip()
    if word:
        query = query.filter(
            or_(
                DailyQuote.content.contains(word, autoescape=True),
                DailyQuote.source.contains(word, autoescape=True),
            )
        )
    total = query.count()
    rows = (
        query.order_by(DailyQuote.sort_order.asc(), DailyQuote.id.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    names = _node_names(db, [r.node_id for r in rows if r.node_id is not None])
    return total, [_admin_item(row, names.get(row.node_id, "")) for row in rows]


def create_quote(db: Session, data: Dict) -> DailyQuote:
    row = DailyQuote(
        content=data["content"].strip(),
        source=data["source"].strip(),
        sort_order=data["sort_order"],
        is_enabled=data["is_enabled"],
        node_id=data["node_id"],
    )
    db.add(row)
    db.commit()
    return row


def update_quote(db: Session, quote_id: int, data: Dict) -> Optional[DailyQuote]:
    row = db.query(DailyQuote).filter(DailyQuote.id == quote_id).first()
    if row is None:
        return None
    row.content = data["content"].strip()
    row.source = data["source"].strip()
    row.sort_order = data["sort_order"]
    row.is_enabled = data["is_enabled"]
    row.node_id = data["node_id"]
    db.commit()
    return row


def delete_quote(db: Session, quote_id: int) -> bool:
    row = db.query(DailyQuote).filter(DailyQuote.id == quote_id).first()
    if row is None:
        return False
    db.delete(row)
    db.commit()
    return True


def get_admin_out(db: Session, row: DailyQuote) -> Dict:
    """单条寄语的管理端输出（补 node_name）。"""
    names = _node_names(db, [row.node_id] if row.node_id is not None else [])
    return _admin_item(row, names.get(row.node_id, ""))
