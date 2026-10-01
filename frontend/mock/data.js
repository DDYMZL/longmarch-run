/**
 * Mock 数据：长征路线节点、题库、勋章定义
 * 正式上线时由后台配置下发
 */

/**
 * 长征路线节点（10 个），网络不可用且无缓存时使用。
 */
const ROUTE_NODES = [
  {
    id: 1,
    name: '瑞金',
    targetSteps: 0,
    historicalTime: '1934年10月',
    icon: '🚩',
    description: '1934年10月，中央红军从江西瑞金出发，开始了举世闻名的二万五千里长征。瑞金是中华苏维埃共和国临时中央政府所在地，被称为"红色故都"。',
    latitude: 25.885,
    longitude: 116.027,
    sortOrder: 1,
    isEnabled: true
  },
  {
    id: 2,
    name: '遵义',
    targetSteps: 5000,
    historicalTime: '1935年1月',
    icon: '🏛️',
    description: '1935年1月，中共中央在遵义召开政治局扩大会议（遵义会议），确立了毛泽东同志在党中央和红军的领导地位，在极端危急的关头挽救了党、挽救了红军、挽救了中国革命。',
    latitude: 27.72,
    longitude: 106.93,
    sortOrder: 2,
    isEnabled: true
  },
  {
    id: 3,
    name: '四渡赤水',
    targetSteps: 10000,
    historicalTime: '1935年1-3月',
    icon: '🌊',
    description: '1935年初，中央红军在赤水河流域四次渡河，灵活机动地调动和迷惑敌人，跳出国民党军重兵包围圈，是毛泽东军事指挥艺术的"得意之笔"。',
    latitude: 28.3,
    longitude: 106.42,
    sortOrder: 3,
    isEnabled: true
  },
  {
    id: 4,
    name: '巧渡金沙江',
    targetSteps: 15000,
    historicalTime: '1935年5月',
    icon: '⛵',
    description: '1935年5月，红军仅凭7条小船，在皎平渡用七天七夜巧渡金沙江，摆脱了数十万敌军的围追堵截，取得了战略转移中具有决定意义的胜利。',
    latitude: 26.28,
    longitude: 102.47,
    sortOrder: 4,
    isEnabled: true
  },
  {
    id: 5,
    name: '强渡大渡河',
    targetSteps: 20000,
    historicalTime: '1935年5月',
    icon: '⚔️',
    description: '1935年5月，红军先遣队在安顺场强渡大渡河，十七勇士冒着枪林弹雨渡河成功，为红军主力打开了北上的通道。',
    latitude: 29.25,
    longitude: 102.3,
    sortOrder: 5,
    isEnabled: true
  },
  {
    id: 6,
    name: '飞夺泸定桥',
    targetSteps: 25000,
    historicalTime: '1935年5月29日',
    icon: '🌉',
    description: '1935年5月29日，红军22名突击队员在泸定桥铁索上匍匐前进，冒着敌人火力夺取桥头，创造了长征中的英雄壮举。',
    latitude: 29.91,
    longitude: 102.24,
    sortOrder: 6,
    isEnabled: true
  },
  {
    id: 7,
    name: '翻越雪山',
    targetSteps: 35000,
    historicalTime: '1935年6月',
    icon: '🏔️',
    description: '1935年6月，红军翻越了终年积雪、空气稀薄的夹金山等大雪山，许多战士长眠于雪山之上，用生命诠释了坚定的理想信念。',
    latitude: 30.75,
    longitude: 102.65,
    sortOrder: 7,
    isEnabled: true
  },
  {
    id: 8,
    name: '过草地',
    targetSteps: 45000,
    historicalTime: '1935年8月',
    icon: '🌾',
    description: '1935年8月，红军穿越人迹罕至的松潘草地。草地沼泽遍布、气候恶劣，红军指战员以顽强的意志走出了这片"死亡之地"。',
    latitude: 33.58,
    longitude: 102.96,
    sortOrder: 8,
    isEnabled: true
  },
  {
    id: 9,
    name: '吴起镇',
    targetSteps: 55000,
    historicalTime: '1935年10月',
    icon: '🎺',
    description: '1935年10月，中央红军到达陕甘革命根据地的吴起镇，与陕北红军胜利会师，宣告中央红军长征胜利结束。',
    latitude: 36.92,
    longitude: 108.18,
    sortOrder: 9,
    isEnabled: true
  },
  {
    id: 10,
    name: '延安',
    targetSteps: 65000,
    historicalTime: '1936年10月',
    icon: '⭐',
    description: '延安是中共中央所在地和中国革命的圣地。红军三大主力会师后，中国革命的大本营扎根西北，延安成为指引中国革命的灯塔。',
    latitude: 36.6,
    longitude: 109.49,
    sortOrder: 10,
    isEnabled: true
  }
];

/**
 * Mock 题库
 * type: single 单选 / judge 判断
 * 注意：正式环境题目接口不应返回 answer/analysis，Mock 阶段前端暂存
 */
const QUESTION_BANK = [
  {
    id: 1,
    type: 'single',
    question: '遵义会议召开于哪一年？',
    options: [
      { label: 'A', text: '1934年' },
      { label: 'B', text: '1935年' },
      { label: 'C', text: '1936年' },
      { label: 'D', text: '1937年' }
    ],
    answer: ['B'],
    analysis: '遵义会议于1935年1月召开，是长征途中具有重要历史意义的会议。',
    score: 20
  },
  {
    id: 2,
    type: 'single',
    question: '中央红军长征的出发地是哪里？',
    options: [
      { label: 'A', text: '瑞金' },
      { label: 'B', text: '延安' },
      { label: 'C', text: '遵义' },
      { label: 'D', text: '井冈山' }
    ],
    answer: ['A'],
    analysis: '中央红军于1934年10月从中央革命根据地出发开始长征。',
    score: 20
  },
  {
    id: 3,
    type: 'single',
    question: '下列哪一项属于红军长征中的著名战役？',
    options: [
      { label: 'A', text: '四渡赤水' },
      { label: 'B', text: '平型关大捷' },
      { label: 'C', text: '百团大战' },
      { label: 'D', text: '辽沈战役' }
    ],
    answer: ['A'],
    analysis: '四渡赤水是中央红军长征途中进行的重要战役行动。',
    score: 20
  },
  {
    id: 4,
    type: 'judge',
    question: '飞夺泸定桥发生在红军长征途中。',
    options: [
      { label: 'A', text: '正确' },
      { label: 'B', text: '错误' }
    ],
    answer: ['A'],
    analysis: '飞夺泸定桥是红军长征中的重要历史事件。',
    score: 20
  },
  {
    id: 5,
    type: 'single',
    question: '中央红军长征胜利会师的重要地点是哪里？',
    options: [
      { label: 'A', text: '吴起镇' },
      { label: 'B', text: '上海' },
      { label: 'C', text: '南京' },
      { label: 'D', text: '广州' }
    ],
    answer: ['A'],
    analysis: '1935年10月，中央红军到达陕甘革命根据地的吴起镇，与当地红军会师。',
    score: 20
  },
  {
    id: 6,
    type: 'single',
    question: '长征途中具有转折意义、被称为"中国革命生死攸关的转折点"的会议是？',
    options: [
      { label: 'A', text: '遵义会议' },
      { label: 'B', text: '古田会议' },
      { label: 'C', text: '瓦窑堡会议' },
      { label: 'D', text: '洛川会议' }
    ],
    answer: ['A'],
    analysis: '遵义会议在极其危急的历史关头挽救了党、挽救了红军、挽救了中国革命。',
    score: 20
  },
  {
    id: 7,
    type: 'judge',
    question: '红军长征翻越的第一座大雪山是夹金山。',
    options: [
      { label: 'A', text: '正确' },
      { label: 'B', text: '错误' }
    ],
    answer: ['A'],
    analysis: '1935年6月，红军翻越的第一座大雪山是海拔4000多米的夹金山。',
    score: 20
  },
  {
    id: 8,
    type: 'single',
    question: '"长征是宣言书，长征是宣传队，长征是播种机"出自谁的论述？',
    options: [
      { label: 'A', text: '毛泽东' },
      { label: 'B', text: '周恩来' },
      { label: 'C', text: '朱德' },
      { label: 'D', text: '彭德怀' }
    ],
    answer: ['A'],
    analysis: '毛泽东同志在《论反对日本帝国主义的策略》中作出这一著名论述。',
    score: 20
  },
  {
    id: 9,
    type: 'single',
    question: '中央红军长征的起止时间大致是？',
    options: [
      { label: 'A', text: '1933年10月至1935年10月' },
      { label: 'B', text: '1934年10月至1935年10月' },
      { label: 'C', text: '1934年10月至1936年10月' },
      { label: 'D', text: '1935年10月至1936年10月' }
    ],
    answer: ['B'],
    analysis: '中央红军1934年10月从江西出发，1935年10月到达陕北吴起镇。',
    score: 20
  },
  {
    id: 10,
    type: 'judge',
    question: '巧渡金沙江使红军摆脱了数十万敌军的围追堵截。',
    options: [
      { label: 'A', text: '正确' },
      { label: 'B', text: '错误' }
    ],
    answer: ['A'],
    analysis: '巧渡金沙江是战略转移中具有决定意义的胜利。',
    score: 20
  },
  {
    id: 11,
    type: 'single',
    question: '以下哪个地点被称为中国革命的圣地？',
    options: [
      { label: 'A', text: '瑞金' },
      { label: 'B', text: '遵义' },
      { label: 'C', text: '延安' },
      { label: 'D', text: '井冈山' }
    ],
    answer: ['C'],
    analysis: '延安是中共中央所在地和中国革命的圣地。',
    score: 20
  },
  {
    id: 12,
    type: 'judge',
    question: '强渡大渡河的突击队员被称为"十七勇士"。',
    options: [
      { label: 'A', text: '正确' },
      { label: 'B', text: '错误' }
    ],
    answer: ['A'],
    analysis: '1935年5月，十七勇士率先强渡大渡河成功。',
    score: 20
  },
  {
    id: 13,
    type: 'single',
    question: '红军长征途中穿越的"死亡之地"松潘草地，其主要危险是？',
    options: [
      { label: 'A', text: '沼泽遍布、气候恶劣' },
      { label: 'B', text: '高山缺氧' },
      { label: 'C', text: '沙漠干旱' },
      { label: 'D', text: '原始森林猛兽' }
    ],
    answer: ['A'],
    analysis: '松潘草地沼泽遍布、天气变化无常，行军极为艰难。',
    score: 20
  },
  {
    id: 14,
    type: 'single',
    question: '红军三大主力会师、长征全部胜利结束的标志性事件发生在？',
    options: [
      { label: 'A', text: '1936年10月会宁会师' },
      { label: 'B', text: '1935年10月吴起镇会师' },
      { label: 'C', text: '1936年12月西安事变' },
      { label: 'D', text: '1937年7月全面抗战爆发' }
    ],
    answer: ['A'],
    analysis: '1936年10月，红军三大主力在甘肃会宁会师，长征胜利结束。',
    score: 20
  },
  {
    id: 15,
    type: 'judge',
    question: '遵义会议确立了毛泽东同志在党中央和红军的领导地位。',
    options: [
      { label: 'A', text: '正确' },
      { label: 'B', text: '错误' }
    ],
    answer: ['A'],
    analysis: '遵义会议事实上确立了毛泽东同志在党中央和红军的领导地位。',
    score: 20
  }
];

/**
 * 勋章定义
 * id: 勋章唯一标识
 * condition 为描述文案，判断逻辑在 services/medal 中实现
 */
const MEDALS = [
  {
    id: 'first-step',
    name: '初次出发',
    icon: '🏃',
    desc: '完成第一次运动同步'
  },
  {
    id: 'learner',
    name: '红色学习者',
    icon: '📖',
    desc: '完成 10 次每日答题'
  },
  {
    id: 'master',
    name: '知识达人',
    icon: '⭐',
    desc: '累计答题积分达到 500'
  },
  {
    id: 'luding',
    name: '飞夺泸定桥',
    icon: '🌉',
    desc: '点亮"飞夺泸定桥"节点'
  },
  {
    id: 'snow',
    name: '翻越雪山',
    icon: '🏔️',
    desc: '点亮"翻越雪山"节点'
  },
  {
    id: 'victory',
    name: '长征胜利',
    icon: '🏆',
    desc: '完成整个长征路线'
  }
];

/**
 * 组织架构（多级树，与后端 seed.ORGANIZATIONS 完全一致）
 * parentId 为空表示顶级；level 为 1 起的层级深度。
 */
const ORGANIZATIONS = [
  { id: 1, name: '长征集团总部', parentId: null, level: 1, sortOrder: 1 },
  { id: 2, name: '华东分公司', parentId: 1, level: 2, sortOrder: 1 },
  { id: 3, name: '华北分公司', parentId: 1, level: 2, sortOrder: 2 },
  { id: 4, name: '华南分公司', parentId: 1, level: 2, sortOrder: 3 },
  { id: 5, name: '市场部', parentId: 2, level: 3, sortOrder: 1 },
  { id: 6, name: '技术部', parentId: 2, level: 3, sortOrder: 2 },
  { id: 7, name: '运营部', parentId: 2, level: 3, sortOrder: 3 },
  { id: 8, name: '市场部', parentId: 3, level: 3, sortOrder: 1 },
  { id: 9, name: '技术部', parentId: 3, level: 3, sortOrder: 2 },
  { id: 10, name: '综合部', parentId: 4, level: 3, sortOrder: 1 },
  { id: 11, name: '销售部', parentId: 4, level: 3, sortOrder: 2 },
  { id: 12, name: '前端组', parentId: 6, level: 4, sortOrder: 1 },
  { id: 13, name: '后端组', parentId: 6, level: 4, sortOrder: 2 }
];

/**
 * Mock 员工（用于无后端时的步数排行榜演示）
 * 真实登录用户会以本人实际累计步数插入榜单，其余为固定模拟对手。
 * steps 为累计步数（模拟历史总和）。
 */
const MOCK_MEMBERS = [
  { id: 'm1', nickname: '张建国', orgId: 1, steps: 128600 },
  { id: 'm2', nickname: '李红梅', orgId: 2, steps: 96400 },
  { id: 'm3', nickname: '王志强', orgId: 6, steps: 88200 },
  { id: 'm4', nickname: '赵晓东', orgId: 12, steps: 76500 },
  { id: 'm5', nickname: '刘敏', orgId: 5, steps: 69800 },
  { id: 'm6', nickname: '陈国华', orgId: 3, steps: 64300 },
  { id: 'm7', nickname: '杨帆', orgId: 9, steps: 58700 },
  { id: 'm8', nickname: '周丽', orgId: 4, steps: 52100 },
  { id: 'm9', nickname: '吴磊', orgId: 11, steps: 47600 },
  { id: 'm10', nickname: '徐婷', orgId: 7, steps: 41200 },
  { id: 'm11', nickname: '孙浩', orgId: 13, steps: 36800 },
  { id: 'm12', nickname: '马俊', orgId: 8, steps: 29400 },
  { id: 'm13', nickname: '朱琳', orgId: 10, steps: 23100 },
  { id: 'm14', nickname: '胡军', orgId: 6, steps: 18600 },
  { id: 'm15', nickname: '郭芳', orgId: 2, steps: 12300 },
  { id: 'm16', nickname: '何平', orgId: 3, steps: 8600 },
  { id: 'm17', nickname: '高远', orgId: 12, steps: 5200 },
  { id: 'm18', nickname: '林静', orgId: 4, steps: 2400 }
];

module.exports = {
  ROUTE_NODES,
  QUESTION_BANK,
  MEDALS,
  ORGANIZATIONS,
  MOCK_MEMBERS
};
