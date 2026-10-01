"""ORM 数据模型。

分两类：
1. 静态配置数据（RouteNode / Question / MedalDef）——由 app.data.seed 在启动时幂等写入；
2. 用户业务数据（User / DailySport / LitNode / QuizRecord / DailyQuestion / PointsLog / UserMedal）。

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
    """用户（微信登录创建）。openid 唯一。

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
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DailySport(Base):
    """每日步数（user_id + date 唯一，同日覆盖而非累加）。

    distance 为估算距离（km）= steps × 步长；is_goal_completed 表示当日达到
    行军目标（连续行军判定依据）；is_makeup / makeup_at 为补签预留字段。
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


class LitNode(Base):
    """已点亮节点（user_id + node_id 唯一，点亮后永久保留）。

    step_snapshot 记录点亮时刻的累计步数（历史数据回填为 0，展示时判空）。
    """

    __tablename__ = "lit_nodes"
    __table_args__ = (UniqueConstraint("user_id", "node_id", name="uq_lit_user_node"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    node_id: Mapped[int] = mapped_column(Integer)
    lit_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    step_snapshot: Mapped[int] = mapped_column(Integer, default=0)


class QuizRecord(Base):
    """每日答题记录（user_id + date 唯一，每日仅一次）。"""

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
    answer_at: Mapped[int] = mapped_column(BigInteger, default=0)


class DailyQuestion(Base):
    """当天抽取的题目缓存（user_id + date 唯一），保证同一天返回同一套题。"""

    __tablename__ = "daily_questions"
    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_dailyq_user_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    date: Mapped[str] = mapped_column(String(10), index=True)
    question_ids: Mapped[list] = mapped_column(JSON, default=list)


class PointsLog(Base):
    """积分流水（同日同 reason 去重，见 points_service.grant）。"""

    __tablename__ = "points_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    date: Mapped[str] = mapped_column(String(10), index=True)
    reason: Mapped[str] = mapped_column(String(50))
    delta: Mapped[int] = mapped_column(Integer, default=0)


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

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(30))
    event_time: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    event_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True, default=dict)
