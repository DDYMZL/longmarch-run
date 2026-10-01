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
    """长征路线节点。target_steps 为累计步数要求。"""

    __tablename__ = "route_nodes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(50))
    target_steps: Mapped[int] = mapped_column(Integer, default=0)
    historical_time: Mapped[str] = mapped_column(String(50), default="")
    icon: Mapped[str] = mapped_column(String(16), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    latitude: Mapped[float] = mapped_column(Numeric(9, 6))
    longitude: Mapped[float] = mapped_column(Numeric(10, 6))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class Question(Base):
    """题库（15 题）。type: single 单选 / judge 判断。"""

    __tablename__ = "questions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    type: Mapped[str] = mapped_column(String(10))
    question: Mapped[str] = mapped_column(Text)
    options: Mapped[list] = mapped_column(JSON, default=list)
    answer: Mapped[list] = mapped_column(JSON, default=list)
    analysis: Mapped[str] = mapped_column(Text, default="")
    score: Mapped[int] = mapped_column(Integer, default=20)


class MedalDef(Base):
    """勋章定义（6 个）。判定逻辑见 services/medal_service。"""

    __tablename__ = "medal_defs"

    id: Mapped[str] = mapped_column(String(50), primary_key=True)
    name: Mapped[str] = mapped_column(String(50))
    icon: Mapped[str] = mapped_column(String(16))
    desc: Mapped[str] = mapped_column(String(200), default="")


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
    """用户（微信登录创建）。openid 唯一。"""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    openid: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    nickname: Mapped[str] = mapped_column(String(64), default="长征小战士")
    avatar: Mapped[Optional[str]] = mapped_column(String(500), nullable=True, default=None)
    org_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DailySport(Base):
    """每日步数（user_id + date 唯一，同日覆盖而非累加）。"""

    __tablename__ = "daily_sport"
    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_sport_user_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    date: Mapped[str] = mapped_column(String(10), index=True)
    steps: Mapped[int] = mapped_column(Integer, default=0)


class LitNode(Base):
    """已点亮节点（user_id + node_id 唯一，点亮后永久保留）。"""

    __tablename__ = "lit_nodes"
    __table_args__ = (UniqueConstraint("user_id", "node_id", name="uq_lit_user_node"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    node_id: Mapped[int] = mapped_column(Integer)
    lit_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


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
