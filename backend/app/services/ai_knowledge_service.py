"""AI 知识库服务：知识资料的增删改查、审核状态流转，以及「仅已发布」检索。

- 只有 status='published' 的资料参与问答/讲解检索，草稿与驳回内容绝不下发；
- 检索为关键词匹配（title/content/source），适配管理端人工维护的小规模知识库；
  V1.0 未接入向量语义检索，此为已知取舍，命中不足时上层按「资料不足」处理，不编造；
- 安全：不信任前端传入的 id 越权，所有写操作由路由层校验管理员菜单权限后进入。
"""
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.helpers import now_utc
from app.models.models import AiKnowledge, RouteNode

logger = logging.getLogger(__name__)

ALLOWED_STATUS = ("draft", "pending", "published", "rejected", "archived")
ALLOWED_CATEGORIES = ("event", "route", "figure", "custom")
TITLE_MAX_LEN = 200
SOURCE_MAX_LEN = 300
RELATED_MAX = 10


def _keywords(text: str, limit: int = 12) -> List[str]:
    """从查询文本抽取检索词，兼顾中文无空格分词。

    - 非中文/短中文词（长度 2~4）整体作为关键词（多为专有名词，易精确命中）；
    - 较长中文串（>4 字，通常是整句提问）改取滑动 2-gram，避免整句几乎不可能精确命中；
    - 去标点、去重、限量，供 LIKE 匹配与命中打分。
    """
    cleaned = re.sub(r"[^\w\u4e00-\u9fff]+", " ", text or "")
    out: List[str] = []

    def _add(token: str) -> None:
        if token and token not in out and len(out) < limit:
            out.append(token)

    for seg in cleaned.split():
        has_cjk = re.search(r"[\u4e00-\u9fff]", seg)
        if has_cjk and len(seg) > 4:
            for i in range(len(seg) - 1):
                bigram = seg[i : i + 2]
                if re.fullmatch(r"[\u4e00-\u9fff]{2}", bigram):
                    _add(bigram)
        elif len(seg) >= 2:
            _add(seg)
    return out


def _validate(db: Session, data: Dict[str, Any]) -> Dict[str, Any]:
    """校验并规整写入字段，返回可直接用于构造/更新模型的 dict。"""
    title = str(data.get("title") or "").strip()
    if not title:
        raise ValueError("标题不能为空")
    if len(title) > TITLE_MAX_LEN:
        raise ValueError(f"标题不能超过 {TITLE_MAX_LEN} 字")
    content = str(data.get("content") or "").strip()
    if not content:
        raise ValueError("正文内容不能为空")
    source = str(data.get("source") or "").strip()
    if len(source) > SOURCE_MAX_LEN:
        raise ValueError(f"来源不能超过 {SOURCE_MAX_LEN} 字")

    category = str(data.get("category") or "").strip()
    if category and category not in ALLOWED_CATEGORIES:
        raise ValueError("分类必须为 event/route/figure/custom 或留空")

    related = data.get("related")
    if related in (None, ""):
        related_list: List[str] = []
    elif isinstance(related, list):
        related_list = [str(r).strip() for r in related if str(r).strip()][:RELATED_MAX]
    else:
        raise ValueError("相关问题必须是字符串数组")

    node_id = data.get("node_id")
    if node_id in (None, "", 0):
        node_id = None
    else:
        try:
            node_id = int(node_id)
        except (TypeError, ValueError):
            raise ValueError("节点 ID 非法")
        if db.query(RouteNode.id).filter(RouteNode.id == node_id).first() is None:
            raise ValueError("绑定的路线节点不存在")

    status = str(data.get("status") or "draft").strip()
    if status not in ALLOWED_STATUS:
        raise ValueError("状态非法")

    return {
        "title": title,
        "content": content,
        "source": source or None,
        "related": related_list,
        "category": category or None,
        "node_id": node_id,
        "status": status,
    }


def list_knowledge(
    db: Session,
    page: int = 1,
    page_size: int = 20,
    keyword: str = "",
    status: str = "",
    category: str = "",
    node_id: Optional[int] = None,
) -> Tuple[int, List[AiKnowledge]]:
    """分页查询知识资料（管理端），按更新时间倒序。"""
    query = db.query(AiKnowledge)
    if status:
        query = query.filter(AiKnowledge.status == status)
    if category:
        query = query.filter(AiKnowledge.category == category)
    if node_id:
        query = query.filter(AiKnowledge.node_id == node_id)
    kw = keyword.strip()
    if kw:
        like = f"%{kw}%"
        query = query.filter(
            or_(AiKnowledge.title.like(like), AiKnowledge.content.like(like))
        )
    total = query.count()
    items = (
        query.order_by(AiKnowledge.updated_at.desc(), AiKnowledge.id.desc())
        .offset((max(1, page) - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return total, items


def get_knowledge(db: Session, kid: int) -> Optional[AiKnowledge]:
    return db.query(AiKnowledge).filter(AiKnowledge.id == kid).first()


def create_knowledge(db: Session, data: Dict[str, Any], actor: str) -> AiKnowledge:
    fields = _validate(db, data)
    row = AiKnowledge(created_by=actor, **fields)
    if fields["status"] == "published":
        row.published_at = now_utc()
        row.reviewed_by = actor
    db.add(row)
    db.flush()
    return row


def update_knowledge(db: Session, kid: int, data: Dict[str, Any], actor: str) -> AiKnowledge:
    row = get_knowledge(db, kid)
    if row is None:
        raise ValueError("知识资料不存在")
    fields = _validate(db, data)
    was_published = row.status == "published"
    for key, value in fields.items():
        setattr(row, key, value)
    if fields["status"] == "published" and not was_published:
        row.published_at = now_utc()
        row.reviewed_by = actor
    row.updated_at = now_utc()
    db.flush()
    return row


def set_status(db: Session, kid: int, status: str, actor: str) -> AiKnowledge:
    """审核状态流转；发布时记录 published_at 与审核人。"""
    if status not in ALLOWED_STATUS:
        raise ValueError("状态非法")
    row = get_knowledge(db, kid)
    if row is None:
        raise ValueError("知识资料不存在")
    row.status = status
    if status == "published":
        row.published_at = now_utc()
        row.reviewed_by = actor
    row.updated_at = now_utc()
    db.flush()
    return row


def delete_knowledge(db: Session, kid: int) -> None:
    row = get_knowledge(db, kid)
    if row is None:
        raise ValueError("知识资料不存在")
    db.delete(row)
    db.flush()


def search_published(
    db: Session,
    query_text: str,
    top_k: int,
    category: Optional[str] = None,
) -> List[AiKnowledge]:
    """按关键词检索已发布资料（最多 top_k 条），供问答/讲解拼「参考资料」。

    命中排序：标题命中优先于正文命中，其次按发布时间倒序；无关键词时返回最新已发布若干条。
    """
    top_k = max(1, int(top_k or 1))
    words = _keywords(query_text)
    query = db.query(AiKnowledge).filter(AiKnowledge.status == "published")
    if category:
        query = query.filter(AiKnowledge.category == category)
    if words:
        clauses = []
        for w in words:
            like = f"%{w}%"
            clauses.append(AiKnowledge.title.like(like))
            clauses.append(AiKnowledge.content.like(like))
        query = query.filter(or_(*clauses))
    rows = query.order_by(AiKnowledge.published_at.desc(), AiKnowledge.id.desc()).limit(top_k * 3).all()
    if not words:
        return rows[:top_k]

    def score(row: AiKnowledge) -> int:
        title = row.title or ""
        return sum(1 for w in words if w in title)

    rows.sort(key=lambda r: (score(r), r.published_at or r.created_at), reverse=True)
    return rows[:top_k]


def published_for_node(db: Session, node_id: int) -> List[AiKnowledge]:
    """取绑定某路线节点的已发布资料（route-guide 固定讲解优先源），按发布时间倒序。"""
    return (
        db.query(AiKnowledge)
        .filter(AiKnowledge.node_id == node_id, AiKnowledge.status == "published")
        .order_by(AiKnowledge.published_at.desc(), AiKnowledge.id.desc())
        .all()
    )


def format_sources(rows: List[AiKnowledge]) -> List[Dict[str, Any]]:
    """把知识资料整理为对外「知识来源」结构（不含内部状态/审核人等字段）。"""
    return [
        {"id": r.id, "title": r.title, "source": r.source or "", "category": r.category or ""}
        for r in rows
    ]


def format_context(rows: List[AiKnowledge]) -> str:
    """把知识资料拼成提示词里的「参考资料」段落；无资料返回空串。"""
    if not rows:
        return ""
    blocks = []
    for i, r in enumerate(rows, start=1):
        head = f"【资料{i}】{r.title}"
        if r.source:
            head += f"（来源：{r.source}）"
        blocks.append(f"{head}\n{r.content}")
    return "\n\n".join(blocks)
