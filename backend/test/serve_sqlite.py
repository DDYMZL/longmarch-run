"""浏览器验收专用：用 SQLite 起一个可登录的后端（本机 openGauss/Docker 未运行）。

仅供 admin 前端人工验收使用，不属于生产代码：
- DATABASE_URL 指向临时 SQLite，启动时 create_all 建表；
- 通过 dns_shim 解析 CloudBase 网关域名（本机 DNS 解析不可用），AI 出题走真实 Agent。

用法：
    cd backend
    python test/serve_sqlite.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.stdout.reconfigure(encoding="utf-8")

DB_PATH = os.path.join(os.path.dirname(__file__), "_serve_ai.db")
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)
os.environ["DATABASE_URL"] = f"sqlite:///{DB_PATH}"
# 验收用临时管理员口令：避免在浏览器里使用 .env 中的真实生产口令
os.environ["ADMIN_PASSWORD"] = "Accept@2026"
# 本机 DNS 解析不可用，测试期用固定映射解析 CloudBase 网关（IP 由 DoH 查询得到）
os.environ["LM_TEST_DNS_MAP"] = (
    "longmarch-run-d5gp70nsd0d2ca307.api.tcloudbasegateway.com=81.69.138.235"
)

import dns_shim  # noqa: E402  必须在导入 app 之前生效

dns_shim.install()

from app.core.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402

Base.metadata.create_all(bind=engine)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8010, log_level="info")
