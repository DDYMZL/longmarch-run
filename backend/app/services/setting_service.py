"""系统键值配置（system_settings）：管理端可改的全局参数读写。"""
from datetime import datetime
from typing import Dict, Iterable, Optional

from sqlalchemy.orm import Session

from app.models.models import SystemSetting


def get_value(db: Session, key: str) -> Optional[str]:
    row = db.query(SystemSetting.setting_value).filter(SystemSetting.setting_key == key).first()
    return row[0] if row else None


def get_values(db: Session, keys: Iterable[str]) -> Dict[str, str]:
    """批量读取多个配置项（单次查询），返回 {key: value}；缺失的键不出现在结果中。"""
    key_list = list(keys)
    if not key_list:
        return {}
    rows = (
        db.query(SystemSetting.setting_key, SystemSetting.setting_value)
        .filter(SystemSetting.setting_key.in_(key_list))
        .all()
    )
    return {k: v for k, v in rows}


def set_value(db: Session, key: str, value: str) -> None:
    """写入配置（不存在则新增），调用方负责提交。"""
    row = db.query(SystemSetting).filter(SystemSetting.setting_key == key).first()
    if row is None:
        db.add(SystemSetting(setting_key=key, setting_value=value, updated_at=datetime.utcnow()))
    else:
        row.setting_value = value
        row.updated_at = datetime.utcnow()


def delete_value(db: Session, key: str) -> bool:
    """删除配置项，使其回到「未覆盖」状态（回退到 env/Settings 默认）。

    返回是否确实删除了记录；不提交，由调用方统一 flush/commit。
    """
    deleted = (
        db.query(SystemSetting)
        .filter(SystemSetting.setting_key == key)
        .delete(synchronize_session=False)
    )
    return bool(deleted)

