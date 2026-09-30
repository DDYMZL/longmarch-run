"""FastAPI 应用入口：初始化数据库与种子数据、注册中间件与全部路由。

启动：
    cd backend
    pip install -r requirements.txt
    python run.py                 # 或 uvicorn app.main:app --reload
接口文档：
    http://127.0.0.1:8000/docs    (Swagger UI)
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import auth, march, medal, org, points, quiz, rank, sport
from app.core.config import settings
from app.core.database import SessionLocal, init_db
from app.data.seed import init_seed


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动：建表 + 写入静态种子数据（均幂等）。"""
    init_db()
    db = SessionLocal()
    try:
        init_seed(db)
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
app.include_router(auth.router, prefix=_prefix)
app.include_router(sport.router, prefix=_prefix)
app.include_router(march.router, prefix=_prefix)
app.include_router(quiz.router, prefix=_prefix)
app.include_router(points.router, prefix=_prefix)
app.include_router(medal.router, prefix=_prefix)
app.include_router(org.router, prefix=_prefix)
app.include_router(rank.router, prefix=_prefix)


@app.get("/", tags=["health"], summary="健康检查")
def health():
    return {"status": "ok", "app": settings.APP_NAME, "docs": "/docs"}
