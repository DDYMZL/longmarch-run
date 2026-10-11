"""系统键值配置（system_settings）：管理端可改的全局参数读写。"""
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.models import SystemSetting


def get_value(db: Session, key: str) -> Optional[str]:
    row = db.query(SystemSetting.setting_value).filter(SystemSetting.setting_key == key).first()
    return row[0] if row else None


def set_value(db: Session, key: str, value: str) -> None:
    """写入配置（不存在则新增），调用方负责提交。"""
    row = db.query(SystemSetting).filter(SystemSetting.setting_key == key).first()
    if row is None:
        db.add(SystemSetting(setting_key=key, setting_value=value, updated_at=datetime.utcnow()))
    else:
        row.setting_value = value
        row.updated_at = datetime.utcnow()
