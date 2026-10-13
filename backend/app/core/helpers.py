"""通用工具：日期处理、Mock 步数生成（迁移自前端 utils/util.js）。

业务日期与活动时间统一按北京时间（Asia/Shanghai，固定 UTC+8、无夏令时）计算，
不依赖服务器本地时区（Windows 无 tzdata，故用固定偏移而非 zoneinfo）；库内时间列仍按 UTC naive 存储。
"""
from datetime import datetime, timedelta, timezone
from typing import List, Optional

BEIJING_TZ = timezone(timedelta(hours=8))


def now_utc() -> datetime:
    """当前 UTC naive 时间（与库内时间列同口径）。"""
    return datetime.utcnow()


def now_beijing() -> datetime:
    """当前北京时间 naive。"""
    return datetime.now(BEIJING_TZ).replace(tzinfo=None)


def today_str() -> str:
    """北京时间当日日期字符串 YYYY-MM-DD（每日步数/答题/积分的自然日口径）。"""
    return now_beijing().strftime("%Y-%m-%d")


def recent_dates(n: int) -> List[str]:
    """最近 n 天日期（含今天，从旧到新）。"""
    today = now_beijing().date()
    return [(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(n - 1, -1, -1)]


def to_local(dt: Optional[datetime]) -> Optional[datetime]:
    """库内 naive 时间（UTC 存储）转北京时间 naive；None 透传。"""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).astimezone(BEIJING_TZ).replace(tzinfo=None)


def local_to_utc(dt: datetime) -> datetime:
    """北京时间 naive（或带时区时间）转 UTC naive（与库内 UTC 存储列比较用）。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BEIJING_TZ)
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def seeded_steps(date_str: str, user_id: int) -> int:
    """基于「日期 + 用户」生成稳定伪随机步数（4000~12999）。

    迁移自前端 util.seededSteps：同一天同一用户结果一致。
    仅开发模式兜底：mock 登录用户或未配置微信凭证时由 /sport/sync 回退使用；
    真实微信用户步数一律来自 wx.getWeRunData 解密，不得使用本函数编造。
    """
    key = f"{date_str}|{user_id}"
    seed = 0
    for ch in key:
        seed = (seed * 31 + ord(ch)) % 100000
    return 4000 + (seed % 9000)
