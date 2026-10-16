"""测试专用 DNS 兜底：本机无可用 DNS 时，按 DoH 解析结果把域名映射到固定 IP。

仅在显式设置环境变量 LM_TEST_DNS_MAP 时生效（格式 "域名=IP,域名=IP"），
生产代码不依赖本模块，也不得导入本模块。
"""
import os
import socket

_original_getaddrinfo = socket.getaddrinfo
_MAPPING = {}


def _load_mapping() -> None:
    raw = os.getenv("LM_TEST_DNS_MAP", "").strip()
    if not raw:
        return
    for pair in raw.split(","):
        if "=" in pair:
            host, ip = pair.split("=", 1)
            if host.strip() and ip.strip():
                _MAPPING[host.strip()] = ip.strip()


def _patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    if isinstance(host, str) and host in _MAPPING:
        host = _MAPPING[host]
    return _original_getaddrinfo(host, port, family, type, proto, flags)


def install() -> int:
    """安装补丁，返回映射条目数（0 表示未启用，走系统 DNS）。"""
    _load_mapping()
    if _MAPPING:
        socket.getaddrinfo = _patched_getaddrinfo
    return len(_MAPPING)
