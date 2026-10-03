"""静态配置数据与种子初始化。

数据精确迁移自前端 mock/data.js：长征路线节点(10)、题库(15)、勋章定义(12)。
init_seed 幂等：
- 表为空时全量写入；
- 表非空时仅「补空值/补新勋章 id」——节点历史内容、题目分类只填空字段，
  尊重管理端已做的编辑与删除（不复活被删节点/题目）。
"""
from sqlalchemy.orm import Session

from app.models.models import MedalDef, Organization, Person, PersonNode, Question, RouteNode

# ---------------- 长征人物志（需求 §14）----------------
# 人物来源于节点 figures 字段中的真实历史人物（群体表述如「全体红军指战员」不单列）；
# 简介仅采用公开史料记载，不虚构；avatar 留空由前端展示姓名首字占位。
PERSONS = [
    {"id": 1, "name": "毛泽东", "brief": "中共中央领导人。遵义会议确立其在党中央和红军的领导地位，指挥四渡赤水、巧渡金沙江，率红军主力抵达陕北。"},
    {"id": 2, "name": "朱德", "brief": "中革军委主席、红军总司令。与毛泽东等指挥中央红军战略转移，翻越雪山、走过草地，抵达陕北。"},
    {"id": 3, "name": "周恩来", "brief": "中革军委副主席。遵义会议支持毛泽东的正确主张，会后参与三人军事指挥小组，共同指挥红军行动。"},
    {"id": 4, "name": "张闻天", "brief": "遵义会议后代替博古在党中央负总责，支持毛泽东的军事指挥，为会议精神的贯彻发挥了重要作用。"},
    {"id": 5, "name": "王稼祥", "brief": "遵义会议的关键支持者，第一个明确提出应让毛泽东指挥红军。会后与毛泽东、周恩来组成三人军事指挥小组。"},
    {"id": 6, "name": "刘伯承", "brief": "红军总参谋长。指挥先遣队巧渡金沙江，途经大凉山与彝族首领小叶丹歃血为盟，又指挥强渡大渡河。"},
    {"id": 7, "name": "陈赓", "brief": "中央纵队干部团团长。率干部团参加巧渡金沙江等战斗，屡建奇功。"},
    {"id": 8, "name": "聂荣臻", "brief": "红一军团政治委员。与林彪率红一军团为前锋，参与指挥强渡大渡河、飞夺泸定桥等战斗。"},
    {"id": 9, "name": "孙继先", "brief": "红一军团第一师第一团第一营营长。1935年5月亲自挑选并率领十七勇士强渡大渡河。"},
    {"id": 10, "name": "王开湘", "brief": "红四团团长。与政委杨成武率部一昼夜奔袭240里，飞夺泸定桥。"},
    {"id": 11, "name": "杨成武", "brief": "红四团政治委员。与团长王开湘率部飞夺泸定桥，后又率部突破腊子口。"},
    {"id": 12, "name": "廖大珠", "brief": "红四团第一营第二连连长。飞夺泸定桥突击队队长，率22名突击队员攀踏铁索夺桥。"},
    {"id": 13, "name": "彭德怀", "brief": "红三军团军团长。率部屡建战功，到达陕北后指挥吴起镇战役，击溃尾随的骑兵。"},
]

# 人物 ↔ 节点关联（与节点 figures 字段口径一致）
PERSON_NODES = [
    (1, 1), (2, 1), (3, 1),          # 瑞金：毛泽东、朱德、周恩来
    (1, 2), (3, 2), (4, 2), (5, 2),  # 遵义：毛泽东、周恩来、张闻天、王稼祥
    (1, 3), (2, 3),                  # 四渡赤水：毛泽东、朱德
    (6, 4), (7, 4),                  # 巧渡金沙江：刘伯承、陈赓
    (6, 5), (8, 5), (9, 5),          # 强渡大渡河：刘伯承、聂荣臻、孙继先
    (10, 6), (11, 6), (12, 6),       # 飞夺泸定桥：王开湘、杨成武、廖大珠
    (1, 9), (13, 9),                 # 吴起镇：毛泽东、彭德怀
    (1, 10), (2, 10), (3, 10),       # 延安：毛泽东、朱德、周恩来
]

# ---------------- 长征路线节点（10 个）----------------
# target_steps 为累计步数要求；节点一旦点亮永久保留。
# brief 简短描述 / significance 历史意义 / figures 相关人物 / location 地理位置文字 /
# images 历史图片 / audio 音频 / keywords 关键词（彩蛋匹配与检索用）。
ROUTE_NODES = [
    {
        "id": 1, "name": "瑞金", "target_steps": 0, "historical_time": "1934年10月", "icon": "🚩",
        "description": "1934年10月，中央红军从江西瑞金出发，开始了举世闻名的二万五千里长征。瑞金是中华苏维埃共和国临时中央政府所在地，被称为“红色故都”。",
        "brief": "中央红军长征出发地，“红色故都”。",
        "significance": "长征从这里起步。这次战略转移保存了党和红军的基干力量，为中国革命的最终胜利奠定了基础。",
        "figures": "毛泽东、朱德、周恩来等",
        "location": "江西瑞金",
        "images": [], "audio": "",
        "keywords": "出发地,红色故都,中华苏维埃",
        "latitude": 25.885, "longitude": 116.027, "sort_order": 1, "is_enabled": True,
    },
    {
        "id": 2, "name": "遵义", "target_steps": 5000, "historical_time": "1935年1月", "icon": "🏛️",
        "description": "1935年1月，中共中央在遵义召开政治局扩大会议（遵义会议），确立了毛泽东同志在党中央和红军的领导地位，在极端危急的关头挽救了党、挽救了红军、挽救了中国革命。",
        "brief": "遵义会议召开，中国革命生死攸关的伟大转折。",
        "significance": "会议事实上确立了毛泽东同志在党中央和红军的领导地位，在最危急关头挽救了党、挽救了红军、挽救了中国革命，是党的历史上一个生死攸关的转折点。",
        "figures": "毛泽东、周恩来、张闻天、王稼祥等",
        "location": "贵州遵义",
        "images": [], "audio": "",
        "keywords": "遵义会议,转折点,政治局扩大会议",
        "latitude": 27.72, "longitude": 106.93, "sort_order": 2, "is_enabled": True,
    },
    {
        "id": 3, "name": "四渡赤水", "target_steps": 10000, "historical_time": "1935年1-3月", "icon": "🌊",
        "description": "1935年初，中央红军在赤水河流域四次渡河，灵活机动地调动和迷惑敌人，跳出国民党军重兵包围圈，是毛泽东军事指挥艺术的“得意之笔”。",
        "brief": "红军四渡赤水河，跳出数十万重兵包围圈。",
        "significance": "四渡赤水是红军长征中以少胜多、变被动为主动的光辉战例，被誉为毛泽东军事指挥艺术的“得意之笔”。",
        "figures": "毛泽东、朱德等",
        "location": "川黔滇交界·赤水河流域",
        "images": [], "audio": "",
        "keywords": "赤水河,运动战,出奇制胜",
        "latitude": 28.3, "longitude": 106.42, "sort_order": 3, "is_enabled": True,
    },
    {
        "id": 4, "name": "巧渡金沙江", "target_steps": 15000, "historical_time": "1935年5月", "icon": "⛵",
        "description": "1935年5月，红军仅凭7条小船，在皎平渡用七天七夜巧渡金沙江，摆脱了数十万敌军的围追堵截，取得了战略转移中具有决定意义的胜利。",
        "brief": "仅凭 7 条小船，七天七夜巧渡金沙江。",
        "significance": "巧渡金沙江使红军摆脱了数十万敌军的围追堵截，取得了战略转移中具有决定意义的胜利。",
        "figures": "刘伯承、陈赓等",
        "location": "云南禄劝·皎平渡",
        "images": [], "audio": "",
        "keywords": "金沙江,皎平渡,渡江",
        "latitude": 26.28, "longitude": 102.47, "sort_order": 4, "is_enabled": True,
    },
    {
        "id": 5, "name": "强渡大渡河", "target_steps": 20000, "historical_time": "1935年5月", "icon": "⚔️",
        "description": "1935年5月，红军先遣队在安顺场强渡大渡河，十七勇士冒着枪林弹雨渡河成功，为红军主力打开了北上的通道。",
        "brief": "十七勇士冒着枪林弹雨强渡大渡河。",
        "significance": "强渡大渡河粉碎了敌军凭借大渡河天险围歼红军的企图，为红军主力打开了北上的通道。",
        "figures": "刘伯承、聂荣臻、孙继先及十七勇士",
        "location": "四川石棉·安顺场",
        "images": [], "audio": "",
        "keywords": "大渡河,安顺场,十七勇士",
        "latitude": 29.25, "longitude": 102.3, "sort_order": 5, "is_enabled": True,
    },
    {
        "id": 6, "name": "飞夺泸定桥", "target_steps": 25000, "historical_time": "1935年5月29日", "icon": "🌉",
        "description": "1935年5月29日，红军22名突击队员在泸定桥铁索上匍匐前进，冒着敌人火力夺取桥头，创造了长征中的英雄壮举。",
        "brief": "22 名突击队员飞夺泸定桥铁索。",
        "significance": "飞夺泸定桥创造了长征中的英雄壮举，打开了红军北上的关键通道，粉碎了敌军把红军变成“石达开第二”的图谋。",
        "figures": "王开湘、杨成武、廖大珠等 22 名突击队员",
        "location": "四川泸定",
        "images": [], "audio": "",
        "keywords": "泸定桥,铁索桥,22勇士",
        "latitude": 29.91, "longitude": 102.24, "sort_order": 6, "is_enabled": True,
    },
    {
        "id": 7, "name": "翻越雪山", "target_steps": 35000, "historical_time": "1935年6月", "icon": "🏔️",
        "description": "1935年6月，红军翻越了终年积雪、空气稀薄的夹金山等大雪山，许多战士长眠于雪山之上，用生命诠释了坚定的理想信念。",
        "brief": "翻越终年积雪、空气稀薄的夹金山。",
        "significance": "红军以惊人毅力战胜高寒缺氧的极端自然环境，许多战士长眠雪山，用生命诠释了坚定的理想信念。",
        "figures": "全体红军指战员",
        "location": "四川宝兴·夹金山",
        "images": [], "audio": "",
        "keywords": "夹金山,雪山,高寒缺氧",
        "latitude": 30.75, "longitude": 102.65, "sort_order": 7, "is_enabled": True,
    },
    {
        "id": 8, "name": "过草地", "target_steps": 45000, "historical_time": "1935年8月", "icon": "🌾",
        "description": "1935年8月，红军穿越人迹罕至的松潘草地。草地沼泽遍布、气候恶劣，红军指战员以顽强的意志走出了这片“死亡之地”。",
        "brief": "穿越沼泽遍布的“死亡之地”松潘草地。",
        "significance": "红军以野菜草根充饥、以顽强意志征服茫茫草地，保存了革命火种，展现了压倒一切困难的英雄气概。",
        "figures": "全体红军指战员",
        "location": "四川·松潘草地",
        "images": [], "audio": "",
        "keywords": "松潘草地,沼泽,野菜草根",
        "latitude": 33.58, "longitude": 102.96, "sort_order": 8, "is_enabled": True,
    },
    {
        "id": 9, "name": "吴起镇", "target_steps": 55000, "historical_time": "1935年10月", "icon": "🎺",
        "description": "1935年10月，中央红军到达陕甘革命根据地的吴起镇，与陕北红军胜利会师，宣告中央红军长征胜利结束。",
        "brief": "中央红军到达吴起镇，与陕北红军胜利会师。",
        "significance": "吴起镇会师宣告中央红军长征胜利结束，党中央和红军主力在陕北站稳脚跟，开创了革命新局面。",
        "figures": "毛泽东、彭德怀等",
        "location": "陕西吴起",
        "images": [], "audio": "",
        "keywords": "吴起镇,会师,陕北",
        "latitude": 36.92, "longitude": 108.18, "sort_order": 9, "is_enabled": True,
    },
    {
        "id": 10, "name": "延安", "target_steps": 65000, "historical_time": "1936年10月", "icon": "⭐",
        "description": "延安是中共中央所在地和中国革命的圣地。红军三大主力会师后，中国革命的大本营扎根西北，延安成为指引中国革命的灯塔。",
        "brief": "三大主力会师，革命大本营扎根西北。",
        "significance": "1936年10月红军三大主力会师，长征胜利结束。延安此后成为中共中央所在地和指引中国革命胜利的灯塔。",
        "figures": "毛泽东、朱德、周恩来等",
        "location": "陕西延安",
        "images": [], "audio": "",
        "keywords": "延安,三大主力会师,革命圣地",
        "latitude": 36.6, "longitude": 109.49, "sort_order": 10, "is_enabled": True,
    },
]

# ---------------- 题库（15 题）----------------
# type: single 单选 / judge 判断；每题 score 分。
# category 知识画像分类：event 历史事件 / route 长征路线 / figure 历史人物。
QUESTION_BANK = [
    {
        "id": 1, "type": "single", "question": "遵义会议召开于哪一年？", "category": "event",
        "options": [{"label": "A", "text": "1934年"}, {"label": "B", "text": "1935年"}, {"label": "C", "text": "1936年"}, {"label": "D", "text": "1937年"}],
        "answer": ["B"], "analysis": "遵义会议于1935年1月召开，是长征途中具有重要历史意义的会议。", "score": 20,
    },
    {
        "id": 2, "type": "single", "question": "中央红军长征的出发地是哪里？", "category": "route",
        "options": [{"label": "A", "text": "瑞金"}, {"label": "B", "text": "延安"}, {"label": "C", "text": "遵义"}, {"label": "D", "text": "井冈山"}],
        "answer": ["A"], "analysis": "中央红军于1934年10月从中央革命根据地出发开始长征。", "score": 20,
    },
    {
        "id": 3, "type": "single", "question": "下列哪一项属于红军长征中的著名战役？", "category": "event",
        "options": [{"label": "A", "text": "四渡赤水"}, {"label": "B", "text": "平型关大捷"}, {"label": "C", "text": "百团大战"}, {"label": "D", "text": "辽沈战役"}],
        "answer": ["A"], "analysis": "四渡赤水是中央红军长征途中进行的重要战役行动。", "score": 20,
    },
    {
        "id": 4, "type": "judge", "question": "飞夺泸定桥发生在红军长征途中。", "category": "event",
        "options": [{"label": "A", "text": "正确"}, {"label": "B", "text": "错误"}],
        "answer": ["A"], "analysis": "飞夺泸定桥是红军长征中的重要历史事件。", "score": 20,
    },
    {
        "id": 5, "type": "single", "question": "中央红军长征胜利会师的重要地点是哪里？", "category": "route",
        "options": [{"label": "A", "text": "吴起镇"}, {"label": "B", "text": "上海"}, {"label": "C", "text": "南京"}, {"label": "D", "text": "广州"}],
        "answer": ["A"], "analysis": "1935年10月，中央红军到达陕甘革命根据地的吴起镇，与当地红军会师。", "score": 20,
    },
    {
        "id": 6, "type": "single", "question": "长征途中具有转折意义、被称为“中国革命生死攸关的转折点”的会议是？", "category": "event",
        "options": [{"label": "A", "text": "遵义会议"}, {"label": "B", "text": "古田会议"}, {"label": "C", "text": "瓦窑堡会议"}, {"label": "D", "text": "洛川会议"}],
        "answer": ["A"], "analysis": "遵义会议在极其危急的历史关头挽救了党、挽救了红军、挽救了中国革命。", "score": 20,
    },
    {
        "id": 7, "type": "judge", "question": "红军长征翻越的第一座大雪山是夹金山。", "category": "route",
        "options": [{"label": "A", "text": "正确"}, {"label": "B", "text": "错误"}],
        "answer": ["A"], "analysis": "1935年6月，红军翻越的第一座大雪山是海拔4000多米的夹金山。", "score": 20,
    },
    {
        "id": 8, "type": "single", "question": "“长征是宣言书，长征是宣传队，长征是播种机”出自谁的论述？", "category": "figure",
        "options": [{"label": "A", "text": "毛泽东"}, {"label": "B", "text": "周恩来"}, {"label": "C", "text": "朱德"}, {"label": "D", "text": "彭德怀"}],
        "answer": ["A"], "analysis": "毛泽东同志在《论反对日本帝国主义的策略》中作出这一著名论述。", "score": 20,
    },
    {
        "id": 9, "type": "single", "question": "中央红军长征的起止时间大致是？", "category": "route",
        "options": [{"label": "A", "text": "1933年10月至1935年10月"}, {"label": "B", "text": "1934年10月至1935年10月"}, {"label": "C", "text": "1934年10月至1936年10月"}, {"label": "D", "text": "1935年10月至1936年10月"}],
        "answer": ["B"], "analysis": "中央红军1934年10月从江西出发，1935年10月到达陕北吴起镇。", "score": 20,
    },
    {
        "id": 10, "type": "judge", "question": "巧渡金沙江使红军摆脱了数十万敌军的围追堵截。", "category": "event",
        "options": [{"label": "A", "text": "正确"}, {"label": "B", "text": "错误"}],
        "answer": ["A"], "analysis": "巧渡金沙江是战略转移中具有决定意义的胜利。", "score": 20,
    },
    {
        "id": 11, "type": "single", "question": "以下哪个地点被称为中国革命的圣地？", "category": "route",
        "options": [{"label": "A", "text": "瑞金"}, {"label": "B", "text": "遵义"}, {"label": "C", "text": "延安"}, {"label": "D", "text": "井冈山"}],
        "answer": ["C"], "analysis": "延安是中共中央所在地和中国革命的圣地。", "score": 20,
    },
    {
        "id": 12, "type": "judge", "question": "强渡大渡河的突击队员被称为“十七勇士”。", "category": "figure",
        "options": [{"label": "A", "text": "正确"}, {"label": "B", "text": "错误"}],
        "answer": ["A"], "analysis": "1935年5月，十七勇士率先强渡大渡河成功。", "score": 20,
    },
    {
        "id": 13, "type": "single", "question": "红军长征途中穿越的“死亡之地”松潘草地，其主要危险是？", "category": "route",
        "options": [{"label": "A", "text": "沼泽遍布、气候恶劣"}, {"label": "B", "text": "高山缺氧"}, {"label": "C", "text": "沙漠干旱"}, {"label": "D", "text": "原始森林猛兽"}],
        "answer": ["A"], "analysis": "松潘草地沼泽遍布、天气变化无常，行军极为艰难。", "score": 20,
    },
    {
        "id": 14, "type": "single", "question": "红军三大主力会师、长征全部胜利结束的标志性事件发生在？", "category": "event",
        "options": [{"label": "A", "text": "1936年10月会宁会师"}, {"label": "B", "text": "1935年10月吴起镇会师"}, {"label": "C", "text": "1936年12月西安事变"}, {"label": "D", "text": "1937年7月全面抗战爆发"}],
        "answer": ["A"], "analysis": "1936年10月，红军三大主力在甘肃会宁会师，长征胜利结束。", "score": 20,
    },
    {
        "id": 15, "type": "judge", "question": "遵义会议确立了毛泽东同志在党中央和红军的领导地位。", "category": "event",
        "options": [{"label": "A", "text": "正确"}, {"label": "B", "text": "错误"}],
        "answer": ["A"], "analysis": "遵义会议事实上确立了毛泽东同志在党中央和红军的领导地位。", "score": 20,
    },
]

# ---------------- 勋章定义（12 个）----------------
# 判定逻辑在 services/medal_service.check_and_grant 中实现。
# category: starter 入门 / route 路线 / challenge 挑战 / complete 完成；
# hidden 为 True 的勋章未获得时不公开获取条件（隐藏勋章）。
MEDALS = [
    # 入门勋章
    {"id": "first-step", "name": "初次出发", "icon": "🏃", "desc": "完成第一次运动同步",
     "category": "starter", "hidden": False, "sort_order": 1},
    {"id": "learner", "name": "红色学习者", "icon": "📖", "desc": "完成 10 次每日答题",
     "category": "starter", "hidden": False, "sort_order": 2},
    {"id": "persistence", "name": "坚持不懈", "icon": "🔥", "desc": "连续行军 7 天",
     "category": "starter", "hidden": False, "sort_order": 3},
    # 路线勋章
    {"id": "luding", "name": "飞夺泸定桥", "icon": "🌉", "desc": "点亮“飞夺泸定桥”节点",
     "category": "route", "hidden": False, "sort_order": 4},
    {"id": "snow", "name": "翻越雪山", "icon": "🏔️", "desc": "点亮“翻越雪山”节点",
     "category": "route", "hidden": False, "sort_order": 5},
    # 挑战勋章
    {"id": "day-10k", "name": "日行万步", "icon": "👟", "desc": "单日步数达到 10,000",
     "category": "challenge", "hidden": False, "sort_order": 6},
    {"id": "steps-100k", "name": "十万征程", "icon": "🎖️", "desc": "累计步数达到 100,000",
     "category": "challenge", "hidden": False, "sort_order": 7},
    {"id": "steps-500k", "name": "五十万征程", "icon": "💪", "desc": "累计步数达到 500,000",
     "category": "challenge", "hidden": False, "sort_order": 8},
    {"id": "streak-30", "name": "铁血行军", "icon": "⛺", "desc": "连续行军 30 天",
     "category": "challenge", "hidden": False, "sort_order": 9},
    {"id": "master", "name": "知识达人", "icon": "⭐", "desc": "累计答题积分达到 500",
     "category": "challenge", "hidden": False, "sort_order": 10},
    {"id": "fearless", "name": "不畏艰险", "icon": "🧗", "desc": "连续 7 天每天步数达到 10,000",
     "category": "challenge", "hidden": True, "sort_order": 11},
    # 完成勋章
    {"id": "victory", "name": "长征胜利", "icon": "🏆", "desc": "完成整个长征路线",
     "category": "complete", "hidden": False, "sort_order": 12},
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

# 节点历史事件卡内容字段（种子仅补空值，尊重管理端编辑）
_NODE_CONTENT_FIELDS = ("brief", "significance", "figures", "location", "keywords", "images", "audio")


def _fill_empty(row: object, field: str, value: object) -> None:
    """仅当库中字段为空时回填（空串 / None / 空列表视为空）。"""
    if not getattr(row, field, None):
        setattr(row, field, value)


def _seed_route_nodes(db: Session) -> None:
    """路线节点：空表全量写入；非空表只为既有节点补历史内容空值（不复活被删节点）。"""
    if db.query(RouteNode).count() == 0:
        db.add_all([RouteNode(**node) for node in ROUTE_NODES])
        return
    seed_by_id = {node["id"]: node for node in ROUTE_NODES}
    for row in db.query(RouteNode).all():
        seed = seed_by_id.get(row.id)
        if seed is None:
            continue
        for field in _NODE_CONTENT_FIELDS:
            _fill_empty(row, field, seed[field])


def _seed_questions(db: Session) -> None:
    """题库：空表全量写入；非空表只为既有题目补空分类（不复活被删题目）。"""
    if db.query(Question).count() == 0:
        db.add_all([Question(**q) for q in QUESTION_BANK])
        return
    seed_by_id = {q["id"]: q for q in QUESTION_BANK}
    for row in db.query(Question).all():
        seed = seed_by_id.get(row.id)
        if seed is not None and not row.category:
            row.category = seed["category"]


def _seed_medals(db: Session) -> None:
    """勋章：空表全量写入；非空表补充新增勋章 id，并为既有勋章补空分类/排序。

    当前无勋章管理入口，允许种子补新；name/icon/desc 不覆盖库中现值。
    """
    existing = {m.id: m for m in db.query(MedalDef).all()}
    for medal in MEDALS:
        row = existing.get(medal["id"])
        if row is None:
            db.add(MedalDef(**medal))
            continue
        _fill_empty(row, "category", medal["category"])
        if not row.sort_order:
            row.sort_order = medal["sort_order"]


def _seed_persons(db: Session) -> None:
    """人物志：空表全量写入；非空表补新增人物 id、为既有人物补空简介（不覆盖编辑）。

    关联表只增不删：补齐缺失的 (person_id, node_id) 对，尊重手工调整过的关联。
    """
    existing = {p.id: p for p in db.query(Person).all()}
    for person in PERSONS:
        row = existing.get(person["id"])
        if row is None:
            db.add(Person(**person))
            continue
        _fill_empty(row, "brief", person["brief"])
    node_ids = {n.id for n in db.query(RouteNode.id).all()}
    existing_pairs = {(pn.person_id, pn.node_id) for pn in db.query(PersonNode).all()}
    for person_id, node_id in PERSON_NODES:
        if (person_id, node_id) not in existing_pairs and node_id in node_ids:
            db.add(PersonNode(person_id=person_id, node_id=node_id))


def init_seed(db: Session) -> None:
    """幂等写入静态配置数据（路线 / 题库 / 勋章 / 组织架构 / 人物志）。"""
    _seed_route_nodes(db)
    _seed_questions(db)
    _seed_medals(db)
    _seed_persons(db)
    if db.query(Organization).count() == 0:
        db.add_all([Organization(**o) for o in ORGANIZATIONS])
    db.commit()
