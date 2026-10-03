"""每日寄语服务（需求 §16）：后台维护的有出处语录，按日期展示。

展示规则（§16.2）：优先取当天日期的寄语；当天没有时取最近一条不晚于今天的寄语；
一条都没有（含全部在未来）则不展示。寄语可关联路线节点，供前端跳转节点详情。
"""
import re
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.models import DailyQuote, RouteNode

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _to_out(row: DailyQuote, node_names: Dict[int, str]) -> Dict:
    node = None
    if row.node_id is not None and row.node_id in node_names:
        node = {"id": row.node_id, "name": node_names[row.node_id]}
    return {
        "id": row.id,
        "date": row.date,
        "content": row.content,
        "source": row.source,
        "node": node,
    }


def _node_names(db: Session, node_ids: List[int]) -> Dict[int, str]:
    if not node_ids:
        return {}
    rows = db.query(RouteNode.id, RouteNode.name).filter(RouteNode.id.in_(node_ids)).all()
    return {r[0]: r[1] for r in rows}


def get_today(db: Session, today: str) -> Optional[Dict]:
    """今日寄语：精确当天优先，否则最近一条 date <= today 的寄语。"""
    row = (
        db.query(DailyQuote)
        .filter(DailyQuote.date <= today)
        .order_by(DailyQuote.date.desc(), DailyQuote.id.desc())
        .first()
    )
    if row is None:
        return None
    names = _node_names(db, [row.node_id] if row.node_id is not None else [])
    return _to_out(row, names)


# ---------------- 管理端维护 ----------------


def validate_quote(db: Session, date: str, content: str, source: str, node_id: Optional[int]) -> Optional[str]:
    """校验寄语字段，返回错误信息（None 表示通过）。"""
    if not _DATE_RE.match(date or ""):
        return "日期格式须为 YYYY-MM-DD"
    if not (content or "").strip():
        return "寄语内容不能为空"
    if not (source or "").strip():
        return "出处不能为空"
    if node_id is not None and db.query(RouteNode.id).filter(RouteNode.id == node_id).first() is None:
        return "关联节点不存在"
    return None


def list_quotes(db: Session, page: int, page_size: int) -> Tuple[int, List[Dict]]:
    """分页列出寄语（日期倒序）。"""
    query = db.query(DailyQuote)
    total = query.count()
    rows = (
        query.order_by(DailyQuote.date.desc(), DailyQuote.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    names = _node_names(db, [r.node_id for r in rows if r.node_id is not None])
    items = [
        {
            "id": row.id,
            "date": row.date,
            "content": row.content,
            "source": row.source,
            "node_id": row.node_id,
            "node_name": names.get(row.node_id, ""),
        }
        for row in rows
    ]
    return total, items


def create_quote(db: Session, date: str, content: str, source: str, node_id: Optional[int]) -> DailyQuote:
    row = DailyQuote(date=date, content=content.strip(), source=source.strip(), node_id=node_id)
    db.add(row)
    db.commit()
    return row


def update_quote(
    db: Session, quote_id: int, date: str, content: str, source: str, node_id: Optional[int]
) -> Optional[DailyQuote]:
    row = db.query(DailyQuote).filter(DailyQuote.id == quote_id).first()
    if row is None:
        return None
    row.date = date
    row.content = content.strip()
    row.source = source.strip()
    row.node_id = node_id
    db.commit()
    return row


def delete_quote(db: Session, quote_id: int) -> bool:
    row = db.query(DailyQuote).filter(DailyQuote.id == quote_id).first()
    if row is None:
        return False
    db.delete(row)
    db.commit()
    return True


def date_taken(db: Session, date: str, exclude_id: Optional[int] = None) -> bool:
    """同一日期是否已有寄语（唯一约束的友好提示）。"""
    query = db.query(DailyQuote.id).filter(DailyQuote.date == date)
    if exclude_id is not None:
        query = query.filter(DailyQuote.id != exclude_id)
    return query.first() is not None


def get_admin_out(db: Session, row: DailyQuote) -> Dict:
    """单条寄语的管理端输出（补 node_name）。"""
    node_name = ""
    if row.node_id is not None:
        node = db.query(RouteNode.name).filter(RouteNode.id == row.node_id).first()
        node_name = node[0] if node else ""
    return {
        "id": row.id,
        "date": row.date,
        "content": row.content,
        "source": row.source,
        "node_id": row.node_id,
        "node_name": node_name,
    }
