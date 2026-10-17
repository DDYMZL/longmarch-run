"""AI 调用计数与限额：用户日限额 / 全站日限额校验，调用日志落库。

计数口径：ai_usage_logs 中 status='success' 的记录，按 day_key（北京时间当日）统计，
只统计真正完成模型调用的成功记录；失败或被拒不计入限额。
安全：日志只记 user_id/feature/token/耗时/错误码，不含 API Key、JWT 或敏感个人资料。
"""
import logging
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.helpers import today_str
from app.models.models import AiUsageLog
from app.services.ai_config_service import AiConfig

logger = logging.getLogger(__name__)


class AiLimitError(ValueError):
    """超出日调用限额。路由层映射为 429，返回「今日次数已用完」等明确提示。"""


def count_today(db: Session, user_id: Optional[int] = None) -> int:
    """统计当日成功调用数：user_id 非空为该用户，否则为全站。"""
    day = today_str()
    query = db.query(func.count(AiUsageLog.id)).filter(
        AiUsageLog.day_key == day, AiUsageLog.status == "success"
    )
    if user_id is not None:
        query = query.filter(AiUsageLog.user_id == user_id)
    return int(query.scalar() or 0)


def check_limits(db: Session, cfg: AiConfig, user_id: int) -> None:
    """调用前限额校验；超限抛 AiLimitError（用户限额优先，其次全站）。limit<=0 视为不限。"""
    if cfg.chat_daily_limit > 0:
        if count_today(db, user_id) >= cfg.chat_daily_limit:
            raise AiLimitError("今日 AI 提问次数已用完，请明天再来")
    if cfg.global_daily_limit > 0:
        if count_today(db) >= cfg.global_daily_limit:
            raise AiLimitError("当前 AI 使用人数较多，请稍后再试")


def record(
    db: Session,
    *,
    feature: str,
    user_id: Optional[int] = None,
    conversation_id: Optional[int] = None,
    model: Optional[str] = None,
    used_tokens: Optional[int] = None,
    elapsed_ms: Optional[int] = None,
    status: str = "success",
    error_code: Optional[str] = None,
) -> AiUsageLog:
    """写入一条调用日志（不提交，由调用方随业务事务一起 commit）。"""
    row = AiUsageLog(
        user_id=user_id,
        conversation_id=conversation_id,
        feature=feature,
        model=model,
        used_tokens=used_tokens,
        elapsed_ms=elapsed_ms,
        status=status,
        error_code=error_code,
        day_key=today_str(),
    )
    db.add(row)
    return row
