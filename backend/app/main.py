"""FastAPI 应用入口：初始化种子数据、注册中间件与全部路由。

启动：
    cd backend
    pip install -r requirements.txt
    python run.py                 # 或 uvicorn app.main:app --reload
接口文档：
    http://127.0.0.1:8010/docs    (Swagger UI)
"""
from contextlib import asynccontextmanager

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import (
    activity,
    admin,
    ai,
    ai_admin,
    auth,
    broadcast,
    identity,
    march,
    medal,
    org,
    persons,
    points,
    profile,
    quiz,
    quotes,
    rank,
    sport,
    ws,
)
from app.core.config import settings
from app.core.database import SessionLocal
from app.data.seed import init_seed
from app.services import points_service, streak_service


def _assert_upload_layout() -> None:
    """启动安全断言：AVATAR_DIR 在 UPLOAD_ROOT 内；UPLOAD_ROOT 不是项目根/不含 .env。

    防止运维将 UPLOAD_ROOT 配错导致 /uploads 直接暴露项目根（包括 .env 凭证）。
    """
    root = Path(settings.UPLOAD_ROOT).resolve()
    avatar = Path(settings.AVATAR_DIR).resolve()
    backend_root = Path(__file__).resolve().parents[1]
    repo_root = Path(__file__).resolve().parents[2]
    if not avatar.is_relative_to(root):
        raise RuntimeError(
            f"AVATAR_DIR({avatar}) 必须位于 UPLOAD_ROOT({root}) 内"
        )
    if root == backend_root or root == repo_root:
        raise RuntimeError(
            f"UPLOAD_ROOT({root}) 不能是项目根目录，须为独立上传子目录"
        )
    if (root / ".env").exists() or (root / ".env.prod").exists():
        raise RuntimeError(
            f"UPLOAD_ROOT({root}) 下不得包含 .env 文件，疑似指向了项目根"
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动：确保上传目录存在，幂等写入种子数据，并以运动源数据修复派生统计。"""
    _assert_upload_layout()
    os.makedirs(settings.UPLOAD_ROOT, exist_ok=True)
    os.makedirs(settings.AVATAR_DIR, exist_ok=True)
    db = SessionLocal()
    try:
        init_seed(db)
        streak_service.recompute_all(db)
        points_service.recompute_walk_all(db, fix=True)
    finally:
        db.close()
    yield


app = FastAPI(
    title=settings.APP_NAME,
    description="长征主题运动与每日答题小程序后端 API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=False,  # 鉴权走 Authorization 头，无需 cookie 凭据
    allow_methods=["*"],
    allow_headers=["*"],
)

_prefix = settings.API_PREFIX
# 静态资源：把独立配置的上传根目录 UPLOAD_ROOT（默认 backend/uploads）挂到 /uploads，
# 与 /api 平级，供小程序 <image> 直接加载头像等文件。挂载点由 UPLOAD_ROOT 决定，
# 不再从 AVATAR_DIR 反推父级，避免误配导致暴露项目根（启动时 _assert_upload_layout 兜底校验）。
_UPLOAD_ROOT = str(Path(settings.UPLOAD_ROOT).resolve())
os.makedirs(_UPLOAD_ROOT, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=_UPLOAD_ROOT), name="uploads")

app.include_router(activity.router, prefix=_prefix)
app.include_router(auth.router, prefix=_prefix)
app.include_router(identity.router, prefix=_prefix)
app.include_router(sport.router, prefix=_prefix)
app.include_router(march.router, prefix=_prefix)
app.include_router(quiz.router, prefix=_prefix)
app.include_router(ai.router, prefix=_prefix)
app.include_router(points.router, prefix=_prefix)
app.include_router(medal.router, prefix=_prefix)
app.include_router(org.router, prefix=_prefix)
app.include_router(rank.router, prefix=_prefix)
app.include_router(profile.router, prefix=_prefix)
app.include_router(persons.router, prefix=_prefix)
app.include_router(quotes.router, prefix=_prefix)
app.include_router(broadcast.router, prefix=_prefix)
app.include_router(ws.router, prefix=_prefix)
app.include_router(admin.router, prefix=_prefix)
app.include_router(ai_admin.router, prefix=_prefix)


@app.get("/", tags=["health"], summary="健康检查")
def health():
    return {"status": "ok", "app": settings.APP_NAME, "docs": "/docs"}
