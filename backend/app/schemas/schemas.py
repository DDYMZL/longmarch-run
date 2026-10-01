"""Pydantic 请求 / 响应模型。

统一约定：
- 响应模型继承 CamelModel，字段以 camelCase 序列化输出，与前端 mock 返回结构完全一致，
  前端未来从 mock 切换到真实接口时数据结构无需改动；
- 请求模型（如登录、提交答卷）接受 camelCase 入参。
"""
from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator
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

    @field_validator("avatar", mode="before")
    @classmethod
    def empty_avatar(cls, value: Optional[str]) -> str:
        return value or ""


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
class RouteNodeConfigOut(CamelModel):
    id: int
    name: str
    icon: str
    target_steps: int
    historical_time: str
    description: str
    latitude: float
    longitude: float
    sort_order: int
    is_enabled: bool


class RouteNodeConfigListOut(CamelModel):
    nodes: List[RouteNodeConfigOut] = []


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

    @field_validator("avatar", mode="before")
    @classmethod
    def empty_avatar(cls, value: Optional[str]) -> str:
        return value or ""


class RankListOut(CamelModel):
    list: List[RankItem]
    my_rank: Optional[int] = None
    my_steps: int = 0
    total: int = 0


# ---------------- 管理后台（admin 前端项目专用契约，独立于小程序 camelCase 契约） ----------------
class AdminLoginRequest(BaseModel):
    username: str
    password: str


class AdminLoginOut(BaseModel):
    token: str
    username: str


class AdminQuestionOption(BaseModel):
    """题目选项：label 为 A/B/C/D，text 为选项内容。"""

    label: str
    text: str


class AdminQuestionOut(BaseModel):
    """题库条目（管理端可见正确答案 answer）。"""

    id: int
    type: str
    question: str
    options: List[AdminQuestionOption] = []
    answer: List[str] = []
    analysis: str = ""
    score: int = 20


class AdminQuestionListOut(BaseModel):
    total: int
    items: List[AdminQuestionOut] = []


class AdminQuestionUpsert(BaseModel):
    """新增/编辑题目请求体。type: single 单选 / judge 判断。"""

    type: str
    question: str
    options: List[AdminQuestionOption] = []
    answer: List[str] = []
    analysis: str = ""
    score: int = 20


class AdminOrgNodeOut(BaseModel):
    """组织架构树节点（含 children，供前端 el-table 树形展示）。"""

    id: int
    name: str
    parent_id: Optional[int] = None
    level: int = 1
    sort_order: int = 0
    children: List["AdminOrgNodeOut"] = []


class AdminOrgTreeOut(BaseModel):
    total: int
    nodes: List[AdminOrgNodeOut] = []


class AdminOrgUpsert(BaseModel):
    """新增/编辑组织请求体；parent_id 为空表示顶级。level 由后端根据父节点自动计算。"""

    name: str
    parent_id: Optional[int] = None
    sort_order: int = 0


class AdminOrgSyncOut(BaseModel):
    """组织架构同步结果统计。"""

    source: str
    created: int = 0
    updated: int = 0
    deleted: int = 0
    kept: int = 0
    skipped: List[int] = []


class AdminRouteNodeOut(BaseModel):
    id: int
    name: str
    icon: str
    target_steps: int
    historical_time: str
    description: str
    latitude: float
    longitude: float
    sort_order: int
    is_enabled: bool

    model_config = ConfigDict(from_attributes=True)


class AdminRouteNodeListOut(BaseModel):
    total: int
    items: List[AdminRouteNodeOut] = []


class AdminRouteNodeUpsert(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    icon: str = Field(default="", max_length=16)
    target_steps: int = Field(ge=0)
    historical_time: str = Field(default="", max_length=50)
    description: str = ""
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    sort_order: int = Field(ge=0)
    is_enabled: bool = True


class AdminRouteNodeEnabled(BaseModel):
    is_enabled: bool


class AdminRankNodeOut(BaseModel):
    id: int
    name: str
    target_steps: int
    reached: bool
    reached_at: Optional[datetime] = None


class AdminRankItemOut(BaseModel):
    rank: int
    user_id: int
    nickname: str
    avatar: str
    org_name: str = ""
    total_steps: int
    completed_nodes: int
    node_count: int
    last_reached_at: Optional[datetime] = None
    created_at: datetime
    nodes: List[AdminRankNodeOut] = []

    @field_validator("avatar", mode="before")
    @classmethod
    def empty_avatar(cls, value: Optional[str]) -> str:
        return value or ""


class AdminRankListOut(BaseModel):
    total: int = 0
    total_steps: int = 0
    completed_users: int = 0
    route_nodes: List[AdminRankNodeOut] = []
    items: List[AdminRankItemOut] = []


class AdminOverviewUser(BaseModel):
    """人员详情：基本信息。"""

    user_id: int
    nickname: str
    avatar: str = ""
    org_name: str = ""
    created_at: Optional[datetime] = None


class AdminOverviewRecentSport(BaseModel):
    """人员详情：单日运动记录。"""

    date: str
    steps: int
    text: str


class AdminOverviewSport(BaseModel):
    """人员详情：运动记录聚合。"""

    today_steps: int = 0
    total_steps: int = 0
    recent: List[AdminOverviewRecentSport] = []


class AdminOverviewQuizRecord(BaseModel):
    """人员详情：单条答题记录。"""

    date: str
    total_count: int = 0
    correct_count: int = 0
    score: int = 0
    points: int = 0
    answer_at: int = 0


class AdminOverviewMedal(BaseModel):
    """人员详情：已获勋章。"""

    id: str
    name: str
    icon: str
    desc: str = ""
    granted_at: Optional[datetime] = None


class AdminOverviewNode(BaseModel):
    """人员详情：长征路线节点到达情况。"""

    id: int
    name: str
    target_steps: int
    reached: bool
    reached_at: Optional[datetime] = None


class AdminOverviewMarch(BaseModel):
    """人员详情：长征记录聚合。"""

    completed_nodes: int = 0
    node_count: int = 0
    nodes: List[AdminOverviewNode] = []


class AdminOverviewPoint(BaseModel):
    """人员详情：积分流水条目。"""

    date: str
    reason: str
    delta: int


class AdminOverviewPoints(BaseModel):
    """人员详情：积分聚合。"""

    total: int = 0
    logs: List[AdminOverviewPoint] = []


class AdminUserOverviewOut(BaseModel):
    """排名洞察点击人员后的完整详情聚合。"""

    user: AdminOverviewUser
    sport: AdminOverviewSport
    quiz_records: List[AdminOverviewQuizRecord] = []
    medals: List[AdminOverviewMedal] = []
    march: AdminOverviewMarch
    points: AdminOverviewPoints


AdminOrgNodeOut.model_rebuild()
