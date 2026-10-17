"""应用配置：基于 pydantic-settings，从环境变量 / .env（或 .env.prod）读取。"""
import os
from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict

# env 文件锚定到 backend 根目录，不依赖启动时的工作目录（本地 run.py 与服务器
# uvicorn/systemd 从不同 cwd 启动都能读到同一份配置）。
_ENV_DIR = Path(__file__).resolve().parents[2]
# APP_ENV 只从系统环境变量读取（env 文件选择发生在解析 .env 之前，写进 .env 不生效）：
# prod 时加载生产配置 .env.prod，其余情况加载本地开发配置 .env。两份文件均已入库。
_APP_ENV = os.getenv("APP_ENV", "").strip().lower()
_ENV_FILE = _ENV_DIR / (".env.prod" if _APP_ENV == "prod" else ".env")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE, env_file_encoding="utf-8", extra="ignore"
    )

    # 应用
    APP_NAME: str = "长征运动挑战 API"
    API_PREFIX: str = "/api"
    DEBUG: bool = True
    # 运行环境标识：prod 生产（加载 .env.prod），其余为本地开发（加载 .env）
    APP_ENV: str = "dev"

    # 数据库（openGauss 兼容 PostgreSQL 协议，使用 psycopg2 驱动）
    # 必填：不提供任何默认连接串，缺失时启动即报错，避免回退到错误/过期的库或泄露内置凭证。
    # 本地开发配置在 backend/.env（模板 backend/.env.example）；生产配置在 backend/.env.prod
    # （APP_ENV=prod 时加载，生产库地址与强密码部署前须替换为服务器真实值）。
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

    # 腾讯云 CloudBase Agent（管理后台 AI 出题）
    # API Key 仅供后端调用，禁止写入前端代码、接口响应或日志。
    CLOUDBASE_ENV_ID: str = ""
    CLOUDBASE_AGENT_ID: str = ""
    CLOUDBASE_API_KEY: str = ""
    # ACP 调用地址；留空时按「https://{ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/{AGENT_ID}/acp」拼接
    CLOUDBASE_AGENT_URL: str = ""
    CLOUDBASE_TIMEOUT_SECONDS: int = 180  # 单批调用超时（秒）

    # AI 出题生成策略：总量拆成多批并发调用，规避单次长回复被截断
    AI_QUESTION_BATCH_SIZE: int = 10  # 每批请求 Agent 生成的题数
    AI_QUESTION_MAX_CONCURRENCY: int = 3  # 批间并发上限
    AI_QUESTION_MAX_COUNT: int = 100  # 单次生成 / 单次保存的题数上限

    # AI 智能中心（历史助手 / 路线讲解 / 答题解析）运行时默认值。
    # 以下为 .env 初始默认；管理端「配置中心」可在 system_settings 中逐项覆盖，
    # 生效值由 ai_config_service.get_effective(db) 合并（DB 覆盖 > env 默认）。
    AI_ENABLED: bool = True  # AI 总开关；关闭后所有 AI 接口返回明确提示，不影响其它业务
    AI_CHAT_DAILY_LIMIT: int = 10  # 普通用户每天最多模型调用次数（按北京时间当日）
    AI_GLOBAL_DAILY_LIMIT: int = 2000  # 全站每天模型调用上限（防成本失控）
    AI_MAX_INPUT_CHARS: int = 500  # 单次用户输入最大字符数
    AI_MAX_OUTPUT_TOKENS: int = 800  # 单次回答 Token 上限（约束约 500 汉字）
    AI_REQUEST_TIMEOUT: int = 60  # 单次对话/讲解调用超时（秒）
    AI_MAX_RETRIES: int = 1  # 可恢复失败的最大重试次数
    AI_CONTEXT_TURNS: int = 4  # 对话默认携带的最近有效历史轮数
    AI_KNOWLEDGE_TOP_K: int = 4  # 检索已发布知识资料的最大条数

    # 长征活动规则
    STRIDE_M: float = 0.7  # 平均步长（米），估算距离(km) = 步数 × 步长 / 1000
    STREAK_GOAL_STEPS: int = 5000  # 连续行军每日达标步数（当天达到即计入连续行军）
    ACTIVITY_START_DATE: str = "2026-09-01"  # 活动起始日（答题「第 N 期」等的基准）
    QUIZ_QUESTION_SECONDS: int = 90  # 每题作答时限（秒，按服务器时间计）
    QUIZ_ANSWER_GRACE_SECONDS: int = 2  # 截止后容许的网络延迟（秒），仅用于接收提交
    ACTIVITY_MASK_NICKNAME: bool = False  # 实时行动态昵称脱敏（需求 §8.5，开启后对外动态展示如「王*明」）

    # 积分规则（V2.0）：总积分 = 步行积分 + 答题积分
    POINTS_WALK_STEPS_PER_POINT: int = 1000  # 每满多少步得 1 分（不足不计）
    POINTS_QUIZ_PER_CORRECT: int = 2  # 每答对 1 题得分
    POINTS_QUIZ_DAILY_CAP: int = 10  # 单日答题积分上限

    # 跨域来源
    CORS_ORIGINS: List[str] = ["*"]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
