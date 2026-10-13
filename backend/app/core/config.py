"""应用配置：基于 pydantic-settings，从环境变量 / .env 读取。"""
from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict

# .env 锚定到 backend 根目录，不依赖启动时的工作目录（本地 run.py 与服务器
# uvicorn/systemd 从不同 cwd 启动都能读到同一份配置）。
_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE, env_file_encoding="utf-8", extra="ignore"
    )

    # 应用
    APP_NAME: str = "长征运动挑战 API"
    API_PREFIX: str = "/api"
    DEBUG: bool = True

    # 数据库（openGauss 兼容 PostgreSQL 协议，使用 psycopg2 驱动）
    # 必填：不提供任何默认连接串，缺失时启动即报错，避免回退到错误/过期的库或泄露内置凭证。
    # 本地开发模板见 backend/.env.example；生产由部署环境注入（systemd EnvironmentFile / 环境变量）。
    DATABASE_URL: str

    # JWT
    JWT_SECRET: str = "longmarch-dev-secret-change-me-please"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 10080  # 用户令牌 7 天
    JWT_ADMIN_EXPIRE_MINUTES: int = 720  # 管理员令牌 12 小时（权限每次请求查库，短时效兜底）

    # 微信小程序凭证（留空则登录使用 mock openid，便于本地开发调试）
    WX_APPID: str = ""
    WX_SECRET: str = ""
    # 仅限本地自动化测试：已配置凭证时微信换取失败仍回退 mock openid；生产必须为 false
    WX_LOGIN_ALLOW_MOCK: bool = False

    # 微信开放平台网站应用凭证（扫码登录渠道阶段2；留空则该渠道禁用）
    WX_WEB_APPID: str = ""
    WX_WEB_SECRET: str = ""

    # 小程序码环境版本：开发期 trial（体验版，扫码者须为体验成员）；生产发布后改 release
    WXACODE_ENV_VERSION: str = "trial"

    # 扫码登录会话 / 身份绑定请求有效期（秒）
    QR_LOGIN_TTL_SECONDS: int = 300
    BIND_REQUEST_TTL_SECONDS: int = 600

    # 管理后台（admin 前端项目）登录账号；密码未配置时账号登录禁用，仅允许微信扫码登录
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str = ""

    # 组织架构外部同步接口地址（留空时同步使用内置种子数据，便于开发调试）
    ORG_SYNC_API_URL: str = ""

    # 长征活动规则
    STRIDE_M: float = 0.7  # 平均步长（米），估算距离(km) = 步数 × 步长 / 1000
    STREAK_GOAL_STEPS: int = 5000  # 连续行军每日达标步数（当天达到即计入连续行军）
    ACTIVITY_START_DATE: str = "2026-09-01"  # 活动起始日（答题「第 N 期」等的基准）
    QUIZ_QUESTION_SECONDS: int = 90  # 每题作答时限（秒，按服务器时间计）
    QUIZ_ANSWER_GRACE_SECONDS: int = 2  # 截止后容许的网络延迟（秒），仅用于接收提交
    ACTIVITY_MASK_NICKNAME: bool = False  # 实时行动态昵称脱敏（需求 §8.5，开启后对外动态展示如「王*明」）

    # 积分规则（V2.0）：总积分 = 步行积分 + 答题积分
    POINTS_WALK_STEP_CAP: int = 20000  # 单日计分步数上限
    POINTS_WALK_STEPS_PER_POINT: int = 1000  # 每满多少步得 1 分（不足不计）
    POINTS_QUIZ_PER_CORRECT: int = 2  # 每答对 1 题得分
    POINTS_QUIZ_DAILY_CAP: int = 10  # 单日答题积分上限

    # 跨域来源
    CORS_ORIGINS: List[str] = ["*"]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
