"""通用工具：日期处理、Mock 步数生成（迁移自前端 utils/util.js）。"""
from datetime import datetime, timedelta
from typing import List


def today_str() -> str:
    """本地日期字符串 YYYY-MM-DD。"""
    return datetime.now().strftime("%Y-%m-%d")


def recent_dates(n: int) -> List[str]:
    """最近 n 天日期（含今天，从旧到新）。"""
    today = datetime.now().date()
    return [(today - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(n - 1, -1, -1)]


def seeded_steps(date_str: str, user_id: int) -> int:
    """基于「日期 + 用户」生成稳定伪随机步数（4000~12999）。

    迁移自前端 util.seededSteps：同一天同一用户结果一致，
    用于未接入真实微信运动数据时模拟每日步数。
    """
    key = f"{date_str}|{user_id}"
    seed = 0
    for ch in key:
        seed = (seed * 31 + ord(ch)) % 100000
    return 4000 + (seed % 9000)
