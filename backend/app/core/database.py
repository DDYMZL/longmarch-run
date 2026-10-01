"""数据库引擎与会话（SQLAlchemy 2.0）。"""
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql.base import PGDialect
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import settings


def _patch_opengauss_version() -> None:
    """兼容 openGauss：其 version() 返回不含 PostgreSQL 标识的版本串，SQLAlchemy 解析会报错。

    openGauss 的 libpq 兼容报告 server_version=90204（即 PostgreSQL 9.2.4），
    识别到 openGauss 时直接返回 (9, 2, 4)，其余情况走原生解析。
    """
    original = PGDialect._get_server_version_info

    def _get_server_version_info(self, connection):  # type: ignore[no-untyped-def]
        version = connection.exec_driver_sql("select pg_catalog.version()").scalar() or ""
        if "openGauss" in version:
            return (9, 2, 4)
        return original(self, connection)

    PGDialect._get_server_version_info = _get_server_version_info


_patch_opengauss_version()

_connect_args = {}
if settings.DATABASE_URL.startswith("sqlite"):
    # SQLite 默认禁用跨线程访问，FastAPI 在多线程下需关闭该限制
    _connect_args = {"check_same_thread": False}

engine = create_engine(settings.DATABASE_URL, connect_args=_connect_args, echo=False)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。"""


def get_db() -> Generator[Session, None, None]:
    """FastAPI 依赖：提供请求级数据库会话。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
