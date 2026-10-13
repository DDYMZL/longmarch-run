"""数据库引擎与会话（SQLAlchemy 2.0）。"""
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql.base import PGDialect
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import settings


def _patch_opengauss_version() -> None:
    """兼容 openGauss：其 version() 返回不含 PostgreSQL 标识的版本串，SQLAlchemy 解析会报错。

    背景：openGauss 的 libpq 兼容层把 ``server_version_num`` 报告为 90204（即
    PostgreSQL 9.2.4），而 ``version()`` 返回 ``openGauss x.y.z ...``，SQLAlchemy 的
    PostgreSQL 方言无法从该串解析版本，抛出 "Could not determine version from string"。

    处理：识别到 ``openGauss`` 时直接返回 (9, 2, 4)，其余情况走原生解析。

    风险与边界（保留此补丁的前提）：
    - 该补丁修改的是 ``PGDialect`` 的类方法，属进程级全局；通过下方
      ``startswith("postgresql")`` 收敛为「仅配置 PostgreSQL/openGauss 时生效」，
      SQLite 等场景不触碰方言。
    - 伪造版本号会让 SQLAlchemy 走 9.2 分支，从而关闭窗口函数、``ON CONFLICT``、
      ``JSONB`` 去重等新特性的方言适配；本项目 SQL 均为库内直接执行或基础
      CRUD/聚合（见 services），不依赖上述自动方言特性，故当前安全。
    - 升级 SQLAlchemy 主版本后须回归验证：若官方方言已能解析 openGauss，应删除本补丁。
      验证脚本：``backend/test/s21_opengauss_compat.py``。
    """
    original = PGDialect._get_server_version_info

    def _get_server_version_info(self, connection):  # type: ignore[no-untyped-def]
        version = connection.exec_driver_sql("select pg_catalog.version()").scalar() or ""
        if "openGauss" in version:
            return (9, 2, 4)
        return original(self, connection)

    PGDialect._get_server_version_info = _get_server_version_info


# 仅在使用 PostgreSQL/openGauss 时打补丁，避免影响 SQLite（测试/本地）等其它方言。
if settings.DATABASE_URL.startswith("postgresql"):
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
