"""通用工具：日期处理、Mock 步数生成（迁移自前端 utils/util.js）。"""
from datetime import datetime, timedelta, timezone
from typing import List, Optional


def today_str() -> str:
    """本地日期字符串 YYYY-MM-DD。"""
    return datetime.now().strftime("%Y-%m-%d")


def recent_dates(n: int) -> List[str]:
    """最近 n 天日期（含今天，从旧到新）。"""
    today = datetime.now().date()
    return [(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(n - 1, -1, -1)]


def to_local(dt: Optional[datetime]) -> Optional[datetime]:
    """库内 naive 时间（UTC 存储）转本地 naive 时间；None 透传。"""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None)


def local_to_utc(dt: datetime) -> datetime:
    """本地 naive 时间转 UTC naive 时间（与库内 UTC 存储列比较用）。

    naive datetime 调用 astimezone 时按本地时区解释，恰好符合入参语义。
    """
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
