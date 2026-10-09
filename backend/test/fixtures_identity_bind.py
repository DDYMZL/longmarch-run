"""批次5 小程序验收夹具：创建两个 B 场景（身份绑定确认）待用凭证。

绑定请求无对外创建接口（wx_web 渠道阶段2 门控），测试直接经 ORM 落库
（与 s8 测试同法）：token 只存摘要，场景 = B{token}，4 小时有效
（断言套件与截图巡礼两个阶段都要用，10 分钟会在阶段间过期）。
输出 JSON 到 frontend/test/automator/fixtures-identity.json 供 Node 套件读取。
"""
import hashlib
import json
import secrets
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.database import SessionLocal
from app.models.models import BindRequest


def sha256(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def create_bind_scene(db, tag: str) -> str:
    token = "b4test-" + tag + "-" + secrets.token_urlsafe(12)
    db.add(
        BindRequest(
            token_hash=sha256(token),
            user_id=None,
            provider="wx_web",
            app_id="wx-web-b4test",
            openid="o_b4test_" + tag,
            unionid=None,
            status="pending",
            expires_at=datetime.utcnow() + timedelta(hours=4),
        )
    )
    db.commit()
    return "B" + token


def main() -> None:
    db = SessionLocal()
    try:
        b1 = create_bind_scene(db, "assert")
        b2 = create_bind_scene(db, "shots")
        out = {"bindSceneAssert": b1, "bindSceneShots": b2}
        path = r"D:\project\longmarch-run\frontend\test\automator\fixtures-identity.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
        print("B1=", b1)
        print("B2=", b2)
    finally:
        db.close()


if __name__ == "__main__":
    main()
