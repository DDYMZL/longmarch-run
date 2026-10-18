"""ORM 数据模型。

分两类：
1. 静态配置数据（RouteNode / Question / MedalDef）——由 app.data.seed 在启动时幂等写入；
2. 用户业务数据（User / DailySport / LitNode / QuizRecord / DailyQuestion / QuizAnswer / PointsLog / UserMedal）。

对应前端 services/store.js 的用户数据结构：
    dailySport / litNodes / quizRecords / pointsLog / medals / firstSyncAt
"""
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


# ---------------- 静态配置数据 ----------------
class RouteNode(Base):
    """长征路线节点。target_steps 为累计步数要求。

    brief/significance/figures/location/images/audio/keywords 为「历史事件卡」
    内容字段，种子仅补空值，管理端可编辑。本库空字符串按 NULL 存储
    （Oracle 兼容模式），字符串内容列保持可空，读取时 None 即空值。
    """

    __tablename__ = "route_nodes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(50))
    target_steps: Mapped[int] = mapped_column(Integer, default=0)
    historical_time: Mapped[str] = mapped_column(String(50), default="")
    icon: Mapped[str] = mapped_column(String(16), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    brief: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, default=None)
    significance: Mapped[Optional[str]] = mapped_column(Text, nullable=True, default=None)
    figures: Mapped[Optional[str]] = mapped_column(String(500), nullable=True, default=None)
    location: Mapped[Optional[str]] = mapped_column(String(100), nullable=True, default=None)
    images: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=list)
    audio: Mapped[Optional[str]] = mapped_column(String(500), nullable=True, default=None)
    keywords: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, default=None)
    latitude: Mapped[float] = mapped_column(Numeric(9, 6))
    longitude: Mapped[float] = mapped_column(Numeric(10, 6))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class Chapter(Base):
    """长征章节配置（需求 §4，023 迁移外化自 march_service.CHAPTERS）。

    10 个路线节点划分为若干章；node_ids 为归属的 route_nodes 主键列表（JSON），
    intro 为公开史实概述（章节完成仪式展示）。sort_order 升序即章节顺序。
    管理端可增删改（chapters CRUD），march_service 查表计算章节状态，
    库空时回退 march_service.CHAPTERS 常量。
    """

    __tablename__ = "chapters"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(50))
    title: Mapped[str] = mapped_column(String(100), default="")
    intro: Mapped[Optional[str]] = mapped_column(Text, nullable=True, default=None)
    node_ids: Mapped[list] = mapped_column("node_ids_json", JSON, default=list)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class Person(Base):
    """长征人物志（需求 §14）。avatar 为空时前端展示姓名首字占位。"""

    __tablename__ = "persons"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(50))
    avatar: Mapped[Optional[str]] = mapped_column(String(500), nullable=True, default=None)
    brief: Mapped[Optional[str]] = mapped_column(Text, nullable=True, default=None)


class PersonNode(Base):
    """人物 ↔ 路线节点关联（人物相关的历史事件即节点事件，历史时间在 route_nodes）。"""

    __tablename__ = "person_nodes"

    person_id: Mapped[int] = mapped_column(ForeignKey("persons.id"), primary_key=True)
    node_id: Mapped[int] = mapped_column(ForeignKey("route_nodes.id"), primary_key=True)


class DailyQuote(Base):
    """每日寄语（需求 §16、V1.1 功能二）。内容为有明确出处的史料语录，由后台维护，可关联路线节点。

    启用寄语按 (sort_order, id) 升序参与按天循环展示；循环起始日期见 SystemSetting。
    """

    __tablename__ = "daily_quotes"
    __table_args__ = (Index("ix_daily_quotes_cycle", "is_enabled", "sort_order", "id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    content: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(200))
    node_id: Mapped[Optional[int]] = mapped_column(ForeignKey("route_nodes.id"), nullable=True, default=None)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class SystemSetting(Base):
    """系统级键值配置（管理端可改），如寄语循环起始日期 quote_cycle_start。"""

    __tablename__ = "system_settings"

    setting_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    setting_value: Mapped[str] = mapped_column(String(200))
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ActivitySetting(Base):
    """活动时间控制（单行，id=1；016 迁移）。时间列 UTC naive 存储，状态由 activity_service 实时计算。"""

    __tablename__ = "activity_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    start_at: Mapped[datetime] = mapped_column(DateTime)
    end_at: Mapped[datetime] = mapped_column(DateTime)
    is_published: Mapped[bool] = mapped_column(Boolean, default=False)
    restrict_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    allow_view_after_end: Mapped[bool] = mapped_column(Boolean, default=True)
    end_title: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)
    end_message: Mapped[Optional[str]] = mapped_column(String(500), nullable=True, default=None)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)


class Question(Base):
    """题库（15 题）。type: single 单选 / judge 判断。

    category 为知识画像分类：event 历史事件 / route 长征路线 / figure 历史人物。
    """

    __tablename__ = "questions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    type: Mapped[str] = mapped_column(String(10))
    question: Mapped[str] = mapped_column(Text)
    options: Mapped[list] = mapped_column(JSON, default=list)
    answer: Mapped[list] = mapped_column(JSON, default=list)
    analysis: Mapped[str] = mapped_column(Text, default="")
    score: Mapped[int] = mapped_column(Integer, default=20)
    category: Mapped[Optional[str]] = mapped_column(String(20), nullable=True, default=None)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)


class MedalDef(Base):
    """勋章定义。判定逻辑见 services/medal_service。

    category: starter 入门 / route 路线 / challenge 挑战 / complete 完成；
    hidden 为 True 的勋章未获得时不公开获取条件。
    """

    __tablename__ = "medal_defs"

    id: Mapped[str] = mapped_column(String(50), primary_key=True)
    name: Mapped[str] = mapped_column(String(50))
    icon: Mapped[str] = mapped_column(String(16))
    desc: Mapped[str] = mapped_column(String(200), default="")
    category: Mapped[Optional[str]] = mapped_column(String(20), nullable=True, default=None)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class Organization(Base):
    """组织架构节点（多级树）。parent_id 为空表示顶级；level 为 1 起的层级深度。

    由 app.data.seed 幂等写入。用户可选定任意层级节点作为所属组织。
    """

    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    parent_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True, default=None)
    level: Mapped[int] = mapped_column(Integer, default=1)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


# ---------------- 用户业务数据 ----------------
class User(Base):
    """用户（持有效邀请码入驻时创建）。openid 唯一。

    nickname_changed_at 非空表示已使用唯一一次改名机会；original_nickname
    记录登录时的微信昵称（曾用名），供管理端展示修改记录。
    continuous_days / max_continuous_days 为连续行军缓存，由 sport 写入链路
    维护（streak_service），启动时按 daily_sport 全量重算兜底。
    """

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    openid: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    nickname: Mapped[str] = mapped_column(String(64), default="长征小战士")
    avatar: Mapped[Optional[str]] = mapped_column(String(500), nullable=True, default=None)
    org_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True, default=None)
    original_nickname: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)
    nickname_changed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)
    continuous_days: Mapped[int] = mapped_column(Integer, default=0)
    max_continuous_days: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    # 长征完成仪式（需求 §20.4）：非空表示已观看首次完成仪式，之后仅展示「已完成长征」
    route_ceremony_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)
    # 准入（015）：status active/disabled；invite_code_id 为空即 015 之前的历史用户
    status: Mapped[str] = mapped_column(String(16), default="active")
    invite_code_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True, default=None)
    onboarded_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)


class InviteCode(Base):
    """入驻邀请码（PC 后台生成）。code 即小程序码 scene 参数 i=<code>。

    org_id 非空时入驻只能选择该组织及其下级；max_uses 为空不限次数；
    used_count 仅由 invite_service 的条件 UPDATE 原子递增。
    """

    __tablename__ = "invite_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(64))
    remark: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, default=None)
    org_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    max_uses: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    used_count: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DailySport(Base):
    """每日步数（user_id + date 唯一，同日覆盖而非累加）。

    distance 为估算距离（km）= steps × 步长；is_goal_completed 表示当日达到
    行军目标（连续行军判定依据）；is_makeup / makeup_at 为补签预留字段。
    source 数据来源（werun / mock / manual），synced_at 最近一次写入时间（UTC，019）。
    sync_status processed 已入账 / failed 同步失败（025）；fail_reason 记录失败原因，
    供管理端「同步失败清单」只读感知（点13），失败行 steps 可为 0 占位、不计入累计。
    """

    __tablename__ = "daily_sport"
    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_sport_user_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    date: Mapped[str] = mapped_column(String(10), index=True)
    steps: Mapped[int] = mapped_column(Integer, default=0)
    distance: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    is_goal_completed: Mapped[bool] = mapped_column(Boolean, default=False)
    is_makeup: Mapped[bool] = mapped_column(Boolean, default=False)
    makeup_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)
    source: Mapped[str] = mapped_column(String(16), default="werun")
    synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)
    sync_status: Mapped[str] = mapped_column(String(16), default="processed")
    fail_reason: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, default=None)


class LitNode(Base):
    """已点亮节点（user_id + node_id 唯一，点亮后永久保留）。

    step_snapshot 记录点亮时刻的累计步数（历史数据回填为 0，展示时判空）。
    """

    __tablename__ = "lit_nodes"
    __table_args__ = (UniqueConstraint("user_id", "node_id", name="uq_lit_user_node"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    node_id: Mapped[int] = mapped_column(Integer)
    lit_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    step_snapshot: Mapped[int] = mapped_column(Integer, default=0)


class QuizRecord(Base):
    """每日答题记录（user_id + date 唯一，每日仅一次；并发提交由唯一约束兜底）。"""

    __tablename__ = "quiz_records"
    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_quiz_user_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    date: Mapped[str] = mapped_column(String(10), index=True)
    total_count: Mapped[int] = mapped_column(Integer, default=0)
    correct_count: Mapped[int] = mapped_column(Integer, default=0)
    score: Mapped[int] = mapped_column(Integer, default=0)
    points: Mapped[int] = mapped_column(Integer, default=0)
    wrong_list: Mapped[list] = mapped_column(JSON, default=list)
    # 逐题判分结果（014 迁移新增）；历史记录为 None，展示时回退 wrong_list
    details: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=None)
    answer_at: Mapped[int] = mapped_column(BigInteger, default=0)


class DailyQuestion(Base):
    """当天抽取的题目缓存（user_id + date 唯一），保证同一天返回同一套题。"""

    __tablename__ = "daily_questions"
    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_dailyq_user_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    date: Mapped[str] = mapped_column(String(10), index=True)
    question_ids: Mapped[list] = mapped_column(JSON, default=list)


class QuizAnswer(Base):
    """每题限时作答（018）：会话(daily_questions) 内逐题的服务器计时、作答与判定，时间为 UTC。

    status：answering 作答中 / answered 已作答 / timeout 已超时（不得分、不可再提交）。
    """

    __tablename__ = "quiz_answers"
    __table_args__ = (
        UniqueConstraint("session_id", "seq", name="uq_quiz_answer_session_seq"),
        Index("ix_quiz_answers_user_date", "user_id", "date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("daily_questions.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    date: Mapped[str] = mapped_column(String(10))
    seq: Mapped[int] = mapped_column(Integer)
    question_id: Mapped[int] = mapped_column(Integer)
    started_at: Mapped[datetime] = mapped_column(DateTime)
    deadline_at: Mapped[datetime] = mapped_column(DateTime)
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    user_answer: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    is_correct: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default="answering")
    points: Mapped[int] = mapped_column(Integer, default=0)


class PointsLog(Base):
    """积分台账（017）：walk / quiz 每人每自然日一行，biz_key 唯一，由 points_service 按源数据重算。

    source_type='legacy' 为 V2.0 之前的旧规则流水，仅追溯，不计入总积分。
    """

    __tablename__ = "points_log"
    __table_args__ = (
        UniqueConstraint("user_id", "biz_key", name="uq_points_user_biz"),
        Index("ix_points_log_source_user", "source_type", "user_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    date: Mapped[str] = mapped_column(String(10), index=True)
    reason: Mapped[str] = mapped_column(String(50))
    delta: Mapped[int] = mapped_column(Integer, default=0)
    source_type: Mapped[str] = mapped_column(String(16), default="legacy")
    ref_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    biz_key: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class UserMedal(Base):
    """用户已获勋章（user_id + medal_id 唯一）。"""

    __tablename__ = "user_medals"
    __table_args__ = (UniqueConstraint("user_id", "medal_id", name="uq_user_medal"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    medal_id: Mapped[str] = mapped_column(String(50))
    granted_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class UserEvent(Base):
    """用户统一业务事件（「我的长征足迹」与管理端实时动态同源）。

    event_type 取值见 services/event_service：FIRST_STEP / DAILY_GOAL /
    NODE_UNLOCK / BADGE_UNLOCK / QUIZ_COMPLETE / QUIZ_FULL_SCORE /
    STREAK_* / STEP_10000 / TOTAL_STEPS_100000 / COMPLETE_ROUTE。
    event_data 为事件负载（节点名、勋章名、步数快照等）。
    """

    __tablename__ = "user_event"
    __table_args__ = (Index("ix_user_event_user_type", "user_id", "event_type"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # user_id 可空：匿名事件（如 INVITE_SCAN 扫码校验邀请码）无用户上下文，仅供运营漏斗统计
    user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), index=True, nullable=True)
    event_type: Mapped[str] = mapped_column(String(30))
    event_time: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    event_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True, default=dict)


# ---------------- 微信身份关联与管理后台 RBAC（docs/identity-binding-design.md） ----------------
class UserIdentity(Base):
    """微信身份关联表。provider: wx_mini / wx_web（开放平台渠道，阶段2）。

    「一个 unionid 只属一个用户」规则无法用索引表达（同一用户多渠道会持有
    相同 unionid），由 identity_service 在事务内校验，冲突身份禁止自动合并。
    """

    __tablename__ = "user_identities"
    __table_args__ = (
        UniqueConstraint("provider", "app_id", "openid", name="uq_identity_provider_openid"),
        UniqueConstraint("user_id", "provider", "app_id", name="uq_identity_user_channel"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    provider: Mapped[str] = mapped_column(String(32))
    app_id: Mapped[str] = mapped_column(String(64))
    openid: Mapped[str] = mapped_column(String(64))
    unionid: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)
    verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class BindRequest(Base):
    """身份绑定请求记录。绑定凭证仅存 SHA-256 摘要，不存可重放的明文。

    status: pending / confirmed / used / cancelled / expired；
    目标身份（provider/app_id/openid/unionid）来自微信服务端，非前端提交。
    """

    __tablename__ = "bind_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id"), nullable=True, default=None
    )
    provider: Mapped[str] = mapped_column(String(32))
    app_id: Mapped[str] = mapped_column(String(64))
    openid: Mapped[str] = mapped_column(String(64))
    unionid: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class QrLoginSession(Base):
    """PC 扫码登录会话。id（qrId）为轮询凭证，与小程序码内嵌 scene 凭证分离。

    status: pending / scanned / confirmed / failed / cancelled / expired；
    token_issued 保证管理员 JWT 仅签发一次，防轮询重放。
    """

    __tablename__ = "qr_login_sessions"

    id: Mapped[str] = mapped_column(String(24), primary_key=True)
    scene_token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    fail_reason: Mapped[Optional[str]] = mapped_column(String(200), nullable=True, default=None)
    user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id"), nullable=True, default=None
    )
    token_issued: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)


class AdminMenu(Base):
    """后台菜单。code 与 require_menu 依赖一一对应。"""

    __tablename__ = "admin_menus"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(32))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class AdminRole(Base):
    """后台角色。is_builtin 的内置角色不可删除。"""

    __tablename__ = "admin_roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(32))
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AdminRoleMenu(Base):
    """角色 ↔ 菜单关联。"""

    __tablename__ = "admin_role_menus"

    role_id: Mapped[int] = mapped_column(ForeignKey("admin_roles.id"), primary_key=True)
    menu_id: Mapped[int] = mapped_column(ForeignKey("admin_menus.id"), primary_key=True)


class AdminUserRole(Base):
    """用户角色授权。enabled=False 即时生效（get_current_admin 每请求查库）。"""

    __tablename__ = "admin_user_roles"
    __table_args__ = (UniqueConstraint("user_id", "role_id", name="uq_admin_user_role"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    role_id: Mapped[int] = mapped_column(ForeignKey("admin_roles.id"))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    granted_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)
    granted_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AuditLog(Base):
    """管理后台审计日志。actor_type: super（配置超管）/ user（微信关联管理员）。"""

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_type: Mapped[str] = mapped_column(String(16))
    actor_user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    action: Mapped[str] = mapped_column(String(50))
    target_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, nullable=True, default=None, index=True
    )
    detail: Mapped[Optional[str]] = mapped_column(Text, nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class ImportPreview(Base):
    """Excel 批量导入预览暂存（V1.1 题库/寄语/人员导入）。

    上传解析后的整批数据（有效行 + 错误行）存 payload；确认导入时在同一事务
    写入正式表并置 confirmed。token 一次性使用且会过期，防止重复提交重复导入。
    status: pending / confirmed。biz_type: question / quote / staff。
    """

    __tablename__ = "import_previews"

    token: Mapped[str] = mapped_column(String(36), primary_key=True)
    biz_type: Mapped[str] = mapped_column(String(20))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(10), default="pending")
    created_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)


# ---------------- AI 智能中心（021） ----------------
class AiKnowledge(Base):
    """AI 知识资料（历史助手 / 路线讲解的检索源）。

    status: draft 草稿 / pending 待审核 / published 已发布 / rejected 已驳回 / archived 已归档；
    仅 published 参与正式问答检索。category 复用题库口径 event/route/figure，另允许 custom。
    node_id 非空表示绑定某路线节点（route-guide 固定讲解优先取该节点已发布资料）。
    本库空字符串按 NULL 存储（Oracle 兼容模式），可空文本列读取时 None 即空值。
    """

    __tablename__ = "ai_knowledge"
    __table_args__ = (
        Index("ix_ai_knowledge_status_cat", "status", "category"),
        Index("ix_ai_knowledge_node", "node_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text)
    source: Mapped[Optional[str]] = mapped_column(String(300), nullable=True, default=None)
    # 相关/推荐问题（路线节点固定讲解用），字符串数组
    related: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=None)
    category: Mapped[Optional[str]] = mapped_column(String(20), nullable=True, default=None)
    node_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("route_nodes.id"), nullable=True, default=None
    )
    status: Mapped[str] = mapped_column(String(16), default="draft")
    created_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)
    reviewed_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    published_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)


class AiConversation(Base):
    """AI 会话（历史助手）。归属由 JWT 用户确定，跨用户不可读写。

    status: active 正常 / archived 归档。删除会话时服务层显式连同消息一并删除，不依赖数据库级联。
    """

    __tablename__ = "ai_conversations"
    __table_args__ = (Index("ix_ai_conversations_user_updated", "user_id", "updated_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    title: Mapped[Optional[str]] = mapped_column(String(100), nullable=True, default=None)
    status: Mapped[str] = mapped_column(String(16), default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AiMessage(Base):
    """AI 消息。role: user / assistant / system。sources 为后端核验过的知识来源列表。

    used_tokens 为平台 usage_update.used 原值（assistant 消息，未报告时为空）。
    """

    __tablename__ = "ai_messages"
    __table_args__ = (Index("ix_ai_messages_conv_id", "conversation_id", "id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("ai_conversations.id", ondelete="CASCADE")
    )
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text)
    sources: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=None)
    used_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AiGenerationJob(Base):
    """AI 题目生成任务（题目工坊）。一次生成请求对应一条任务，记录请求/成功/失败数与状态。

    status: pending 待执行 / running 执行中 / success 全部成功 / partial 部分成功 / failed 全部失败。
    params 存生成参数快照（topic/count/difficulty/category/extra/knowledge_ids）。
    """

    __tablename__ = "ai_generation_jobs"
    __table_args__ = (Index("ix_ai_jobs_created", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_type: Mapped[str] = mapped_column(String(20), default="question")
    topic: Mapped[str] = mapped_column(String(100))
    params: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True, default=None)
    requested: Mapped[int] = mapped_column(Integer, default=0)
    succeeded: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True, default=None)
    created_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)


class AiGeneratedQuestion(Base):
    """AI 题目草稿（题目工坊）。data 为题目内容 JSON，errors 为待修正问题列表。

    status: pending 待审核 / approved 已通过 / rejected 已驳回 / imported 已导入。
    question_id 为导入正式题库后的 questions.id（幂等：已导入的草稿不再重复入库）。
    """

    __tablename__ = "ai_generated_questions"
    __table_args__ = (
        Index("ix_ai_genq_status", "status"),
        Index("ix_ai_genq_job", "job_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("ai_generation_jobs.id"), nullable=True, default=None
    )
    data: Mapped[dict] = mapped_column(JSON)
    errors: Mapped[Optional[list]] = mapped_column(JSON, nullable=True, default=None)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    reviewed_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, default=None)
    question_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AiUsageLog(Base):
    """AI 调用日志。用于日限额计数（user_id + day_key）与后续用量/成本统计。

    feature: chat / route_guide / quiz_explanation / question_gen。
    status: success / error。day_key 为北京时间当日 YYYY-MM-DD（helpers.today_str）。
    used_tokens 为平台原值，未报告为空；model 暂存 Agent ID（底层模型名需控制台确认）。
    """

    __tablename__ = "ai_usage_logs"
    __table_args__ = (
        Index("ix_ai_usage_user_day", "user_id", "day_key"),
        Index("ix_ai_usage_day", "day_key"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    conversation_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    feature: Mapped[str] = mapped_column(String(30))
    model: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default=None)
    used_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    elapsed_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=None)
    status: Mapped[str] = mapped_column(String(16), default="success")
    error_code: Mapped[Optional[str]] = mapped_column(String(50), nullable=True, default=None)
    day_key: Mapped[str] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
