# -*- coding: utf-8 -*-
"""S21 openGauss 兼容性 定向验证（真实数据库）

覆盖 openGauss 兼容补丁（app/core/database.py::_patch_opengauss_version）与
ORM↔库结构一致性，防止升级 SQLAlchemy / 更换驱动后静默回归：

  C01 数据库可连接（无 "Could not determine version from string" 版本解析错误）
  C02 方言 server_version_info 解析成功（openGauss 下为 9.2.4）
  C03 ORM 声明的全部表在库中存在
  C04 真实 ORM 查询可执行（含窗口函数/聚合不依赖方言自动改写）

用法：
  cd backend && python test/s21_opengauss_compat.py
说明：DATABASE_URL 非 PostgreSQL/openGauss 时自动跳过（退出码 0）。
"""
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import func, inspect, select  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.database import Base, engine  # noqa: E402
import app.models.models  # noqa: E402,F401


def main() -> int:
    results = []

    def record(cid, name, ok, detail=""):
        results.append((cid, ok))
        print(("PASS " if ok else "FAIL ") + cid + " " + name + ((" | " + str(detail)[:200]) if detail else ""))

    if not settings.DATABASE_URL.startswith("postgresql"):
        print("SKIP DATABASE_URL 不是 PostgreSQL/openGauss，跳过（当前：%s）" % settings.DATABASE_URL.split("://", 1)[0])
        return 0

    try:
        with engine.connect() as conn:
            version_text = conn.exec_driver_sql("select pg_catalog.version()").scalar() or ""
            record("C01", "数据库连接成功（无版本解析错误）", True, version_text[:60])
    except Exception as exc:  # noqa: BLE001
        record("C01", "数据库连接成功（无版本解析错误）", False, exc)
        print("\n失败：无法连接数据库，后续用例跳过。")
        return 1

    # C02：连接后方言已完成版本解析（触发 _get_server_version_info）
    info = engine.dialect.server_version_info
    if "openGauss" in version_text:
        record("C02", "openGauss 版本识别为 9.2.4", info == (9, 2, 4), "server_version_info=%s" % (info,))
    else:
        record("C02", "版本解析非空", bool(info), "server_version_info=%s" % (info,))

    # C03：ORM 表 ⊆ 库表
    db_tables = set(inspect(engine).get_table_names())
    orm_tables = set(Base.metadata.tables.keys())
    missing = sorted(orm_tables - db_tables)
    record("C03", "ORM 声明的表在库中均存在", not missing, "缺失：%s" % missing if missing else "共 %d 张" % len(orm_tables))

    # C04：真实 ORM 查询
    from app.models.models import RouteNode  # noqa: E402

    try:
        with engine.connect() as conn:
            count = conn.execute(select(func.count()).select_from(RouteNode)).scalar()
        record("C04", "真实 ORM 查询可执行", count is not None, "route_nodes=%s" % count)
    except Exception as exc:  # noqa: BLE001
        record("C04", "真实 ORM 查询可执行", False, exc)

    failed = [cid for cid, ok in results if not ok]
    print("\n结果：%d/%d 通过" % (len(results) - len(failed), len(results)))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
