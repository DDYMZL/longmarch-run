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
    nickname_changed_at: Optional[datetime] = None

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


class NicknameUpdateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    nickname: str = Field(min_length=1, max_length=64)


# ---------------- 身份关联 / 扫码确认（小程序侧契约） ----------------
class QrInfoRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    scene: str = Field(min_length=1, max_length=64)


class QrInfoTarget(CamelModel):
    """绑定目标身份（仅展示渠道信息，openid 不对外返回）。"""

    provider: str
    app_id: str
    nickname: Optional[str] = None


class QrInfoOut(CamelModel):
    type: str  # login / bind
    status: str
    target: Optional[QrInfoTarget] = None
    expires_at: Optional[datetime] = None
    fail_reason: Optional[str] = None


class QrConfirmRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    scene: str = Field(min_length=1, max_length=64)
    action: str = Field(pattern="^(confirm|cancel)$")


class IdentityOut(CamelModel):
    """已绑定身份（对外不返回 openid）。"""

    id: int
    provider: str
    app_id: str
    unionid: Optional[str] = None
    verified_at: Optional[datetime] = None
    created_at: datetime


# ---------------- 运动 ----------------
class SportToday(CamelModel):
    date: str
    steps: int
    target: int
    total_steps: int
    current_streak: int = 0
    max_streak: int = 0
    streak_goal: int = 0
    today_goal_completed: bool = False
    next_streak_milestone: Optional[int] = None
    streak_remain: int = 0


class SportSync(CamelModel):
    date: str
    steps: int
    total_steps: int
    synced: bool


class RecentItem(CamelModel):
    date: str
    steps: int
    text: str


class CalendarDay(CamelModel):
    date: str
    steps: int = 0
    level: int = 0
    goal_completed: bool = False
    quiz_done: bool = False
    quiz_score: int = 0
    lit_nodes: List[str] = []


class CalendarStats(CamelModel):
    month_steps: int = 0
    sport_days: int = 0
    avg_steps: int = 0
    max_steps: int = 0
    current_streak: int = 0


class SportCalendarOut(CamelModel):
    month: str
    days: List[CalendarDay] = []
    stats: CalendarStats


class AddStepsRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    delta: int = Field(0, ge=0)


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
    historical_time: str = ""
    description: str = ""
    latitude: float = 0
    longitude: float = 0


class ChapterOut(CamelModel):
    """长征章节视图（需求 §4.3/4.4）：LOCKED 未开始 / ACTIVE 当前章 / COMPLETED 已完成。"""

    id: int
    name: str
    title: str
    status: str
    node_ids: List[int] = []
    lit_count: int = 0
    total_count: int = 0
    progress: float = 0
    intro: str = ""


class ChapterCompletedOut(CamelModel):
    """本次新完成章节（light-up 返回，供章节完成仪式展示）。"""

    id: int
    name: str
    title: str
    intro: str = ""


class RouteOut(CamelModel):
    nodes: List[RouteNodeOut]
    current_steps: int
    total_steps: int
    lit_count: int
    total_count: int
    next_node: Optional[RouteNodeOut] = None
    finished: bool
    # 行军轨迹（后端统一计算）：当前前往节点、区间段内进度、全程进度
    current_node_id: Optional[int] = None
    current_progress: float = 0
    route_progress: float = 0
    # 章节系统：各章状态与当前章节（全部完成时为 null）
    chapters: List[ChapterOut] = []
    current_chapter_id: Optional[int] = None
    # 完成仪式（需求 §20.4）：全部点亮且未观看过仪式时为 true，前端播放后调 /march/ceremony
    ceremony_pending: bool = False


class PersonRefOut(CamelModel):
    """人物引用（节点详情页相关人物入口）。"""

    id: int
    name: str


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
    brief: str = ""
    significance: str = ""
    figures: str = ""
    location: str = ""
    images: List[str] = []
    audio: str = ""
    keywords: str = ""
    persons: List[PersonRefOut] = []


class PersonNodeRefOut(CamelModel):
    """人物详情中的相关节点（历史事件 = 节点事件，历史时间在节点上）。"""

    id: int
    name: str
    icon: str
    historical_time: str
    brief: str = ""


class PersonDetailOut(CamelModel):
    """长征人物志详情（需求 §14.2）：头像/名称/简介/相关历史事件(节点)/历史时间。"""

    id: int
    name: str
    avatar: str = ""
    brief: str = ""
    nodes: List[PersonNodeRefOut] = []


class QuoteNodeRefOut(CamelModel):
    """寄语关联节点引用。"""

    id: int
    name: str


class QuoteTodayOut(CamelModel):
    """今日寄语（需求 §16）：取当天寄语，无当天则取最近一条不晚于今天的寄语。"""

    id: int
    date: str
    content: str
    source: str
    node: Optional[QuoteNodeRefOut] = None


class LightUpNextNode(CamelModel):
    """点亮后距离下一站的提示（全部点亮时为 null）。"""

    name: str
    remain: int


class LightUpNodeOut(RouteNodeOut):
    """本次新点亮节点：含积分、点亮时间与下一站提示（前端到达动画数据）。"""

    gained_points: int = 0
    lit_at: Optional[datetime] = None
    next_node: Optional[LightUpNextNode] = None


class LightUpResult(CamelModel):
    newly_lit: List[LightUpNodeOut] = []
    newly_completed_chapters: List[ChapterCompletedOut] = []


class GlobalMilestoneOut(CamelModel):
    """全员共同目标阶段里程碑（需求 §11.2）。"""

    name: str
    steps: int
    reached: bool


class GlobalGoalNextOut(CamelModel):
    """下一未达成里程碑（全部达成时为 null）。"""

    name: str
    steps: int
    remain: int


class GlobalGoalOut(CamelModel):
    """全员共同长征目标（需求 §11）：全员累计步数 / 总目标 / 阶段里程碑。"""

    total_steps: int = 0
    target_steps: int = 0
    progress_pct: float = 0.0
    milestones: List[GlobalMilestoneOut] = []
    next_milestone: Optional[GlobalGoalNextOut] = None


class FootprintNodeOut(CamelModel):
    """我的长征足迹节点（需求 §7.2/§7.3）：点亮日期 + 当日步数 + 点亮时累计步数。"""

    id: int
    name: str
    icon: str
    lit_at: Optional[datetime] = None
    lit_date: str = ""
    day_steps: int = 0
    cum_steps: int = 0


class FootprintsOut(CamelModel):
    """我的长征足迹（需求 §7）：按路线顺序的已点亮节点足迹链。"""

    nodes: List[FootprintNodeOut] = []


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
    question_id: int = 0
    category: str = ""
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
    issue_no: int = 1
    completed: bool
    questions: Optional[List[QuestionOut]] = None
    record: Optional[QuizRecordOut] = None


class KnowledgeCategory(CamelModel):
    key: str
    name: str
    rate: int = 0
    asked: int = 0
    wrong: int = 0


class QuizKnowledgeOut(CamelModel):
    categories: List[KnowledgeCategory] = []
    overall_rate: int = 0


class AnswerItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    question_id: int = Field(alias="questionId")
    answer: List[str] = Field(default_factory=list)


class SubmitRequest(BaseModel):
    answers: List[AnswerItem]


class QuizCheckOut(CamelModel):
    """单题即时判题结果（需求 §15 答题连胜反馈；不改动积分/提交规则）。"""

    question_id: int
    correct: bool


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
    category: str = ""
    hidden: bool = False
    sort_order: int = 0
    granted_at: Optional[datetime] = None
    condition_desc: str = ""


class MedalListOut(CamelModel):
    medals: List[MedalItem]
    owned_count: int


class MedalGrantResult(CamelModel):
    newly: List[str] = []


# ---------------- 个人档案 / 足迹 ----------------
class ProfileUser(CamelModel):
    nickname: str
    avatar: str = ""
    org_name: str = ""
    created_at: Optional[datetime] = None
    join_days: int = 1

    @field_validator("avatar", mode="before")
    @classmethod
    def empty_avatar(cls, value: Optional[str]) -> str:
        return value or ""


class ProfileNodeRef(CamelModel):
    id: int
    name: str
    icon: str


class ProfileNextNode(ProfileNodeRef):
    remain: int = 0


class ProfileStats(CamelModel):
    total_steps: int = 0
    total_distance: float = 0
    sport_days: int = 0
    current_streak: int = 0
    max_streak: int = 0
    max_day_steps: int = 0
    avg_daily_steps: int = 0
    progress: int = 0
    lit_count: int = 0
    total_count: int = 0
    current_node: Optional[ProfileNodeRef] = None
    next_node: Optional[ProfileNextNode] = None


class ProfileQuizStats(CamelModel):
    total_count: int = 0
    correct_rate: int = 0
    full_score_count: int = 0


class ProfileMedalStats(CamelModel):
    owned_count: int = 0
    total_count: int = 0


class ProfilePointsStats(CamelModel):
    total: int = 0


class ProfilePortrait(CamelModel):
    """个人数据画像五维评分（需求 §17.2/§17.3，0~100，只展示数据不做评价）。"""

    march: int = 0
    persistence: int = 0
    knowledge: int = 0
    route: int = 0
    achievement: int = 0


class ProfileSummaryOut(CamelModel):
    user: ProfileUser
    stats: ProfileStats
    quiz: ProfileQuizStats
    medals: ProfileMedalStats
    points: ProfilePointsStats
    portrait: ProfilePortrait = ProfilePortrait()


class TimelineItem(CamelModel):
    event_type: str
    event_time: datetime
    text: str = ""
    data: dict = {}


class ProfileTimelineOut(CamelModel):
    items: List[TimelineItem] = []


# ---------------- 今日播报 ----------------
class BroadcastGlobal(CamelModel):
    today_users: int = 0
    today_steps: int = 0
    today_lit_count: int = 0
    today_quiz_users: int = 0
    total_users: int = 0


class BroadcastPersonal(CamelModel):
    today_steps: int = 0
    beat_percent: int = 0
    remain_to_next: int = 0
    next_node_name: str = ""


class BroadcastMemory(CamelModel):
    node_id: int
    title: str
    historical_time: str = ""
    brief: str = ""


class BroadcastTodayOut(CamelModel):
    global_: BroadcastGlobal = Field(alias="global", default_factory=BroadcastGlobal)
    personal: BroadcastPersonal = BroadcastPersonal()
    memory: Optional[BroadcastMemory] = None


class ActivityItemOut(CamelModel):
    """实时行军动态条目（需求 §8.5：仅昵称/行为文案/类型/时间，不含 user_id 与事件参数）。"""

    id: int
    event_type: str
    event_time: datetime
    nickname: str = ""
    text: str = ""


class ActivitiesOut(CamelModel):
    items: List[ActivityItemOut] = []


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


class CompanionItemOut(CamelModel):
    """同组织同行者条目（需求 §9.4：仅昵称/头像/今日步数与是否本人，不含用户 id）。"""

    nickname: str = ""
    avatar: Optional[str] = None
    today_steps: int = 0
    is_self: bool = False


class OrgCompanionsOut(CamelModel):
    """同组织同行者（需求 §9）：组织信息 + 同行人数 + 今日共同前进 + 同行者列表。"""

    org: Optional[UserOrgOut] = None
    member_count: int = 0
    today_total_steps: int = 0
    companions: List[CompanionItemOut] = []


class OrgMarchNodeOut(CamelModel):
    """组织路线节点（需求 §10.3：completed=100% / current=累计占比 / 其余 0%）。"""

    id: int
    name: str
    target_steps: int
    status: str
    pct: int = 0


class OrgMarchOut(CamelModel):
    """组织共同长征目标（需求 §10）：组织集体进度 + 组织路线。"""

    org: Optional[UserOrgOut] = None
    member_count: int = 0
    total_steps: int = 0
    progress_pct: int = 0
    current_node_name: str = ""
    next_node_name: str = ""
    finished: bool = False
    lit_count: int = 0
    total_count: int = 0
    nodes: List[OrgMarchNodeOut] = []


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


class AdminQrCreateOut(BaseModel):
    """扫码登录会话创建结果；mock 模式（无微信凭证）image 为 None 并返回 scene 供开发直连。"""

    qr_id: str
    image: Optional[str] = None
    scene: Optional[str] = None
    mock: bool = False
    expires_in: int


class AdminMenuOut(BaseModel):
    code: str
    name: str


class AdminQrStatusOut(BaseModel):
    status: str
    fail_reason: Optional[str] = None
    expires_in: Optional[int] = None
    token: Optional[str] = None
    username: Optional[str] = None
    is_super: Optional[bool] = None
    menus: List[AdminMenuOut] = []


class AdminMeOut(BaseModel):
    username: str
    is_super: bool
    menus: List[AdminMenuOut]
    roles: List[str] = []


class AdminQuestionOption(BaseModel):
    """题目选项：label 为 A/B/C/D，text 为选项内容。"""

    label: str
    text: str


class AdminQuestionOut(BaseModel):
    """题库条目（管理端可见正确答案 answer）。category 为知识画像分类。"""

    id: int
    type: str
    question: str
    options: List[AdminQuestionOption] = []
    answer: List[str] = []
    analysis: str = ""
    score: int = 20
    category: str = ""

    @field_validator("category", mode="before")
    @classmethod
    def none_category(cls, value: Optional[str]) -> str:
        return value or ""


class AdminQuestionListOut(BaseModel):
    total: int
    items: List[AdminQuestionOut] = []


class AdminQuestionUpsert(BaseModel):
    """新增/编辑题目请求体。type: single 单选 / judge 判断；category 可空。"""

    type: str
    question: str
    options: List[AdminQuestionOption] = []
    answer: List[str] = []
    analysis: str = ""
    score: int = 20
    category: str = ""


class AdminQuoteOut(BaseModel):
    """每日寄语条目（需求 §16 后台维护）。"""

    id: int
    date: str
    content: str
    source: str
    node_id: Optional[int] = None
    node_name: str = ""


class AdminQuoteListOut(BaseModel):
    total: int
    items: List[AdminQuoteOut] = []


class AdminQuoteUpsert(BaseModel):
    """新增/编辑寄语请求体。date 为 'YYYY-MM-DD'，同一日期唯一；node_id 可空。"""

    date: str
    content: str
    source: str
    node_id: Optional[int] = None


# ---------------- 管理端驾驶舱 / 数据大屏 ----------------
class AdminDashboardMetrics(BaseModel):
    """驾驶舱核心指标（组织维度已按需求取消，不含 org 统计）。"""

    total_users: int = 0
    today_users: int = 0
    total_steps: int = 0
    avg_steps: int = 0
    completion_rate: int = 0
    quiz_users: int = 0
    medals_granted: int = 0


class AdminRouteOverviewItem(BaseModel):
    """路线总览：每个启用节点的达成人数与完成率。"""

    node_id: int
    name: str
    target_steps: int
    lit_count: int
    completion_rate: int


class AdminDashboardOut(BaseModel):
    metrics: AdminDashboardMetrics
    route_overview: List[AdminRouteOverviewItem] = []


class AdminTrendPoint(BaseModel):
    """运动趋势单日数据点（按本地日期分桶）。"""

    date: str
    total_steps: int = 0
    active_users: int = 0
    new_users: int = 0
    new_lit: int = 0


class AdminTrendOut(BaseModel):
    days: int
    points: List[AdminTrendPoint] = []


class AdminActivityItem(BaseModel):
    """实时动态条目（user_event 关联昵称，文案与小程序足迹同源）。"""

    id: int
    event_type: str
    event_time: datetime
    user_id: int
    nickname: str = ""
    text: str = ""
    data: dict = {}


class AdminActivityListOut(BaseModel):
    items: List[AdminActivityItem] = []


class AdminScreenOut(BaseModel):
    """数据大屏聚合（单接口减少大屏请求数）：指标 + 路线总览 + 7 日趋势 + 实时动态。"""

    metrics: AdminDashboardMetrics
    route_overview: List[AdminRouteOverviewItem] = []
    trend: List[AdminTrendPoint] = []
    activities: List[AdminActivityItem] = []


class AdminOrgNodeOut(BaseModel):
    """组织架构树节点（含 children，供前端 el-table 树形展示）。

    direct_user_count 为直接归属该组织的用户数；total_user_count 为含全部下级的累计用户数。
    """

    id: int
    name: str
    parent_id: Optional[int] = None
    level: int = 1
    sort_order: int = 0
    direct_user_count: int = 0
    total_user_count: int = 0
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


class AdminOrgUserOut(BaseModel):
    """组织人员明细条目（字段复用排名洞察的人员展示口径）。"""

    user_id: int
    nickname: str
    avatar: str = ""
    org_name: str = ""
    created_at: Optional[datetime] = None

    @field_validator("avatar", mode="before")
    @classmethod
    def empty_avatar(cls, value: Optional[str]) -> str:
        return value or ""


class AdminOrgUserListOut(BaseModel):
    """组织人员明细分页结果（scope=direct 直属 / scope=all 含全部下级）。"""

    total: int = 0
    items: List[AdminOrgUserOut] = []


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
    brief: str = ""
    significance: str = ""
    figures: str = ""
    location: str = ""
    images: List[str] = []
    audio: str = ""
    keywords: str = ""

    model_config = ConfigDict(from_attributes=True)

    @field_validator(
        "brief", "significance", "figures", "location", "audio", "keywords", mode="before"
    )
    @classmethod
    def none_to_empty(cls, value: Optional[str]) -> str:
        """本库空串按 NULL 存储（Oracle 兼容），读出 None 归一为空串。"""
        return value or ""

    @field_validator("images", mode="before")
    @classmethod
    def none_images(cls, value: Optional[list]) -> list:
        return value or []


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
    brief: str = Field(default="", max_length=200)
    significance: str = ""
    figures: str = Field(default="", max_length=500)
    location: str = Field(default="", max_length=100)
    images: List[str] = []
    audio: str = Field(default="", max_length=500)
    keywords: str = Field(default="", max_length=200)


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
    original_nickname: str = ""
    nickname_changed_at: Optional[datetime] = None
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
    """人员详情：基本信息（含昵称修改记录）。"""

    user_id: int
    nickname: str
    avatar: str = ""
    org_name: str = ""
    original_nickname: str = ""
    nickname_changed_at: Optional[datetime] = None
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
