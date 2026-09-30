"""静态配置数据与种子初始化。

数据精确迁移自前端 mock/data.js：长征路线节点(10)、题库(15)、勋章定义(6)。
init_seed 幂等：仅当对应表为空时写入，可安全重复调用。
"""
from sqlalchemy.orm import Session

from app.models.models import MedalDef, Organization, Question, RouteNode

# ---------------- 长征路线节点（10 个）----------------
# target_steps 为累计步数要求；节点一旦点亮永久保留
ROUTE_NODES = [
    {
        "id": 1, "name": "瑞金", "target_steps": 0, "historical_time": "1934年10月", "icon": "🚩",
        "description": "1934年10月，中央红军从江西瑞金出发，开始了举世闻名的二万五千里长征。瑞金是中华苏维埃共和国临时中央政府所在地，被称为“红色故都”。",
    },
    {
        "id": 2, "name": "遵义", "target_steps": 5000, "historical_time": "1935年1月", "icon": "🏛️",
        "description": "1935年1月，中共中央在遵义召开政治局扩大会议（遵义会议），确立了毛泽东同志在党中央和红军的领导地位，在极端危急的关头挽救了党、挽救了红军、挽救了中国革命。",
    },
    {
        "id": 3, "name": "四渡赤水", "target_steps": 10000, "historical_time": "1935年1-3月", "icon": "🌊",
        "description": "1935年初，中央红军在赤水河流域四次渡河，灵活机动地调动和迷惑敌人，跳出国民党军重兵包围圈，是毛泽东军事指挥艺术的“得意之笔”。",
    },
    {
        "id": 4, "name": "巧渡金沙江", "target_steps": 15000, "historical_time": "1935年5月", "icon": "⛵",
        "description": "1935年5月，红军仅凭7条小船，在皎平渡用七天七夜巧渡金沙江，摆脱了数十万敌军的围追堵截，取得了战略转移中具有决定意义的胜利。",
    },
    {
        "id": 5, "name": "强渡大渡河", "target_steps": 20000, "historical_time": "1935年5月", "icon": "⚔️",
        "description": "1935年5月，红军先遣队在安顺场强渡大渡河，十七勇士冒着枪林弹雨渡河成功，为红军主力打开了北上的通道。",
    },
    {
        "id": 6, "name": "飞夺泸定桥", "target_steps": 25000, "historical_time": "1935年5月29日", "icon": "🌉",
        "description": "1935年5月29日，红军22名突击队员在泸定桥铁索上匍匐前进，冒着敌人火力夺取桥头，创造了长征中的英雄壮举。",
    },
    {
        "id": 7, "name": "翻越雪山", "target_steps": 35000, "historical_time": "1935年6月", "icon": "🏔️",
        "description": "1935年6月，红军翻越了终年积雪、空气稀薄的夹金山等大雪山，许多战士长眠于雪山之上，用生命诠释了坚定的理想信念。",
    },
    {
        "id": 8, "name": "过草地", "target_steps": 45000, "historical_time": "1935年8月", "icon": "🌾",
        "description": "1935年8月，红军穿越人迹罕至的松潘草地。草地沼泽遍布、气候恶劣，红军指战员以顽强的意志走出了这片“死亡之地”。",
    },
    {
        "id": 9, "name": "吴起镇", "target_steps": 55000, "historical_time": "1935年10月", "icon": "🎺",
        "description": "1935年10月，中央红军到达陕甘革命根据地的吴起镇，与陕北红军胜利会师，宣告中央红军长征胜利结束。",
    },
    {
        "id": 10, "name": "延安", "target_steps": 65000, "historical_time": "1936年10月", "icon": "⭐",
        "description": "延安是中共中央所在地和中国革命的圣地。红军三大主力会师后，中国革命的大本营扎根西北，延安成为指引中国革命的灯塔。",
    },
]

# ---------------- 题库（15 题）----------------
# type: single 单选 / judge 判断；每题 score 分
QUESTION_BANK = [
    {
        "id": 1, "type": "single", "question": "遵义会议召开于哪一年？",
        "options": [{"label": "A", "text": "1934年"}, {"label": "B", "text": "1935年"}, {"label": "C", "text": "1936年"}, {"label": "D", "text": "1937年"}],
        "answer": ["B"], "analysis": "遵义会议于1935年1月召开，是长征途中具有重要历史意义的会议。", "score": 20,
    },
    {
        "id": 2, "type": "single", "question": "中央红军长征的出发地是哪里？",
        "options": [{"label": "A", "text": "瑞金"}, {"label": "B", "text": "延安"}, {"label": "C", "text": "遵义"}, {"label": "D", "text": "井冈山"}],
        "answer": ["A"], "analysis": "中央红军于1934年10月从中央革命根据地出发开始长征。", "score": 20,
    },
    {
        "id": 3, "type": "single", "question": "下列哪一项属于红军长征中的著名战役？",
        "options": [{"label": "A", "text": "四渡赤水"}, {"label": "B", "text": "平型关大捷"}, {"label": "C", "text": "百团大战"}, {"label": "D", "text": "辽沈战役"}],
        "answer": ["A"], "analysis": "四渡赤水是中央红军长征途中进行的重要战役行动。", "score": 20,
    },
    {
        "id": 4, "type": "judge", "question": "飞夺泸定桥发生在红军长征途中。",
        "options": [{"label": "A", "text": "正确"}, {"label": "B", "text": "错误"}],
        "answer": ["A"], "analysis": "飞夺泸定桥是红军长征中的重要历史事件。", "score": 20,
    },
    {
        "id": 5, "type": "single", "question": "中央红军长征胜利会师的重要地点是哪里？",
        "options": [{"label": "A", "text": "吴起镇"}, {"label": "B", "text": "上海"}, {"label": "C", "text": "南京"}, {"label": "D", "text": "广州"}],
        "answer": ["A"], "analysis": "1935年10月，中央红军到达陕甘革命根据地的吴起镇，与当地红军会师。", "score": 20,
    },
    {
        "id": 6, "type": "single", "question": "长征途中具有转折意义、被称为“中国革命生死攸关的转折点”的会议是？",
        "options": [{"label": "A", "text": "遵义会议"}, {"label": "B", "text": "古田会议"}, {"label": "C", "text": "瓦窑堡会议"}, {"label": "D", "text": "洛川会议"}],
        "answer": ["A"], "analysis": "遵义会议在极其危急的历史关头挽救了党、挽救了红军、挽救了中国革命。", "score": 20,
    },
    {
        "id": 7, "type": "judge", "question": "红军长征翻越的第一座大雪山是夹金山。",
        "options": [{"label": "A", "text": "正确"}, {"label": "B", "text": "错误"}],
        "answer": ["A"], "analysis": "1935年6月，红军翻越的第一座大雪山是海拔4000多米的夹金山。", "score": 20,
    },
    {
        "id": 8, "type": "single", "question": "“长征是宣言书，长征是宣传队，长征是播种机”出自谁的论述？",
        "options": [{"label": "A", "text": "毛泽东"}, {"label": "B", "text": "周恩来"}, {"label": "C", "text": "朱德"}, {"label": "D", "text": "彭德怀"}],
        "answer": ["A"], "analysis": "毛泽东同志在《论反对日本帝国主义的策略》中作出这一著名论述。", "score": 20,
    },
    {
        "id": 9, "type": "single", "question": "中央红军长征的起止时间大致是？",
        "options": [{"label": "A", "text": "1933年10月至1935年10月"}, {"label": "B", "text": "1934年10月至1935年10月"}, {"label": "C", "text": "1934年10月至1936年10月"}, {"label": "D", "text": "1935年10月至1936年10月"}],
        "answer": ["B"], "analysis": "中央红军1934年10月从江西出发，1935年10月到达陕北吴起镇。", "score": 20,
    },
    {
        "id": 10, "type": "judge", "question": "巧渡金沙江使红军摆脱了数十万敌军的围追堵截。",
        "options": [{"label": "A", "text": "正确"}, {"label": "B", "text": "错误"}],
        "answer": ["A"], "analysis": "巧渡金沙江是战略转移中具有决定意义的胜利。", "score": 20,
    },
    {
        "id": 11, "type": "single", "question": "以下哪个地点被称为中国革命的圣地？",
        "options": [{"label": "A", "text": "瑞金"}, {"label": "B", "text": "遵义"}, {"label": "C", "text": "延安"}, {"label": "D", "text": "井冈山"}],
        "answer": ["C"], "analysis": "延安是中共中央所在地和中国革命的圣地。", "score": 20,
    },
    {
        "id": 12, "type": "judge", "question": "强渡大渡河的突击队员被称为“十七勇士”。",
        "options": [{"label": "A", "text": "正确"}, {"label": "B", "text": "错误"}],
        "answer": ["A"], "analysis": "1935年5月，十七勇士率先强渡大渡河成功。", "score": 20,
    },
    {
        "id": 13, "type": "single", "question": "红军长征途中穿越的“死亡之地”松潘草地，其主要危险是？",
        "options": [{"label": "A", "text": "沼泽遍布、气候恶劣"}, {"label": "B", "text": "高山缺氧"}, {"label": "C", "text": "沙漠干旱"}, {"label": "D", "text": "原始森林猛兽"}],
        "answer": ["A"], "analysis": "松潘草地沼泽遍布、天气变化无常，行军极为艰难。", "score": 20,
    },
    {
        "id": 14, "type": "single", "question": "红军三大主力会师、长征全部胜利结束的标志性事件发生在？",
        "options": [{"label": "A", "text": "1936年10月会宁会师"}, {"label": "B", "text": "1935年10月吴起镇会师"}, {"label": "C", "text": "1936年12月西安事变"}, {"label": "D", "text": "1937年7月全面抗战爆发"}],
        "answer": ["A"], "analysis": "1936年10月，红军三大主力在甘肃会宁会师，长征胜利结束。", "score": 20,
    },
    {
        "id": 15, "type": "judge", "question": "遵义会议确立了毛泽东同志在党中央和红军的领导地位。",
        "options": [{"label": "A", "text": "正确"}, {"label": "B", "text": "错误"}],
        "answer": ["A"], "analysis": "遵义会议事实上确立了毛泽东同志在党中央和红军的领导地位。", "score": 20,
    },
]

# ---------------- 勋章定义（6 个）----------------
# 判定逻辑在 services/medal_service.check_and_grant 中实现
MEDALS = [
    {"id": "first-step", "name": "初次出发", "icon": "🏃", "desc": "完成第一次运动同步"},
    {"id": "learner", "name": "红色学习者", "icon": "📖", "desc": "完成 10 次每日答题"},
    {"id": "master", "name": "知识达人", "icon": "⭐", "desc": "累计答题积分达到 500"},
    {"id": "luding", "name": "飞夺泸定桥", "icon": "🌉", "desc": "点亮“飞夺泸定桥”节点"},
    {"id": "snow", "name": "翻越雪山", "icon": "🏔️", "desc": "点亮“翻越雪山”节点"},
    {"id": "victory", "name": "长征胜利", "icon": "🏆", "desc": "完成整个长征路线"},
]

# 勋章「点亮指定节点」条件对应的节点 id（与前端 medal.js nodeByName 口径一致）
MEDAL_NODE_MAP = {"luding": 6, "snow": 7}

# ---------------- 组织架构（多级树）----------------
# parent_id 为空表示顶级；level 为层级深度。与前端 mock/data.js ORGANIZATIONS 完全一致。
ORGANIZATIONS = [
    {"id": 1, "name": "长征集团总部", "parent_id": None, "level": 1, "sort_order": 1},
    {"id": 2, "name": "华东分公司", "parent_id": 1, "level": 2, "sort_order": 1},
    {"id": 3, "name": "华北分公司", "parent_id": 1, "level": 2, "sort_order": 2},
    {"id": 4, "name": "华南分公司", "parent_id": 1, "level": 2, "sort_order": 3},
    {"id": 5, "name": "市场部", "parent_id": 2, "level": 3, "sort_order": 1},
    {"id": 6, "name": "技术部", "parent_id": 2, "level": 3, "sort_order": 2},
    {"id": 7, "name": "运营部", "parent_id": 2, "level": 3, "sort_order": 3},
    {"id": 8, "name": "市场部", "parent_id": 3, "level": 3, "sort_order": 1},
    {"id": 9, "name": "技术部", "parent_id": 3, "level": 3, "sort_order": 2},
    {"id": 10, "name": "综合部", "parent_id": 4, "level": 3, "sort_order": 1},
    {"id": 11, "name": "销售部", "parent_id": 4, "level": 3, "sort_order": 2},
    {"id": 12, "name": "前端组", "parent_id": 6, "level": 4, "sort_order": 1},
    {"id": 13, "name": "后端组", "parent_id": 6, "level": 4, "sort_order": 2},
]


def init_seed(db: Session) -> None:
    """幂等写入静态配置数据（路线 / 题库 / 勋章 / 组织架构）。"""
    if db.query(RouteNode).count() == 0:
        db.add_all([RouteNode(**node) for node in ROUTE_NODES])
    if db.query(Question).count() == 0:
        db.add_all([Question(**q) for q in QUESTION_BANK])
    if db.query(MedalDef).count() == 0:
        db.add_all([MedalDef(**m) for m in MEDALS])
    if db.query(Organization).count() == 0:
        db.add_all([Organization(**o) for o in ORGANIZATIONS])
    db.commit()
