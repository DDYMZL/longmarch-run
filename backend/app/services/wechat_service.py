"""微信服务端接口封装：全局 access_token 缓存与小程序码生成。

凭证（access_token）仅存进程内存、过期前 200 秒刷新，不落库、不写日志。
"""
import base64
import time
from typing import Optional

import httpx

from app.core.config import settings

WX_TOKEN_URL = "https://api.weixin.qq.com/cgi-bin/token"
WX_WXACODE_URL = "https://api.weixin.qq.com/wxa/getwxacodeunlimit"

# PC 扫码登录/绑定确认页（scene 由后端生成，页面仅解析展示）
WXACODE_PAGE = "pages/bind/bind"
# 通用入驻码：落地启动页自动登录；scene 仅为渠道标记，不含任何身份信息
ONBOARD_PAGE = "pages/launch/launch"
ONBOARD_SCENE = "src=onboard"

_TOKEN_TTL_SECONDS = 7000  # 微信 access_token 有效期 7200s，提前 200s 刷新
_token_cache: dict = {"token": "", "expires_at": 0.0}
_onboard_image_cache: dict = {}


def _fetch_access_token() -> Optional[str]:
    """获取小程序全局 access_token（进程内缓存）。"""
    now = time.time()
    if _token_cache["token"] and now < _token_cache["expires_at"]:
        return _token_cache["token"]
    if not settings.WX_APPID or not settings.WX_SECRET:
        return None
    try:
        resp = httpx.get(
            WX_TOKEN_URL,
            params={
                "grant_type": "client_credential",
                "appid": settings.WX_APPID,
                "secret": settings.WX_SECRET,
            },
            timeout=5.0,
        )
        token = resp.json().get("access_token")
        if not token:
            return None
        _token_cache["token"] = token
        _token_cache["expires_at"] = now + _TOKEN_TTL_SECONDS
        return token
    except Exception:
        return None


def get_wxacode_png(scene: str, page: str = WXACODE_PAGE) -> Optional[bytes]:
    """生成携带 scene 的小程序码 PNG；未配置凭证或调用失败返回 None（调用方降级 mock）。"""
    token = _fetch_access_token()
    if not token:
        return None
    try:
        resp = httpx.post(
            f"{WX_WXACODE_URL}?access_token={token}",
            json={
                "scene": scene,
                "page": page,
                "check_path": False,
                "env_version": settings.WXACODE_ENV_VERSION,
            },
            timeout=10.0,
        )
    except Exception:
        return None
    if resp.headers.get("content-type", "").startswith("image"):
        return resp.content
    return None


def get_onboarding_image() -> Optional[bytes]:
    """通用入驻小程序码（内容固定，成功结果按版本进程内缓存）。"""
    key = settings.WXACODE_ENV_VERSION
    image = _onboard_image_cache.get(key)
    if image is None:
        image = get_wxacode_png(ONBOARD_SCENE, ONBOARD_PAGE)
        if image is not None:
            _onboard_image_cache[key] = image
    return image


def to_data_url(image: bytes) -> str:
    """按文件头识别格式（微信默认返回 JPEG，is_hyaline 时为 PNG）转 data URL。"""
    mime = "image/png" if image.startswith(b"\x89PNG") else "image/jpeg"
    return f"data:{mime};base64," + base64.b64encode(image).decode("ascii")
