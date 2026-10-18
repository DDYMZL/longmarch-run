"""头像上传与静态资源落盘服务（点2）。

用户头像（/auth/avatar）与管理端人物头像（/admin/persons/avatar）共用同一套
校验与落盘逻辑：文件写入 settings.AVATAR_DIR 下 avatars/YYYY/MM/{uuid}.{ext}，
对外通过 app.mount("/uploads", StaticFiles) 暴露，返回绝对 URL 入库。

约定：
- 仅接受 jpg/jpeg/png/webp；大小上限 settings.AVATAR_MAX_BYTES；
- 覆盖式更新，写库成功后清理被替换的旧本站头像文件（#22，仅限本站 /uploads/avatars/ 前缀）；
- 上传经 read_within_limit 分块读取，累计超限立即中断，不整块入内存（#5，防内存放大 DoS）；
- PUBLIC_BASE_URL 留空时入库相对路径 /uploads/...，由前端按当前站点拼接（#4，杜绝用可控
  Host 头拼绝对地址）；生产须配置公网域名，否则他人加载头像会因相对地址失败。
"""
import os
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.models import Person, User

# 允许的头像扩展名（小写，不含点）
ALLOWED_EXTS = {"jpg", "jpeg", "png", "webp"}
# 静态服务挂载前缀（与 main.py app.mount 保持一致）
UPLOAD_URL_PREFIX = "/uploads"


class UploadError(ValueError):
    """上传校验失败（类型/大小/空文件），路由层转 400。"""


# 分块读取步长（#5）：累计超限即中断，避免整块 await file.read() 把超大文件全量入内存。
_READ_CHUNK = 64 * 1024


async def read_within_limit(file) -> bytes:
    """分块读取上传文件，累计超过 AVATAR_MAX_BYTES 立即中断抛 UploadError（防内存放大 DoS）。

    优先用 Starlette 提供的 file.size（若可用）做前置快速拒绝；随后仍按 64KB 分块累加，
    一旦越界立即停止读取并抛错，绝不先全量读入内存再校验。
    """
    limit = settings.AVATAR_MAX_BYTES
    size = getattr(file, "size", None)
    if size is not None and size > limit:
        raise UploadError(f"图片大小不能超过 {limit / (1024 * 1024):g}MB")
    chunks = []
    total = 0
    while True:
        chunk = await file.read(_READ_CHUNK)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise UploadError(f"图片大小不能超过 {limit / (1024 * 1024):g}MB")
        chunks.append(chunk)
    return b"".join(chunks)


def _validate(filename: Optional[str], content: bytes) -> str:
    """校验扩展名与大小，返回规范化小写扩展名；不合法抛 UploadError。"""
    ext = os.path.splitext(filename or "")[1].lstrip(".").lower()
    if ext not in ALLOWED_EXTS:
        raise UploadError("仅支持 jpg / jpeg / png / webp 格式的图片")
    if not content:
        raise UploadError("上传文件为空")
    if len(content) > settings.AVATAR_MAX_BYTES:
        limit_mb = settings.AVATAR_MAX_BYTES / (1024 * 1024)
        raise UploadError(f"图片大小不能超过 {limit_mb:g}MB")
    return ext


def _public_base_url(request_base_url: Optional[str] = None) -> str:
    """对外站点基址：仅取 settings.PUBLIC_BASE_URL；为空则返回空串（入库相对 URL）。

    安全（#4）：不再回退到 request.base_url——Host 头由客户端可控，用它拼绝对地址
    会把攻击者域名固化进库并可能触发 SSRF/钓鱼；PUBLIC_BASE_URL 为空时存相对路径
    /uploads/...，由前端按当前站点拼接。request_base_url 参数保留仅为兼容旧调用签名。
    """
    return (settings.PUBLIC_BASE_URL or "").rstrip("/")


def _store(content: bytes, ext: str) -> str:
    """按 avatars/YYYY/MM/{uuid}.{ext} 落盘，返回相对 /uploads 挂载根的路径。"""
    now = datetime.now()
    year, month = f"{now:%Y}", f"{now:%m}"
    abs_dir = os.path.join(settings.AVATAR_DIR, year, month)
    os.makedirs(abs_dir, exist_ok=True)
    name = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(abs_dir, name), "wb") as fp:
        fp.write(content)
    return f"avatars/{year}/{month}/{name}"


def _build_url(rel_path: str, request_base_url: Optional[str]) -> str:
    """拼接对外绝对 URL：{base}/uploads/{rel_path}。"""
    return f"{_public_base_url(request_base_url)}{UPLOAD_URL_PREFIX}/{rel_path}"


def _cleanup_old_avatar(old_url: Optional[str]) -> None:
    """写库成功后清理旧本站头像文件（#22）。

    仅当旧 avatar 命中本站 {UPLOAD_URL_PREFIX}/avatars/ 前缀，且解析出的真实路径
    （realpath）落在 AVATAR_DIR 内时才删除；外链或路径穿越一律跳过，删除失败静默忽略。
    """
    if not old_url:
        return
    marker = f"{UPLOAD_URL_PREFIX}/avatars/"
    idx = old_url.find(marker)
    if idx < 0:
        return
    rel = old_url[idx + len(UPLOAD_URL_PREFIX) + 1:].split("?", 1)[0]
    avatar_root = os.path.realpath(settings.AVATAR_DIR)
    target = os.path.realpath(os.path.join(settings.UPLOAD_ROOT, rel))
    if not target.startswith(avatar_root + os.sep):
        return
    if os.path.isfile(target):
        try:
            os.remove(target)
        except OSError:
            pass


def save_avatar(
    db: Session,
    user: User,
    content: bytes,
    filename: Optional[str],
    request_base_url: Optional[str] = None,
) -> str:
    """保存用户头像：落盘 -> 写 user.avatar -> commit，返回绝对/相对 URL。

    写库成功后清理被替换掉的旧本站头像文件（#22），避免 uploads 目录无限膨胀。
    """
    ext = _validate(filename, content)
    url = _build_url(_store(content, ext), request_base_url)
    old_avatar = user.avatar
    user.avatar = url
    db.commit()
    db.refresh(user)
    _cleanup_old_avatar(old_avatar)
    return url


def save_person_avatar(
    db: Session,
    content: bytes,
    filename: Optional[str],
    request_base_url: Optional[str] = None,
    person: Optional[Person] = None,
) -> str:
    """保存人物头像：落盘并返回绝对 URL。

    person 为空时仅落盘返回 URL（管理端先拿 URL 再随人物表单提交 CRUD）；
    传入 person 时同时写入其 avatar 字段并提交。
    """
    ext = _validate(filename, content)
    url = _build_url(_store(content, ext), request_base_url)
    if person is not None:
        person.avatar = url
        db.commit()
        db.refresh(person)
    return url
