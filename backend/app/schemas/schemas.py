"""Pydantic 请求 / 响应模型。

统一约定：
- 响应模型继承 CamelModel，字段以 camelCase 序列化输出，与前端 mock 返回结构完全一致，
  前端未来从 mock 切换到真实接口时数据结构无需改动；
- 请求模型（如登录、提交答卷）接受 camelCase 入参。
"""
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """输出 camelCase、可按字段名或别名填充、支持从 ORM 对象读取。"""

    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, from_attributes=True
    )


# ---------------- 鉴权 / 用户 ----------------
class UserOut(CamelModel):
    id: int
    nickname: str
    avatar: str
    org_id: Optional[int] = None


class LoginRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    code: str
    nickname: Optional[str] = ""
    avatar: Optional[str] = ""


class LoginResponse(CamelModel):
    token: str
    user: UserOut


# ---------------- 运动 ----------------
class SportToday(CamelModel):
    date: str
    steps: int
    target: int
    total_steps: int


class SportSync(CamelModel):
    date: str
    steps: int
    total_steps: int
    synced: bool


class RecentItem(CamelModel):
    date: str
    steps: int
    text: str


class AddStepsRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    delta: int = 0


# ---------------- 长征路线 ----------------
class RouteNodeOut(CamelModel):
    id: int
    name: str
    icon: str
    target_steps: int
    status: str
    remain: int


class RouteOut(CamelModel):
    nodes: List[RouteNodeOut]
    current_steps: int
    total_steps: int
    lit_count: int
    total_count: int
    next_node: Optional[RouteNodeOut] = None
    finished: bool


class NodeDetailOut(CamelModel):
    id: int
    name: str
    icon: str
    target_steps: int
    historical_time: str
    description: str
    status: str
    remain: int
    current_steps: int


class LightUpResult(CamelModel):
    newly_lit: List[RouteNodeOut] = []


# ---------------- 答题 ----------------
class OptionOut(CamelModel):
    label: str
    text: str


class QuestionOut(CamelModel):
    id: int
    type: str
    question: str
    options: List[OptionOut]
    analysis: str
    score: int


class WrongItem(CamelModel):
    index: int
    question: str
    correct_answer: str
    analysis: str


class QuizRecordOut(CamelModel):
    date: str
    total_count: int
    correct_count: int
    score: int
    points: int
    wrong_list: List[WrongItem] = []
    answer_at: int


class QuizDailyOut(CamelModel):
    date: str
    completed: bool
    questions: Optional[List[QuestionOut]] = None
    record: Optional[QuizRecordOut] = None


class AnswerItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    question_id: int = Field(alias="questionId")
    answer: List[str] = Field(default_factory=list)


class SubmitRequest(BaseModel):
    answers: List[AnswerItem]


# ---------------- 积分 ----------------
class PointsOut(CamelModel):
    total: int


class PointsLogItem(CamelModel):
    date: str
    reason: str
    delta: int


class PointsDetail(CamelModel):
    total: int
    logs: List[PointsLogItem] = []


# ---------------- 勋章 ----------------
class MedalItem(CamelModel):
    id: str
    name: str
    icon: str
    desc: str
    owned: bool


class MedalListOut(CamelModel):
    medals: List[MedalItem]
    owned_count: int


class MedalGrantResult(CamelModel):
    newly: List[str] = []


# ---------------- 通用 ----------------
class MessageOut(CamelModel):
    message: str


# ---------------- 组织架构 ----------------
class OrgNodeOut(CamelModel):
    id: int
    name: str
    parent_id: Optional[int] = None
    level: int
    has_children: bool
    child_count: int


class OrgChildrenOut(CamelModel):
    nodes: List[OrgNodeOut]


class OrgPathItem(CamelModel):
    id: int
    name: str


class UserOrgOut(CamelModel):
    org_id: Optional[int] = None
    org_name: str = ""
    full_name: str = ""
    path: List[OrgPathItem] = []


class SelectOrgRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    org_id: int = Field(alias="orgId")


# ---------------- 排名 ----------------
class RankItem(CamelModel):
    rank: int
    user_id: int
    nickname: str
    avatar: str
    org_name: str = ""
    steps: int
    is_me: bool


class RankListOut(CamelModel):
    list: List[RankItem]
    my_rank: Optional[int] = None
    my_steps: int = 0
    total: int = 0
