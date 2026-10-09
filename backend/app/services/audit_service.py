"""审计日志写入服务。

record 只把记录加入当前会话、不提交：调用方在同一事务内完成业务变更与
审计写入后统一 commit，保证「变更 + 审计」原子落库。
"""
import json
from typing import Optional

from sqlalchemy.orm import Session

from app.models.models import AuditLog


def record(
    db: Session,
    actor_type: str,
    actor_user_id: Optional[int],
    action: str,
    target_user_id: Optional[int],
    detail: Optional[object] = None,
) -> None:
    """写入审计日志；detail 为可 JSON 序列化对象或字符串，None 表示无详情。"""
    detail_text: Optional[str] = None
    if detail is not None:
        detail_text = (
            detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)
        )
    db.add(
        AuditLog(
            actor_type=actor_type,
            actor_user_id=actor_user_id,
            action=action,
            target_user_id=target_user_id,
            detail=detail_text,
        )
    )
