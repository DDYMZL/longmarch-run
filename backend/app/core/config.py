"""应用配置：基于 pydantic-settings，从环境变量 / .env 读取。"""
from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # 应用
    APP_NAME: str = "长征运动挑战 API"
    API_PREFIX: str = "/api"
    DEBUG: bool = True

    # 数据库（openGauss 兼容 PostgreSQL 协议，使用 psycopg2 驱动）
    DATABASE_URL: str = "postgresql+psycopg2://gaussdb:LongMarch%40123@127.0.0.1:5118/longmarch"

    # JWT
    JWT_SECRET: str = "longmarch-dev-secret-change-me-please"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 10080  # 7 天

    # 微信小程序凭证（留空则登录使用 mock openid，便于本地开发调试）
    WX_APPID: str = ""
    WX_SECRET: str = ""

    # 管理后台（admin 前端项目）登录账号
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str = "112233"

    # 组织架构外部同步接口地址（留空时同步使用内置种子数据，便于开发调试）
    ORG_SYNC_API_URL: str = ""

    # 长征活动规则
    STRIDE_M: float = 0.7  # 平均步长（米），估算距离(km) = 步数 × 步长 / 1000
    STREAK_GOAL_STEPS: int = 5000  # 连续行军每日达标步数（当天达到即计入连续行军）
    ACTIVITY_START_DATE: str = "2026-09-01"  # 活动起始日（答题「第 N 期」等的基准）

    # 跨域来源
    CORS_ORIGINS: List[str] = ["*"]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
