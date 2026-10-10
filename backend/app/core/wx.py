"""微信平台接口工具：code2Session 与微信运动加密数据解密。

基础设施层，不依赖业务模块；session_key 不落库、不写日志，取到即用即弃。
未配置 WX_APPID/WX_SECRET 时 code2session 返回 None（调用方自行降级）。
"""
import base64
import json
from typing import Optional

import httpx
from Crypto.Cipher import AES

from app.core.config import settings

WX_CODE2SESSION = "https://api.weixin.qq.com/sns/jscode2session"


def code2session(code: str) -> Optional[dict]:
    """用 code 换 openid/unionid/session_key；未配置凭证或换取失败时返回 None。"""
    if not settings.WX_APPID or not settings.WX_SECRET:
        return None
    try:
        resp = httpx.get(
            WX_CODE2SESSION,
            params={
                "appid": settings.WX_APPID,
                "secret": settings.WX_SECRET,
                "js_code": code,
                "grant_type": "authorization_code",
            },
            timeout=5.0,
        )
        data = resp.json()
        if not data.get("openid"):
            return None
        return {
            "openid": data["openid"],
            "unionid": data.get("unionid"),
            "session_key": data.get("session_key"),
        }
    except Exception:
        return None


def decrypt_werun(session_key: str, encrypted_data: str, iv: str) -> dict:
    """AES-128-CBC 解密微信运动数据并校验 watermark；失败抛 ValueError。"""
    try:
        cipher = AES.new(
            base64.b64decode(session_key), AES.MODE_CBC, base64.b64decode(iv)
        )
        raw = cipher.decrypt(base64.b64decode(encrypted_data))
        pad = raw[-1]
        if pad < 1 or pad > 32:
            raise ValueError("padding")
        payload = json.loads(raw[:-pad].decode("utf-8"))
    except Exception:
        raise ValueError("微信运动数据解密失败，请重新同步")
    watermark = payload.get("watermark") or {}
    if watermark.get("appid") != settings.WX_APPID:
        raise ValueError("微信运动数据校验失败，请重新同步")
    return payload
