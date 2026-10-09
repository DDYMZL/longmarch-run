"""进程内滑动窗口限流（单进程部署适用；多 worker 部署需替换为 Redis）。

仅用于管理端登录与扫码接口的防爆破/防刷，key 取客户端 IP。
"""
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request


class SlidingWindowLimiter:
    """滑动窗口限流器：窗口内超过 max_calls 次即拒绝。"""

    def __init__(self, max_calls: int, window_seconds: int):
        self.max_calls = max_calls
        self.window_seconds = window_seconds
        self._hits: defaultdict = defaultdict(deque)

    def hit(self, key: str) -> bool:
        now = time.time()
        queue = self._hits[key]
        while queue and now - queue[0] > self.window_seconds:
            queue.popleft()
        if len(queue) >= self.max_calls:
            return False
        queue.append(now)
        return True


# 账号登录 10 次/分/IP；扫码会话创建 10 次/分/IP；轮询 60 次/分/IP
login_limiter = SlidingWindowLimiter(max_calls=10, window_seconds=60)
qr_create_limiter = SlidingWindowLimiter(max_calls=10, window_seconds=60)
qr_poll_limiter = SlidingWindowLimiter(max_calls=60, window_seconds=60)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def require_rate(limiter: SlidingWindowLimiter, request: Request, detail: str) -> None:
    """超限时抛 429。"""
    if not limiter.hit(client_ip(request)):
        raise HTTPException(status_code=429, detail=detail)
