/**
 * 星空长征 Canvas 渲染内核（pages/march 星空模式专用）。
 *
 * 职责边界：页面只负责模式切换、数据拉取、手势事件转发与命中后跳转；本模块持有
 * 全部绘制状态（几何采样、星点/粒子、离屏静态层、光晕精灵、观景变换、动画时钟）
 * 与全部绘制逻辑。rAF 循环留在页面（生命周期由 onHide/onUnload 掌控），每帧调 draw(t)。
 *
 * 视觉规则（需求 §13.2/§13.3 + S3「深空 HUD 霓虹流光」重构 + S4 实时叠加层）：
 *   分九层绘制——L0 深空底与暗角 / L1 带刻度经纬网格 / L2 青蓝等高线山峦（wireframe）
 *   / L3 切角 HUD 边框 + 雷达坐标环 / L4 旋转雷达扇形 + 水平扫描带 / L5 路线能量管道
 *   （青蓝外发光 + 金色内核 + 流动虚线）/ L6 节点三态六边环（内含星形）
 *   / L7 实时数据叠加层（全员数据面板 + 我的进度仪表环 + 三态图例）
 *   / L8 WS 飞线（他人点亮事件的数据包沿路线飞向目标节点）。
 *   L0~L3 静态烘焙进离屏层，L4~L6 在观景变换内每帧绘制，L7 与操作提示画在变换之外
 *   （视口固定，不随拖动/缩放移动），L8 在变换内（贴合路线场景坐标）。
 *   **配色铁律**：路线与节点保留金（#F0C65A）/ 红（#FF3D57）叙事色，青蓝（#3FD8FF）
 *   只用于仪器层（网格、边框、坐标环、扫描、管道外发光、面板描边、L7/L8 数据元素）
 *   ——两者不得混用。
 *   节点三态：已点亮=金色六边环+发光金星呼吸 / 当前=红色六边环+脉冲环+红星呼吸 /
 *   未解锁=暗青六边环+暗星点。点亮动画：亮起 → 扩大 → 粒子扩散 → 稳定发光。
 * 性能约束（§13.4）：静态背景离屏烘焙一次；星点/粒子构建期一次性分配，帧内零分配；
 *   金色渐变按 endIdx 缓存，雷达/扫描渐变建一次复用；光晕与雾带用预渲染精灵 drawImage，
 *   不每帧建径向渐变；L7 数值在 setStats 时一次性格式化，进度环百分比按整数变化缓存；
 *   每帧长折线描边 ≤4 次（L5 能量管道三次）、drawImage ≤30 次、
 *   fillText ≤22 次（节点标签 10 + 操作提示 1 + L7 面板 6 + 仪表环 2 + 图例 3）。
 * 帧率自适应降级（S5）：draw(t) 内滚动采样 PERF_WINDOW 帧间隔，均值 > PERF_BUDGET_MS
 *   （即 <30fps）置 lowPerf，关掉 L4 水平扫描带与点亮粒子扩散——两者纯氛围、无信息量；
 *   雷达扇形、L5 流光与全部叙事/数据层保留。**降级不自动恢复**，避免在阈值附近反复
 *   开关造成视觉抖动；暂停/切后台造成的时间跳变样本丢弃，不污染均值。
 *
 * 观景变换 view 由页面手势层直接改写（pan/pinch 数学属于事件层），改完须调 clampView()；
 * 命中测试 hitTest() 内部做屏幕→场景逆变换。
 */
const routeCanvas = require('./routeCanvas');
const nodeThemes = require('../data/node-themes');

// 云朵 / 薄雾（相对坐标 + 尺度 + 速度）
const CLOUDS = [
  { x: 0.12, y: 0.14, s: 1.0, v: 0.012 },
  { x: 0.52, y: 0.07, s: 0.7, v: 0.02 },
  { x: 0.88, y: 0.2, s: 0.85, v: 0.016 }
];

// 星色（冷白为主，少量暖白/淡蓝增加层次）
const STAR_TINTS = ['#EAF2FF', '#EAF2FF', '#EAF2FF', '#FFF1D6', '#CFE0FF'];

/* ---- 深空 HUD 配色与仪器参数（S3）----
 * CYAN 以「r,g,b」形式存放，便于按不同透明度拼 rgba()；金红叙事色沿用各绘制处的字面值。
 */
const CYAN = '63,216,255'; // #3FD8FF，仪器层唯一主色
const CYAN_HEX = '#3FD8FF'; // 同上，需整色（非 rgba 拼接）时使用，避免帧内字符串分配
const DEEP_SKY = ['#050B16', '#08111F', '#0A1826', '#0E1B2E']; // L0 深空底色带（上→下）
const GRID = 42; // L1 网格间距（px），每 4 格一条亮主线
const RADAR_R = 0.4; // L3 雷达坐标环半径（相对 min(cw,ch)）
const SWEEP_S = 7; // L4 雷达扇形旋转一周秒数
const SWEEP_ARC = 1.05; // L4 扇形张角（弧度）
const SCAN_S = 9; // L4 水平扫描带自上而下一趟的秒数
const HINT_TEXT = '拖动平移 · 双指缩放 · 双击复位 · 点节点看历史';
const FLY_MS = 1400; // L8 WS 飞线单趟时长
const BADGE_ZOOM = 1.5; // L7 节点人数徽标仅在缩放 ≥ 该值时并入标签

/* ---- L7 实时数据叠加层（S4）：面板行标签与三态图例（模块常量，帧内零分配）---- */
const OVERLAY_ROWS = ['今日参与', '今日点亮', '全员步数'];
const OVERLAY_W = 126; // 左上面板宽
const OVERLAY_H = 58; // 左上面板高（3 行 × 16 + 边距）
const RING_R = 18; // 右上进度仪表环半径
const LEGEND = [
  { text: '已点亮', color: '#F0C65A' },
  { text: '当前', color: '#FF3D57' },
  { text: '未解锁', color: 'rgba(' + CYAN + ',0.45)' }
];
const LEGEND_STEP = 54; // 图例项水平间距

/**
 * 大数缩写（L7 面板与人数徽标共用）：≥1 亿 / ≥1 万 保留一位小数，其余千分位。
 * 只在 setStats 时调用，不在绘制帧内拼接字符串。
 */
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const INTRO_MS = 1400; // 首次渲染入场描画时长
const PROGRESS_MS = 800; // 步数刷新增量推进时长
const ARRIVE_FX_MS = 2400; // 点亮动画时长（§13.3）
const PARTICLE_CAP = 64; // 点亮粒子总量上限（§13.4 性能约束）

// 帧率自适应降级（S5）：滚动窗口帧间隔均值超预算即降级，且不自动恢复
const PERF_WINDOW = 30; // 采样窗口帧数
const PERF_BUDGET_MS = 33; // 帧间隔预算（>33ms 即 <30fps）
const PERF_GAP_MS = 1000; // 超过此间隔视为暂停/切后台的时间跳变，丢弃该样本

/**
 * 创建渲染内核实例。
 * @param {Object} opts
 * @param {Object} opts.ctx  已按 dpr scale 过的 2d 上下文
 * @param {number} opts.cw   画布 CSS 宽
 * @param {number} opts.ch   画布 CSS 高
 * @param {number} opts.dpr  像素比（离屏层按此放大烘焙）
 */
function createHudMap(opts) {
  return {
    ctx: opts.ctx,
    cw: opts.cw,
    ch: opts.ch,
    dpr: opts.dpr || 2,

    // 观景变换（§13.4）：scale 1~2.5，ox/oy ≤ 0
    view: { scale: 1, ox: 0, oy: 0 },

    // 路线数据与几何
    route: null,
    nodeIndex: null,
    nodePts: null,
    path: null,
    pathDist: null,
    pathLen: 0,
    nodePathIdx: null, // 各节点在采样路径上的下标（L8 飞线终点定位）

    // 构建期一次性分配的绘制元素（帧内零分配）
    farStars: null,
    stars: null,
    trailDust: null,
    regionMotes: null,

    // 离屏缓存与精灵
    staticLayer: null,
    glowGold: null,
    glowRed: null,
    glowCyan: null,

    // 动画时钟
    animStart: 0,
    progressAnim: null,
    arriveFx: null,

    // L7 实时数据叠加层（页面 setStats 注入；null = 未加载/加载失败，数字显示 --）
    stats: null,
    // L8 WS 飞线（页面 playFlyLine 注入）：{ idx, start }
    flyLine: null,

    // 渐变缓存（画布/静态层重建时重置）
    _goldGrad: null,
    _goldGradIdx: -1,
    _flagGrad: null,
    _sweepGrad: null,
    _scanGrad: null,
    _labelW: null,
    _hintW: 0,
    // L7 仪表环百分比文案：整数变化时才重建字符串
    _ringPct: -1,
    _ringText: '',

    // 帧率自适应降级（S5）：lowPerf 一旦置真不再复位（实例级，dispose 后新实例重新测量）
    lowPerf: false,
    _perfBuf: new Array(PERF_WINDOW).fill(0), // 帧间隔环形缓冲（创建期一次性分配）
    _perfI: 0, // 下一个写入槽位
    _perfN: 0, // 已填充样本数（未满窗时不参与判定）
    _perfSum: 0, // 窗口内间隔累加（增量维护，避免每帧重新求和）
    _perfLast: 0, // 上一帧时间戳（秒），0 表示尚无样本
    _perfAvg: 0, // 最近一次满窗均值（ms），供测试与诊断读取

    /* ---------------- 数据与几何 ---------------- */

    /**
     * 设置路线数据（网络刷新与本地缓存共用同一入口）。
     * 轨迹推进规则（需求 §3.5）：仅首次渲染播放入场/镜头动画；
     * 步数刷新只从旧进度动画推进到新进度，不重播完整地图动画。
     */
    setRoute(route) {
      if (!route) return;
      const prev = this.route;
      const prevProgress =
        prev && typeof prev.routeProgress === 'number' ? prev.routeProgress : null;
      this.route = route;
      // 节点 id → 路线下标（点亮特效/粒子按 id 定位节点坐标）
      this.nodeIndex = {};
      route.nodes.forEach((n, i) => {
        this.nodeIndex[n.id] = i;
      });

      if (prevProgress === null || !this.path) {
        // 首次渲染：重建几何与静态层并播放完整入场描画
        this.buildGeometry();
        this.buildStatic();
        this.buildGlowSprites();
        this.animStart = Date.now();
      } else {
        // 步数刷新：仅播放新增部分的轨迹推进
        this.progressAnim = {
          from: prevProgress,
          to: this.calcRouteProgress(route),
          start: Date.now()
        };
      }
    },

    /** 全程行军进度（0~1）：优先取后端 routeProgress，旧接口降级为步数比例 */
    calcRouteProgress(route) {
      if (typeof route.routeProgress === 'number') return Math.min(1, Math.max(0, route.routeProgress));
      return route.totalSteps > 0 ? Math.min(1, route.currentSteps / route.totalSteps) : 0;
    },

    /** 当前生效的绘制进度：增量推进动画期间按 easeOutCubic 插值 */
    currentRatio() {
      const base = this.calcRouteProgress(this.route);
      const anim = this.progressAnim;
      if (!anim) return base;
      const p = Math.min(1, (Date.now() - anim.start) / PROGRESS_MS);
      if (p >= 1) {
        this.progressAnim = null;
        return base;
      }
      return anim.from + (base - anim.from) * routeCanvas.easeOutCubic(p);
    },

    /** 距离 -> 路径采样下标（二分） */
    dist2Index(len) {
      return routeCanvas.distToIndex(this.pathDist, len);
    },

    /**
     * 构建绘制静态资源：节点坐标、路径采样、星尘、星空三层、区域氛围粒子
     */
    buildGeometry() {
      const { cw, ch } = this;
      const nodes = (this.route && this.route.nodes) || [];
      this.nodePts = routeCanvas.getCanvasNodePositions(nodes, cw, ch);

      // Catmull-Rom 平滑路径采样
      const segs = 30;
      const sampled = routeCanvas.sampleRoutePath(this.nodePts, segs);
      this.path = sampled.path;
      this.pathDist = sampled.dist;
      this.pathLen = sampled.len;
      this.nodePathIdx = sampled.nodePathIndex;

      // 星河轨迹沿线星尘（§13.2「路线=星河轨迹」）：固定 22 颗采样点，
      // 仅已完成段内闪烁（相位各异，数量固定不随帧分配）
      this.trailDust = [];
      for (let i = 0; i < 22 && this.path.length > 1; i++) {
        this.trailDust.push({
          idx: Math.floor((i + 0.5) / 22 * (this.path.length - 1)),
          r: 0.7 + Math.random() * 0.9,
          phase: Math.random() * Math.PI * 2,
          freq: 1.2 + Math.random() * 2
        });
      }

      // 星空分远/中/近三层（构建期一次性分配，帧内零分配）：
      // 远景微星静态烘焙进离屏层；中景小星错峰呼吸闪烁；近景亮星带十字光芒并轻微缩放
      this.farStars = [];
      for (let i = 0; i < 110; i++) {
        const p = this.sampleSkyPoint(0.5);
        this.farStars.push({ x: p.x, y: p.y, r: 0.35 + Math.random() * 0.45, bright: Math.random() < 0.4 });
      }
      this.stars = [];
      for (let i = 0; i < 64; i++) {
        const big = i < 9;
        const p = this.sampleSkyPoint(0.35);
        const lo = big ? 0.3 + Math.random() * 0.15 : 0.08 + Math.random() * 0.22;
        this.stars.push({
          x: p.x,
          y: p.y,
          r: big ? 1.3 + Math.random() * 1.0 : 0.5 + Math.random() * 0.8,
          lo,
          span: (big ? 0.95 : 0.55 + Math.random() * 0.4) - lo,
          // 周期约 4.5~18s；slow=true 长时间微暗、缓慢增亮再渐暗（呼吸式）
          freq: 0.35 + Math.random() * 1.05,
          phase: Math.random() * Math.PI * 2,
          slow: Math.random() < 0.45,
          color: STAR_TINTS[Math.floor(Math.random() * STAR_TINTS.length)],
          glint: big
        });
      }
      // 按颜色排序：绘制时 fillStyle 只切换几次
      this.stars.sort((a, b) => (a.color < b.color ? -1 : a.color > b.color ? 1 : 0));

      // 区域氛围（需求 §12）：每个节点按区域主题生成少量环境粒子
      // （每节点 3 颗、总量 30 封顶、构建期一次性分配，帧内零分配）
      this.regionMotes = [];
      nodes.forEach((node, i) => {
        const p = this.nodePts[i];
        if (!p) return;
        const cfg = nodeThemes.getNodeTheme(node.id).particleConfig;
        for (let k = 0; k < 3; k++) {
          this.regionMotes.push({
            type: cfg.type,
            color: cfg.color,
            bx: p.x,
            by: p.y,
            ox: (Math.random() - 0.5) * 46,
            oy: (Math.random() - 0.5) * 30,
            r: 0.8 + Math.random() * 1.2,
            phase: Math.random() * Math.PI * 2,
            freq: 0.5 + Math.random() * 1.2
          });
        }
      });

      // 节点名标签宽度缓存（避免每帧 measureText）
      this._labelW = {};
    },

    /**
     * 星点采样：bandRatio 概率落在左上→右中的斜向银河带（近似高斯散布），其余均匀散布于天空区，
     * 避免网格感；避让节点 16px 范围（最多重试 6 次），保证节点不被星点干扰。
     * @param {number} bandRatio 落入银河带的概率
     * @returns {{x:number, y:number}}
     */
    sampleSkyPoint(bandRatio) {
      const { cw, ch } = this;
      const skyH = ch * 0.72;
      const pts = this.nodePts || [];
      let x = 0;
      let y = 0;
      for (let k = 0; k < 6; k++) {
        if (Math.random() < bandRatio) {
          const u = Math.random();
          const g = (Math.random() + Math.random() + Math.random() - 1.5) * 0.12 * ch;
          x = Math.min(cw, Math.max(0, u * cw - g * 0.4));
          y = Math.min(skyH, Math.max(0, (0.06 + 0.42 * u) * ch + g));
        } else {
          x = Math.random() * cw;
          y = Math.random() * skyH;
        }
        if (!pts.some((p) => Math.abs(p.x - x) < 16 && Math.abs(p.y - y) < 16)) break;
      }
      return { x, y };
    },

    /* ---------------- 离屏缓存 ---------------- */

    /**
     * 构建静态背景离屏层（L0 深空底与暗角 + L1 刻度网格 + L2 等高线山峦
     * + L3 切角边框与雷达坐标环 + 远景微星 + 虚线路线底）。
     * 这些元素不随帧变化，缓存后每帧直接 drawImage；离屏画布不可用时降级为每帧直绘。
     */
    buildStatic() {
      // 画布重建（如切换模式）时路径与上下文可能变化，重置全部渐变缓存
      this._goldGrad = null;
      this._goldGradIdx = -1;
      this._flagGrad = null;
      this._sweepGrad = null;
      this._scanGrad = null;
      this._hintW = 0;
      try {
        const dpr = this.dpr;
        const off = wx.createOffscreenCanvas({ type: '2d', width: this.cw * dpr, height: this.ch * dpr });
        const octx = off.getContext('2d');
        octx.scale(dpr, dpr);
        this.paintScenery(octx);
        this.staticLayer = off;
      } catch (e) {
        // 低版本基础库不支持离屏画布时降级
        this.staticLayer = null;
      }
    },

    /**
     * 构建光晕精灵（金/红/青）：将径向光晕预渲染到离屏小画布，
     * 绘制节点/粒子/旗座/雾带时直接 drawImage 缩放复用，避免每帧创建径向渐变，兼顾观感与性能。
     */
    buildGlowSprites() {
      const stops = (rgb) => [
        [0, 'rgba(' + rgb + ',0.85)'],
        [0.4, 'rgba(' + rgb + ',0.32)'],
        [1, 'rgba(' + rgb + ',0)']
      ];
      this.glowGold = routeCanvas.createGlowSprite(stops('255,205,90'));
      this.glowRed = routeCanvas.createGlowSprite(stops('255,80,105'));
      // 青蓝雾带/仪器辉光（drawClouds 用它替代每帧 createRadialGradient；null 时降级回渐变）
      this.glowCyan = routeCanvas.createGlowSprite([
        [0, 'rgba(' + CYAN + ',0.16)'],
        [0.55, 'rgba(' + CYAN + ',0.07)'],
        [1, 'rgba(' + CYAN + ',0)']
      ]);
    },

    /** 释放离屏层、精灵与构建期数组（切回实景模式时调用） */
    dispose() {
      this.ctx = null;
      this.staticLayer = null;
      this.glowGold = null;
      this.glowRed = null;
      this.glowCyan = null;
      this.arriveFx = null;
      this.progressAnim = null;
      this.route = null;
      this.nodeIndex = null;
      this.nodePts = null;
      this.path = null;
      this.pathDist = null;
      this.nodePathIdx = null;
      this.stats = null;
      this.flyLine = null;
      this.farStars = null;
      this.stars = null;
      this.trailDust = null;
      this.regionMotes = null;
      this._goldGrad = null;
      this._flagGrad = null;
      this._sweepGrad = null;
      this._scanGrad = null;
      this._labelW = null;
      this._hintW = 0;
      this._ringPct = -1;
      this._ringText = '';
      this.lowPerf = false;
      this._perfBuf = null;
      this._perfI = 0;
      this._perfN = 0;
      this._perfSum = 0;
      this._perfLast = 0;
      this._perfAvg = 0;
    },

    /* ---------------- 单帧绘制 ---------------- */

    /**
     * 帧率采样与降级判定（S5）：滚动 PERF_WINDOW 帧的间隔均值 > PERF_BUDGET_MS 即置 lowPerf。
     * 增量维护和值（覆盖槽位时先减旧值），每帧 O(1)、零分配。
     * 降级后直接 return 不再采样——不自动恢复，避免在阈值附近反复开关造成视觉抖动。
     * 首帧无间隔可测；> PERF_GAP_MS 的间隔是暂停/切后台造成的时间跳变，丢弃不入库。
     * @param {number} t 页面 rAF 传入的时间戳（秒）
     */
    samplePerf(t) {
      if (this.lowPerf) return;
      const last = this._perfLast;
      this._perfLast = t;
      if (!last) return;
      const dt = (t - last) * 1000;
      if (dt <= 0 || dt > PERF_GAP_MS) return;
      const i = this._perfI;
      if (this._perfN < PERF_WINDOW) {
        this._perfBuf[i] = dt;
        this._perfSum += dt;
        this._perfN++;
      } else {
        this._perfSum += dt - this._perfBuf[i];
        this._perfBuf[i] = dt;
      }
      this._perfI = (i + 1) % PERF_WINDOW;
      if (this._perfN < PERF_WINDOW) return;
      this._perfAvg = this._perfSum / PERF_WINDOW;
      if (this._perfAvg > PERF_BUDGET_MS) this.lowPerf = true;
    },

    draw(t) {
      const ctx = this.ctx;
      if (!ctx || !this.route) return;
      this.samplePerf(t);
      const { cw, ch } = this;

      // 星空全景观景变换（§13.4）：拖动/缩放作用于整个场景，命中测试做逆变换
      const v = this.view;
      ctx.save();
      ctx.translate(v.ox, v.oy);
      ctx.scale(v.scale, v.scale);

      // 静态 scenery（L0~L3）已缓存到离屏层：每帧仅贴图，
      // 避免重复创建渐变与重建路径，大幅降低主线程开销，保证点击交互不卡顿。
      if (this.staticLayer) {
        ctx.drawImage(this.staticLayer, 0, 0, cw, ch);
      } else {
        ctx.clearRect(-v.ox / v.scale, -v.oy / v.scale, cw / v.scale, ch / v.scale);
        this.paintScenery(ctx);
      }
      this.drawRadar(t);
      // 降级首刀（S5）：L4 水平扫描带是全宽渐变填充，纯氛围、无信息量
      if (!this.lowPerf) this.drawScanBand(t);
      this.drawClouds(t);
      this.drawStars(t);
      this.drawRegionMotes(t);
      this.drawRoute(t);
      this.drawNodes(t);
      this.drawArriveFx();
      this.drawProgressFlag(t);
      this.drawFlyLine();

      ctx.restore();
      // 操作提示与 L7 实时叠加层画在观景变换之外：视口固定，不随拖动/缩放移动
      this.drawHudHint();
      this.drawOverlay();
    },

    /**
     * 静态 scenery（离屏烘焙一次，L0~L3）：深空底色 + 中心辉光 + 四角暗角 → 雷达坐标环
     *   → 远景微星 → 等高线山峦 → 带刻度网格 → 虚线路线底 → 切角 HUD 边框。
     * 顺序即叠放次序：坐标环属远景（山峦之下），网格与边框属前景仪器（山峦之上）。
     */
    paintScenery(ctx) {
      const { cw, ch } = this;

      // L0-1 深空底色（四段线性渐变）
      const sky = ctx.createLinearGradient(0, 0, 0, ch);
      sky.addColorStop(0, DEEP_SKY[0]);
      sky.addColorStop(0.45, DEEP_SKY[1]);
      sky.addColorStop(0.75, DEEP_SKY[2]);
      sky.addColorStop(1, DEEP_SKY[3]);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, cw, ch);

      // L0-2 中心青蓝辉光（营造纵深）
      const halo = ctx.createRadialGradient(cw * 0.5, ch * 0.36, 8, cw * 0.5, ch * 0.36, Math.max(cw, ch) * 0.7);
      halo.addColorStop(0, 'rgba(' + CYAN + ',0.10)');
      halo.addColorStop(1, 'rgba(' + CYAN + ',0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, cw, ch);

      // L0-3 四角暗角（把视线压回中心路线）
      const vig = ctx.createRadialGradient(
        cw * 0.5, ch * 0.5, Math.min(cw, ch) * 0.28,
        cw * 0.5, ch * 0.5, Math.max(cw, ch) * 0.78
      );
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, cw, ch);

      // L3-1 雷达坐标环（静态部分）
      this.drawRadarRing(ctx);

      // 远景微星（静态，位于山峦之后；按两档亮度各合批一次 fill）
      const far = this.farStars || [];
      [[false, 'rgba(210,225,245,0.22)'], [true, 'rgba(230,238,252,0.5)']].forEach(([bright, color]) => {
        ctx.beginPath();
        far.forEach((s) => {
          if (s.bright !== bright) return;
          ctx.moveTo(s.x + s.r, s.y);
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        });
        ctx.fillStyle = color;
        ctx.fill();
      });

      // L2 青蓝等高线山峦
      this.drawRidges(ctx);

      // L1 带刻度经纬网格（盖在山峦之上，读数感）
      this.drawGrid(ctx);

      // 虚线路线底（未完成部分的引导线，仪器青）
      const path = this.path;
      if (path && path.length) {
        ctx.save();
        ctx.setLineDash([7, 7]);
        ctx.strokeStyle = 'rgba(' + CYAN + ',0.22)';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        routeCanvas.tracePath(ctx, path, path.length - 1);
        ctx.stroke();
        ctx.restore();
      }

      // L3-2 切角 HUD 边框（最上层，压住全部 scenery）
      this.drawFrame(ctx);
    },

    /** L3 雷达坐标环（静态）：同心圆 + 虚线十字准线 + 每 30° 刻度（四向加长加亮）+ N/E/S/W */
    drawRadarRing(ctx) {
      const { cw, ch } = this;
      const R = Math.min(cw, ch) * RADAR_R;
      ctx.save();
      ctx.translate(cw * 0.5, ch * 0.5);
      ctx.lineWidth = 1;
      [1, 0.75, 0.5, 0.25].forEach((k, i) => {
        ctx.beginPath();
        ctx.arc(0, 0, R * k, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(' + CYAN + ',' + (i === 0 ? 0.16 : 0.08) + ')';
        ctx.stroke();
      });
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = 'rgba(' + CYAN + ',0.10)';
      ctx.beginPath();
      ctx.moveTo(-R, 0); ctx.lineTo(R, 0);
      ctx.moveTo(0, -R); ctx.lineTo(0, R);
      ctx.stroke();
      ctx.setLineDash([]);
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        const cardinal = i % 3 === 0;
        const inner = R * (cardinal ? 0.9 : 0.955);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
        ctx.strokeStyle = 'rgba(' + CYAN + ',' + (cardinal ? 0.4 : 0.2) + ')';
        ctx.lineWidth = cardinal ? 1.5 : 1;
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(' + CYAN + ',0.38)';
      ctx.font = '8px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lo = R + 9;
      ctx.fillText('N', 0, -lo);
      ctx.fillText('S', 0, lo);
      ctx.fillText('E', lo, 0);
      ctx.fillText('W', -lo, 0);
      ctx.restore();
    },

    /** L1 带刻度经纬网格（静态）：42px 细线 + 每 4 格一条亮主线 + 主线端部的标尺齿 */
    drawGrid(ctx) {
      const { cw, ch } = this;
      ctx.save();
      ctx.lineWidth = 1;
      const lines = (horizontal) => {
        const span = horizontal ? ch : cw;
        for (let p = GRID, i = 1; p < span; p += GRID, i++) {
          ctx.strokeStyle = 'rgba(' + CYAN + ',' + (i % 4 === 0 ? 0.10 : 0.045) + ')';
          ctx.beginPath();
          if (horizontal) { ctx.moveTo(0, p); ctx.lineTo(cw, p); }
          else { ctx.moveTo(p, 0); ctx.lineTo(p, ch); }
          ctx.stroke();
        }
      };
      lines(false);
      lines(true);
      // 标尺齿：主线与边框交汇处向内画 6px 短线
      ctx.strokeStyle = 'rgba(' + CYAN + ',0.32)';
      for (let x = GRID * 4; x < cw; x += GRID * 4) {
        ctx.beginPath();
        ctx.moveTo(x, 12); ctx.lineTo(x, 18);
        ctx.moveTo(x, ch - 12); ctx.lineTo(x, ch - 18);
        ctx.stroke();
      }
      for (let y = GRID * 4; y < ch; y += GRID * 4) {
        ctx.beginPath();
        ctx.moveTo(12, y); ctx.lineTo(18, y);
        ctx.moveTo(cw - 12, y); ctx.lineTo(cw - 18, y);
        ctx.stroke();
      }
      ctx.restore();
    },

    /**
     * L2 山峦：三层由远及近的青蓝**等高线**（wireframe，不填充）。
     * 每层 n 条轮廓共用同一山脊函数，按 n 递减振幅并逐条下移——越靠下越平，读出「海拔递减」的
     * 等高线质感；最上一条再补一道亮线作为地形主特征。静态烘焙，成本可忽略。
     */
    drawRidges(ctx) {
      const { cw, ch } = this;
      const layers = [
        { base: 0.56, amp: 0.05, k1: 2.0, k2: 5.3, a: 0.34, lines: 4, gap: 9 },
        { base: 0.71, amp: 0.07, k1: 2.8, k2: 6.6, a: 0.46, lines: 5, gap: 10 },
        { base: 0.88, amp: 0.09, k1: 3.5, k2: 8.1, a: 0.6, lines: 6, gap: 11 }
      ];
      ctx.save();
      layers.forEach((L) => {
        const baseY = L.base * ch;
        const contourY = (n, x) => {
          const nx = x / cw;
          const wave = L.amp * ch *
            (Math.sin(nx * Math.PI * L.k1 + L.k2) * 0.6 + Math.sin(nx * Math.PI * L.k2 * 1.7) * 0.4);
          return baseY - wave * (1 - n * 0.15) + n * L.gap;
        };
        const trace = (n) => {
          ctx.beginPath();
          ctx.moveTo(0, contourY(n, 0));
          for (let x = 8; x <= cw; x += 8) ctx.lineTo(x, contourY(n, x));
          ctx.stroke();
        };
        ctx.lineWidth = 1;
        for (let n = 0; n < L.lines; n++) {
          ctx.strokeStyle = 'rgba(' + CYAN + ',' + (L.a * (1 - n / (L.lines + 1))).toFixed(3) + ')';
          trace(n);
        }
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = 'rgba(' + CYAN + ',' + (L.a + 0.18).toFixed(3) + ')';
        trace(0);
      });
      ctx.restore();
    },

    /** L3 切角 HUD 边框（静态）：双层切角面板 + 四角「卡扣」角标 */
    drawFrame(ctx) {
      const { cw, ch } = this;
      const m = 12;
      const cut = 22;
      ctx.save();
      ctx.strokeStyle = 'rgba(' + CYAN + ',0.32)';
      ctx.lineWidth = 1.5;
      routeCanvas.drawHudPanel(ctx, m, m, cw - m * 2, ch - m * 2, cut);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(' + CYAN + ',0.12)';
      ctx.lineWidth = 1;
      routeCanvas.drawHudPanel(ctx, m + 6, m + 6, cw - (m + 6) * 2, ch - (m + 6) * 2, cut - 8);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(' + CYAN + ',0.8)';
      ctx.lineWidth = 2.5;
      const arm = 18;
      [[m, m, 1, 1], [cw - m, m, -1, 1], [m, ch - m, 1, -1], [cw - m, ch - m, -1, -1]].forEach((q) => {
        const x = q[0];
        const y = q[1];
        const sx = q[2];
        const sy = q[3];
        ctx.beginPath();
        ctx.moveTo(x + sx * cut, y);
        ctx.lineTo(x + sx * (cut + arm), y);
        ctx.moveTo(x + sx * cut, y);
        ctx.lineTo(x, y + sy * cut);
        ctx.moveTo(x, y + sy * cut);
        ctx.lineTo(x, y + sy * (cut + arm));
        ctx.stroke();
      });
      ctx.restore();
    },

    /**
     * L4 旋转雷达扇形（动态）：以画布中心为圆心的青蓝渐变扇区匀速旋转 + 前缘扫描亮线。
     * 渐变以 (0,0) 为心建一次缓存，绘制时 translate + rotate，渐变随坐标系一起转故始终对齐。
     */
    drawRadar(t) {
      const ctx = this.ctx;
      const { cw, ch } = this;
      const R = Math.min(cw, ch) * RADAR_R;
      if (!this._sweepGrad) {
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
        g.addColorStop(0, 'rgba(' + CYAN + ',0.22)');
        g.addColorStop(0.6, 'rgba(' + CYAN + ',0.08)');
        g.addColorStop(1, 'rgba(' + CYAN + ',0)');
        this._sweepGrad = g;
      }
      ctx.save();
      ctx.translate(cw * 0.5, ch * 0.5);
      ctx.rotate(((t % SWEEP_S) / SWEEP_S) * Math.PI * 2);
      routeCanvas.drawScanSector(ctx, R, SWEEP_ARC);
      ctx.fillStyle = this._sweepGrad;
      ctx.fill();
      // 前缘亮线（扫描面的「刀口」）
      const ea = SWEEP_ARC / 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(ea) * R, Math.sin(ea) * R);
      ctx.strokeStyle = 'rgba(' + CYAN + ',0.32)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    },

    /**
     * L4 水平扫描带（动态）：一条自上而下循环的青蓝渐变光带 + 前沿亮线。
     * 渐变按带高建一次缓存，逐帧只 translate，避免每帧 createLinearGradient。
     */
    drawScanBand(t) {
      const ctx = this.ctx;
      const { cw, ch } = this;
      const bandH = Math.round(ch * 0.16);
      if (!this._scanGrad) {
        const g = ctx.createLinearGradient(0, 0, 0, bandH);
        g.addColorStop(0, 'rgba(' + CYAN + ',0)');
        g.addColorStop(0.55, 'rgba(' + CYAN + ',0.06)');
        g.addColorStop(0.94, 'rgba(' + CYAN + ',0.16)');
        g.addColorStop(1, 'rgba(' + CYAN + ',0)');
        this._scanGrad = g;
      }
      const y = ((t % SCAN_S) / SCAN_S) * (ch + bandH) - bandH;
      ctx.save();
      ctx.translate(0, y);
      ctx.fillStyle = this._scanGrad;
      ctx.fillRect(0, 0, cw, bandH);
      ctx.fillStyle = 'rgba(' + CYAN + ',0.28)';
      ctx.fillRect(0, bandH - 1, cw, 1);
      ctx.restore();
    },

    /** 飘移薄雾（动态，每帧绘制）：青蓝柔光雾带，营造深空星云氛围；精灵可用时零渐变创建 */
    drawClouds(t) {
      const ctx = this.ctx;
      const { cw, ch } = this;
      CLOUDS.forEach((c) => {
        const cx = ((c.x + t * c.v) % 1.3 - 0.15) * cw;
        const cy = c.y * ch;
        const rx = 50 * c.s;
        const ry = 20 * c.s;
        if (this.glowCyan) {
          ctx.globalAlpha = 0.85;
          ctx.drawImage(this.glowCyan, cx - rx, cy - ry, rx * 2, ry * 2);
          ctx.globalAlpha = 1;
          return;
        }
        // 精灵不可用（低版本基础库）时降级为每帧径向渐变
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
        g.addColorStop(0, 'rgba(' + CYAN + ',0.13)');
        g.addColorStop(0.6, 'rgba(' + CYAN + ',0.06)');
        g.addColorStop(1, 'rgba(' + CYAN + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      });
    },

    /**
     * 闪烁星空（中/近景）：每颗星独立周期/相位/亮度区间错峰闪烁，slow 星用三次方曲线
     * 实现「长时间微暗 → 缓慢增亮 → 渐暗」的呼吸感；近景亮星随亮度轻微缩放并带十字光芒。
     */
    drawStars(t) {
      const ctx = this.ctx;
      let color = '';
      for (const s of this.stars) {
        const w = 0.5 + 0.5 * Math.sin(t * s.freq + s.phase);
        const k = s.slow ? w * w * w : w;
        const tw = s.lo + s.span * k;
        if (s.color !== color) {
          color = s.color;
          ctx.fillStyle = color;
        }
        ctx.globalAlpha = tw;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.glint ? s.r * (0.9 + 0.2 * k) : s.r, 0, Math.PI * 2);
        ctx.fill();
        if (s.glint) {
          ctx.globalAlpha = tw * 0.45;
          ctx.strokeStyle = '#CFE4FF';
          ctx.lineWidth = 0.8;
          const g = s.r * (2.4 + 1.6 * k);
          ctx.beginPath();
          ctx.moveTo(s.x - g, s.y); ctx.lineTo(s.x + g, s.y);
          ctx.moveTo(s.x, s.y - g); ctx.lineTo(s.x, s.y + g);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    },

    /**
     * 区域氛围粒子（需求 §12）：每个节点按区域主题（雪花/水雾/暖尘/星光）
     * 在周边小范围循环运动，低透明度不抢主体；构建期固定 30 颗，帧内零分配。
     */
    drawRegionMotes(t) {
      const motes = this.regionMotes;
      if (!motes || !motes.length) return;
      const ctx = this.ctx;
      for (const m of motes) {
        if (m.type === 'snow') {
          // 雪花：循环下落 + 横向飘摆
          const fall = (t * 7 + m.phase * 12) % 26;
          ctx.globalAlpha = 0.3 + 0.2 * Math.sin(t * m.freq + m.phase);
          ctx.fillStyle = m.color;
          ctx.beginPath();
          ctx.arc(m.bx + m.ox + Math.sin(t * 1.1 + m.phase) * 4, m.by + m.oy - 13 + fall, m.r, 0, Math.PI * 2);
          ctx.fill();
        } else if (m.type === 'ember') {
          // 暖尘：循环上升 + 渐隐
          const rise = (t * 6 + m.phase * 12) % 24;
          ctx.globalAlpha = (1 - rise / 24) * 0.5;
          ctx.fillStyle = m.color;
          ctx.beginPath();
          ctx.arc(m.bx + m.ox + Math.sin(t * 1.4 + m.phase) * 3, m.by + m.oy + 12 - rise, m.r, 0, Math.PI * 2);
          ctx.fill();
        } else if (m.type === 'mist') {
          // 水雾：横向缓慢漂移的柔光雾团
          ctx.globalAlpha = 0.05 + 0.03 * Math.sin(t * 0.6 + m.phase);
          ctx.fillStyle = m.color;
          ctx.beginPath();
          ctx.ellipse(m.bx + m.ox + Math.sin(t * 0.25 + m.phase) * 10, m.by + m.oy, m.r * 9, m.r * 4, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // 星光：原地闪烁（延安黄昏星空）
          ctx.globalAlpha = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * m.freq + m.phase));
          ctx.fillStyle = m.color;
          ctx.beginPath();
          ctx.arc(m.bx + m.ox, m.by + m.oy, m.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    },

    /**
     * L5 路线能量管道（已完成段）：青蓝外发光管道 → 金色能量内核 → 白热流动虚线，
     * 三次描边（含流光）全部复用 tracePath；入场描画与增量推进共用 endIdx 口径。
     */
    drawRoute(t) {
      const ctx = this.ctx;
      const path = this.path;

      // 已完成段长度（按行军进度比例，含增量推进动画）+ 入场描画进度
      const progressRatio = this.currentRatio();
      const completedLen = this.pathLen * progressRatio;
      const intro = Math.min(1, (Date.now() - this.animStart) / INTRO_MS);
      const shownLen = completedLen * routeCanvas.easeOutCubic(intro);
      const endIdx = this.dist2Index(shownLen);

      if (endIdx > 0) {
        // 金色渐变：仅在 endIdx 变化时重建（入场结束后即固定，避免每帧 createLinearGradient）
        if (!this._goldGrad || this._goldGradIdx !== endIdx) {
          const ep = path[Math.min(endIdx, path.length - 1)];
          const g = ctx.createLinearGradient(path[0].x, path[0].y, ep.x, ep.y);
          g.addColorStop(0, '#FFF0BE');
          g.addColorStop(0.5, '#F0C65A');
          g.addColorStop(1, '#D99A2B');
          this._goldGrad = g;
          this._goldGradIdx = endIdx;
        }
        // L5-1 青蓝管道外发光（仪器色包裹叙事轨迹，一次 shadowBlur 描边）
        ctx.save();
        ctx.shadowColor = 'rgba(' + CYAN + ',0.55)';
        ctx.shadowBlur = 18;
        ctx.strokeStyle = 'rgba(' + CYAN + ',0.16)';
        ctx.lineWidth = 10;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        routeCanvas.tracePath(ctx, path, endIdx);
        ctx.stroke();
        ctx.restore();
        // L5-2 金色能量内核（叙事主色 + 暖光）
        ctx.save();
        ctx.shadowColor = 'rgba(255,196,74,0.8)';
        ctx.shadowBlur = 10;
        ctx.strokeStyle = this._goldGrad;
        ctx.lineWidth = 4.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        routeCanvas.tracePath(ctx, path, endIdx);
        ctx.stroke();
        ctx.restore();
        // L5-3 流动虚线（能量流）：dash 固定，offset 逐帧前移
        ctx.strokeStyle = 'rgba(255,248,220,0.8)';
        ctx.lineWidth = 1.8;
        ctx.lineCap = 'round';
        routeCanvas.drawDashFlow(ctx, path, endIdx, 10, 26, -t * 46);
      }

      // 流光彗尾（沿已完成路线循环，入场完成后启动）
      if (intro >= 1 && endIdx > 10) {
        for (let k = 0; k < 3; k++) {
          const phase = (t * 0.12 + k * 0.34) % 1;
          const idx = this.dist2Index(phase * shownLen);
          const p = path[idx];
          // 彗尾
          for (let m = 1; m <= 5; m++) {
            const ti = Math.max(idx - m * 4, 0);
            ctx.globalAlpha = 0.55 / m;
            ctx.fillStyle = '#FFDE8A';
            ctx.beginPath();
            ctx.arc(path[ti].x, path[ti].y, 3 - m * 0.4, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
          // 光点头（复用金色光晕精灵）
          if (this.glowGold) {
            const s = 24;
            ctx.drawImage(this.glowGold, p.x - s / 2, p.y - s / 2, s, s);
          }
          ctx.fillStyle = '#FFFBEA';
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 星河轨迹星尘（§13.2）：已完成段内固定采样点闪烁
      if (this.trailDust && endIdx > 0) {
        for (const d of this.trailDust) {
          if (d.idx > endIdx) continue;
          const p = path[d.idx];
          ctx.globalAlpha = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * d.freq + d.phase));
          ctx.fillStyle = '#FFF3C8';
          ctx.beginPath();
          ctx.arc(p.x, p.y, d.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    },

    /**
     * L6 节点三态六边环（§13.2 + S3 HUD 化）：已点亮=旋转金环+发光金星呼吸 /
     * 当前=旋转红环+双脉冲扩散环+红星呼吸 / 未解锁=暗青静态环+暗星点。
     * 六边环是仪器造型，但描边**取状态叙事色**（金/红），只有未点亮态用青——遵守配色铁律。
     */
    drawNodes(t) {
      const ctx = this.ctx;
      const route = this.route;
      const nodePts = this.nodePts;

      route.nodes.forEach((node, i) => {
        const p = nodePts[i];
        if (node.status === 'completed') {
          // 已点亮：金色光晕呼吸（复用精灵）+ 双六边环缓慢旋转 + 双层五角星
          const pulse = 0.5 + 0.5 * Math.sin(t * 2 + i);
          const s = 32 + pulse * 13;
          if (this.glowGold) ctx.drawImage(this.glowGold, p.x - s / 2, p.y - s / 2, s, s);
          ctx.globalAlpha = 0.55 + pulse * 0.35;
          routeCanvas.drawHexRing(ctx, p.x, p.y, 13.5, t * 0.22 + i, 0.74);
          ctx.strokeStyle = '#F0C65A';
          ctx.lineWidth = 1.4;
          ctx.stroke();
          ctx.globalAlpha = 1;
          routeCanvas.drawStar(ctx, p.x, p.y, 5, 8.4, 3.5, t * 0.35);
          ctx.fillStyle = '#E8B84B';
          ctx.fill();
          routeCanvas.drawStar(ctx, p.x, p.y, 5, 4.1, 1.8, t * 0.35);
          ctx.fillStyle = '#FFF7DC';
          ctx.fill();
        } else if (node.status === 'current') {
          // 当前：柔和外发光 + 扩散脉冲环 + 反向旋转红六边环 + 红色星形呼吸缩放（§13.2）
          const soft = 0.5 + 0.5 * Math.sin(t * 1.3);
          if (this.glowRed) {
            const s = 64 + soft * 18;
            ctx.globalAlpha = 0.28 + soft * 0.17;
            ctx.drawImage(this.glowRed, p.x - s / 2, p.y - s / 2, s, s);
          }
          const cyc = (t % 1.6) / 1.6;
          for (let k = 0; k < 2; k++) {
            const pr = (cyc + k * 0.5) % 1;
            ctx.globalAlpha = (1 - pr) * 0.6;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 8 + pr * 20, 0, Math.PI * 2);
            ctx.strokeStyle = '#FF6B7E';
            ctx.lineWidth = 1.6;
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          const breathe = 1 + 0.16 * Math.sin(t * 3);
          if (this.glowRed) {
            const s = 36 * breathe;
            ctx.drawImage(this.glowRed, p.x - s / 2, p.y - s / 2, s, s);
          }
          routeCanvas.drawHexRing(ctx, p.x, p.y, 14.5 * breathe, -t * 0.5, 0.72);
          ctx.strokeStyle = '#FF3D57';
          ctx.lineWidth = 1.8;
          ctx.stroke();
          routeCanvas.drawStar(ctx, p.x, p.y, 5, 8.6 * breathe, 3.7 * breathe, 0);
          ctx.fillStyle = '#FF3D57';
          ctx.fill();
          routeCanvas.drawStar(ctx, p.x, p.y, 5, 3.6 * breathe, 1.6 * breathe, 0);
          ctx.fillStyle = '#FFD9DE';
          ctx.fill();
        } else {
          // 未解锁：暗青静态六边环 + 暗色星点（§13.2）
          routeCanvas.drawHexRing(ctx, p.x, p.y, 10.5, 0, 0.7);
          ctx.strokeStyle = 'rgba(' + CYAN + ',0.30)';
          ctx.lineWidth = 1;
          ctx.stroke();
          routeCanvas.drawStar(ctx, p.x, p.y, 5, 5.4, 2.3, 0);
          ctx.fillStyle = 'rgba(120,145,175,0.5)';
          ctx.fill();
        }

        this.drawNodeLabel(ctx, node, p);
      });
    },

    /**
     * 节点名标签：深底圆角面板 + 青蓝发丝描边 + 状态色文字（暗背景下保证可读）。
     * L7 人数徽标（S4）：缩放 ≥ BADGE_ZOOM 时把「全员抵达人数」并入标签尾部，
     * 与名称同一次 fillText，不额外占用文字预算；宽度按含徽标文本单独缓存。
     */
    drawNodeLabel(ctx, node, p) {
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      const labelX = Math.min(Math.max(p.x, 30), this.cw - 30);
      const labelY = p.y + 26;
      const st = this.stats;
      const badge =
        st && this.view.scale >= BADGE_ZOOM && (node.status === 'completed' || node.status === 'current')
          ? st.badges[node.id]
          : '';
      const text = badge ? node.name + ' ' + badge : node.name;
      if (!this._labelW) this._labelW = {};
      const w = this._labelW[text] || (this._labelW[text] = ctx.measureText(text).width);
      // 面板底衬（圆角收到 3px，与 HUD 切角语言一致）
      routeCanvas.drawRoundRect(ctx, labelX - w / 2 - 6, labelY - 10, w + 12, 15, 3);
      ctx.fillStyle = 'rgba(5,11,22,0.72)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(' + CYAN + ',0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // 文字（状态色：金/红/暗蓝灰）
      if (node.status === 'completed') {
        ctx.fillStyle = '#FFE9A8';
      } else if (node.status === 'current') {
        ctx.fillStyle = '#FF9AA8';
      } else {
        ctx.fillStyle = '#93A6BC';
      }
      ctx.fillText(text, labelX, labelY);
    },

    /**
     * 星空模式操作提示（S3）：<canvas> 原生层会盖住 DOM 浮层，故提示文字直接画进画布；
     * 在观景变换之外绘制，视口固定不随拖动/缩放移动。文字宽度只测量一次。
     */
    drawHudHint() {
      const ctx = this.ctx;
      if (!ctx) return;
      const { cw, ch } = this;
      ctx.save();
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      if (!this._hintW) this._hintW = ctx.measureText(HINT_TEXT).width;
      const bw = this._hintW + 24;
      const bh = 21;
      const x = (cw - bw) / 2;
      const y = ch - bh - 12;
      routeCanvas.drawHudPanel(ctx, x, y, bw, bh, 6);
      ctx.fillStyle = 'rgba(5,11,22,0.66)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(' + CYAN + ',0.28)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(' + CYAN + ',0.78)';
      ctx.fillText(HINT_TEXT, cw / 2, y + 14.5);
      ctx.restore();
    },

    /** 当前进度旗帜：呼吸光点 + 轻微粒子（需求 §3.3）+ 基座光晕 + 摆动旗面 */
    drawProgressFlag(t) {
      const ctx = this.ctx;
      const route = this.route;
      if (route.currentSteps <= 0 || !this.path || this.path.length < 2) return;

      const ratio = this.currentRatio();
      const len = this.pathLen * ratio;
      const idx = Math.min(this.dist2Index(len), this.path.length - 2);
      const p = this.path[idx];
      const pNext = this.path[Math.min(idx + 2, this.path.length - 1)];
      const ang = Math.atan2(pNext.y - p.y, pNext.x - p.x);

      // 呼吸光点（基座光晕随呼吸缩放，复用金色精灵）
      const breathe = 0.5 + 0.5 * Math.sin(t * 2.4);
      if (this.glowGold) {
        const s = 26 + breathe * 16;
        ctx.globalAlpha = 0.45 + breathe * 0.4;
        ctx.drawImage(this.glowGold, p.x - s / 2, p.y - s / 2, s, s);
        ctx.globalAlpha = 1;
      }

      // 轻微粒子（3 颗光尘循环上升，低端开销可忽略）
      for (let k = 0; k < 3; k++) {
        const ph = (t * 0.32 + k / 3) % 1;
        ctx.globalAlpha = (1 - ph) * 0.65;
        ctx.fillStyle = '#FFE9A8';
        ctx.beginPath();
        ctx.arc(p.x + Math.sin(t * 1.7 + k * 2.1) * 6, p.y - ph * 22, Math.max(0.6, 1.8 - ph * 1.2), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      const sway = Math.sin(t * 3) * 0.14;
      const poleH = 24;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(sway * 0.4);

      // 旗杆（暗背景下用亮金）
      ctx.strokeStyle = '#E8C76A';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -poleH);
      ctx.stroke();

      // 旗面（朝路线方向飘）
      ctx.translate(0, -poleH);
      ctx.rotate(ang - Math.PI / 2 + sway);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(17, -6);
      ctx.lineTo(17, 6);
      ctx.closePath();
      // 旗面渐变坐标固定（局部系），创建一次复用
      if (!this._flagGrad) {
        const fg = ctx.createLinearGradient(0, -6, 0, 6);
        fg.addColorStop(0, '#FF6B7A');
        fg.addColorStop(1, '#D61B33');
        this._flagGrad = fg;
      }
      ctx.fillStyle = this._flagGrad;
      ctx.fill();
      // 旗上金星
      routeCanvas.drawStar(ctx, 10, 0, 5, 3.4, 1.5, 0);
      ctx.fillStyle = '#FFE08A';
      ctx.fill();
      ctx.restore();
    },

    /* ---------------- 点亮动画（§13.3） ---------------- */

    /**
     * 触发点亮动画：预生成粒子（fx 创建时一次性分配，避免帧内分配），
     * 由每帧 drawArriveFx 按时间轴推进，播完自动清除。
     * @param {Array<number>} ids 本次新点亮的节点 id
     */
    playArrive(ids) {
      if (!ids || !ids.length) return;
      this.arriveFx = {
        ids: ids,
        start: Date.now(),
        particles: this.makeArriveParticles(ids)
      };
    },

    /**
     * 点亮粒子（需求 §13.3「粒子扩散」）：在 fx 创建时一次性生成，
     * 每节点固定数量（离屏精灵不可用的低端设备减半）、总量封顶，避免 rAF 帧内分配。
     */
    makeArriveParticles(ids) {
      if (!this.nodePts || !this.route) return [];
      const per = this.glowGold ? 14 : 6;
      const list = [];
      for (const id of ids) {
        const idx = this.nodeIndex[id];
        if (idx === undefined) continue;
        const p = this.nodePts[idx];
        if (!p) continue;
        for (let k = 0; k < per && list.length < PARTICLE_CAP; k++) {
          const ang = Math.random() * Math.PI * 2;
          const sp = 26 + Math.random() * 42;
          list.push({
            x: p.x, y: p.y,
            vx: Math.cos(ang) * sp,
            vy: Math.sin(ang) * sp - 14,
            r: 1 + Math.random() * 1.6,
            delay: 0.2 + Math.random() * 0.2
          });
        }
      }
      return list;
    },

    /**
     * 点亮动画（需求 §13.3）：亮起 → 扩大 → 粒子扩散 → 稳定发光（约 2.4s）。
     * 星形 bump 先亮后扩、两层扩散金环、预生成粒子抛物扩散渐隐；
     * 动画结束后节点回到「已点亮发光星星」常态呼吸，无跳变。
     */
    drawArriveFx() {
      const fx = this.arriveFx;
      if (!fx || !this.route || !this.nodePts) return;
      const tSec = (Date.now() - fx.start) / 1000;
      const elapsed = tSec / (ARRIVE_FX_MS / 1000);
      if (elapsed >= 1) {
        this.arriveFx = null;
        return;
      }
      const ctx = this.ctx;
      const glow = routeCanvas.easeOutCubic(Math.min(1, elapsed * 1.15));
      // 亮起（前 25% 亮度渐入）→ 扩大（1.2s 内 bump 至 1.9 倍后回落）
      const brighten = Math.min(1, tSec / 0.6);
      const bump = Math.sin(Math.min(1, tSec / 1.2) * Math.PI);

      fx.ids.forEach((id) => {
        const idx = this.nodeIndex[id];
        if (idx === undefined || !this.nodePts[idx]) return;
        const p = this.nodePts[idx];

        // 中心光晕放大渐隐（图标激活）
        if (this.glowGold) {
          const s = 40 + glow * 64;
          ctx.globalAlpha = (1 - elapsed) * 0.9;
          ctx.drawImage(this.glowGold, p.x - s / 2, p.y - s / 2, s, s);
        }
        // 亮起扩大的金色星形（§13.3 暗星→亮起→扩大）
        ctx.globalAlpha = brighten * (0.35 + (1 - elapsed) * 0.65);
        routeCanvas.drawStar(ctx, p.x, p.y, 5, 9.5 * (1 + bump * 0.9), 4 * (1 + bump * 0.9), 0);
        ctx.fillStyle = '#FFE9A8';
        ctx.fill();
        // 两层扩散金环
        for (let k = 0; k < 2; k++) {
          const pr = Math.max(0, Math.min(1, elapsed * 1.3 - k * 0.22));
          if (pr <= 0) continue;
          ctx.globalAlpha = (1 - pr) * 0.75;
          ctx.strokeStyle = '#FFD98A';
          ctx.lineWidth = 2.5 - pr * 1.4;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 10 + pr * 46, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      });

      // 粒子扩散（§13.3）：delay 后抛物扩散、生命 0.9s 渐隐。
      // 降级第二刀（S5）：粒子是每帧 N 次 arc+fill，且降级可能在动画中途才判定出来，
      // 故守卫放在绘制侧（而非 playArrive 生成侧）——两处都要挡的话反而漏掉中途降级。
      if (!this.lowPerf) {
        const parts = fx.particles || [];
        for (const pt of parts) {
          const dt = tSec - pt.delay;
          if (dt <= 0) continue;
          const life = 0.9;
          if (dt >= life) continue;
          const k = dt / life;
          ctx.globalAlpha = (1 - k) * 0.85;
          ctx.fillStyle = '#FFE9A8';
          ctx.beginPath();
          ctx.arc(pt.x + pt.vx * dt, pt.y + pt.vy * dt + 20 * dt * dt, pt.r * (1 - k * 0.5), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    },

    /* ---------------- 实时数据叠加层 L7 / WS 飞线 L8（S4） ----------------
     * L7/L8 属「全员实时数据」层：由页面拉取 /broadcast/today + /march/route-stats 后经
     * setStats 注入、收到 WS activity 后经 playFlyLine 触发；内核不认接口形状，只认下面的
     * 归一化入参。数据元素一律用仪器青蓝，叙事金红只留给路线与节点（配色铁律）。
     */

    /**
     * 注入 L7 实时数据。数值在此一次性格式化为显示串（含节点人数徽标），绘制帧内零分配。
     * @param {Object|null} stats 传 null 表示未加载/加载失败，面板数值显示 --
     * @param {number} stats.todayUsers 今日参与人数
     * @param {number} stats.todayLit   今日全员点亮节点次数
     * @param {number} stats.todaySteps 今日全员步数合计
     * @param {Object<string, {litCount: number}>} stats.litMap 节点 id → 抵达统计
     */
    setStats(stats) {
      if (!stats) {
        this.stats = null;
        return;
      }
      const litMap = stats.litMap || {};
      const badges = {};
      Object.keys(litMap).forEach((id) => {
        badges[id] = fmtNum(litMap[id].litCount);
      });
      this.stats = {
        lines: [fmtNum(stats.todayUsers), fmtNum(stats.todayLit), fmtNum(stats.todaySteps)],
        badges: badges
      };
    },

    /**
     * 播放一条 WS 飞线（L8）：他人点亮/推进事件到达时由页面调用，动画自播自清。
     * @param {number} nodeId 目标节点 id；非本路线节点或几何未就绪时静默忽略
     */
    playFlyLine(nodeId) {
      if (!nodeId || !this.nodeIndex || !this.nodePathIdx) return;
      const idx = this.nodeIndex[nodeId];
      if (idx === undefined) return;
      this.flyLine = { idx: idx, start: Date.now() };
    },

    /**
     * L7 实时数据叠加层（视口固定，画在观景变换之外）：
     * 左上「全员实时数据」切角面板三行 → 右上「我的进度」仪表环 → 左下节点三态图例
     * （与底部操作提示错开一行，避免重叠）。
     */
    drawOverlay() {
      const ctx = this.ctx;
      if (!ctx || !this.route) return;
      const { cw, ch } = this;
      const st = this.stats;
      ctx.save();

      // 左上数据面板：标签（暗青）左对齐 + 数值（亮白青）右对齐，左侧一条青色数据标识
      routeCanvas.drawHudPanel(ctx, 10, 10, OVERLAY_W, OVERLAY_H, 7);
      ctx.fillStyle = 'rgba(5,11,22,0.62)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(' + CYAN + ',0.30)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(' + CYAN + ',0.7)';
      ctx.fillRect(13, 18, 2, OVERLAY_H - 16);
      for (let i = 0; i < OVERLAY_ROWS.length; i++) {
        const y = 27 + i * 16;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(' + CYAN + ',0.62)';
        ctx.fillText(OVERLAY_ROWS[i], 21, y);
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(234,246,255,0.92)';
        ctx.fillText(st ? st.lines[i] : '--', 10 + OVERLAY_W - 10, y);
      }

      // 右上进度仪表环：底环整圆 + 值弧（routeCanvas.drawArcGauge）+ 百分比 + 图注
      const rcx = cw - 32;
      const rcy = 34;
      const ratio = this.currentRatio();
      const pct = Math.round(ratio * 100);
      if (pct !== this._ringPct) {
        this._ringPct = pct;
        this._ringText = pct + '%';
      }
      ctx.lineCap = 'round';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(rcx, rcy, RING_R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(' + CYAN + ',0.20)';
      ctx.stroke();
      routeCanvas.drawArcGauge(ctx, rcx, rcy, RING_R, ratio);
      ctx.strokeStyle = 'rgba(' + CYAN + ',0.9)';
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.font = '10px sans-serif';
      ctx.fillStyle = 'rgba(234,246,255,0.95)';
      ctx.fillText(this._ringText, rcx, rcy + 3.5);
      ctx.font = '8px sans-serif';
      ctx.fillStyle = 'rgba(' + CYAN + ',0.6)';
      ctx.fillText('我的进度', rcx, rcy + RING_R + 12);

      // 左下三态图例：六边环缩样取各状态叙事色，文字统一冷白（不占节点标签预算）
      const ly = ch - 46;
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'left';
      for (let i = 0; i < LEGEND.length; i++) {
        const lx = 12 + i * LEGEND_STEP;
        routeCanvas.drawHexRing(ctx, lx + 5, ly - 3, 5, 0, 0.75);
        ctx.strokeStyle = LEGEND[i].color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = 'rgba(234,246,255,0.7)';
        ctx.fillText(LEGEND[i].text, lx + 13, ly);
      }
      ctx.restore();
    },

    /**
     * L8 WS 飞线：一枚青蓝数据包沿采样路线从「我的当前进度位置」飞向目标节点，
     * 尾迹 8 点渐隐、抵达前 25% 在目标节点扩散一圈信号环，播完自动清除（FLY_MS 一趟）。
     * 起点晚于终点（他人节点在我身后）时反向飞行，插值口径一致。
     */
    drawFlyLine() {
      const fx = this.flyLine;
      if (!fx || !this.path || !this.nodePathIdx || !this.nodePts) return;
      const target = this.nodePts[fx.idx];
      if (!target) return;
      const k = (Date.now() - fx.start) / FLY_MS;
      if (k >= 1) {
        this.flyLine = null;
        return;
      }
      const ctx = this.ctx;
      const path = this.path;
      const last = path.length - 1;
      const to = Math.min(this.nodePathIdx[fx.idx], last);
      const from = Math.min(this.dist2Index(this.pathLen * this.currentRatio()), last);
      const head = Math.round(from + (to - from) * routeCanvas.easeOutCubic(k));
      const dir = to >= from ? 1 : -1;

      // 尾迹（索引回溯，帧内零分配；透明度用 globalAlpha 而非 rgba 拼接）
      ctx.fillStyle = CYAN_HEX;
      for (let m = 1; m <= 8; m++) {
        const ti = Math.min(last, Math.max(0, head - dir * m * 3));
        ctx.globalAlpha = (1 - m / 9) * 0.85;
        ctx.beginPath();
        ctx.arc(path[ti].x, path[ti].y, Math.max(0.8, 3.2 - m * 0.3), 0, Math.PI * 2);
        ctx.fill();
      }

      // 数据包头部：雾带精灵叠两层提亮成青蓝光晕 + 信号环 + 白热核心
      const hp = path[head];
      if (this.glowCyan) {
        const s = 44;
        ctx.globalAlpha = 1;
        ctx.drawImage(this.glowCyan, hp.x - s / 2, hp.y - s / 2, s, s);
        ctx.drawImage(this.glowCyan, hp.x - s / 2, hp.y - s / 2, s, s);
      }
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = CYAN_HEX;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#EAF9FF';
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, 2.8, 0, Math.PI * 2);
      ctx.fill();

      // 抵达信号环（最后 25%）
      if (k > 0.75) {
        const pr = (k - 0.75) / 0.25;
        ctx.globalAlpha = (1 - pr) * 0.8;
        ctx.strokeStyle = CYAN_HEX;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(target.x, target.y, 12 + pr * 26, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    },

    /* ---------------- 观景变换与命中 ---------------- */

    /** 观景变换钳制：缩放 1~2.5 倍，平移不使场景离开画布 */
    clampView() {
      const v = this.view;
      v.scale = Math.min(2.5, Math.max(1, v.scale));
      v.ox = Math.min(0, Math.max(this.cw * (1 - v.scale), v.ox));
      v.oy = Math.min(0, Math.max(this.ch * (1 - v.scale), v.oy));
    },

    resetView() {
      this.view = { scale: 1, ox: 0, oy: 0 };
    },

    /**
     * 节点命中（屏幕坐标逆变换到场景坐标；含未解锁节点，可查看历史）
     * @returns {number|null} 命中节点 id；未命中返回 null。跳转由页面负责。
     */
    hitTest(sx, sy) {
      if (!this.nodePts || !this.route) return null;
      const v = this.view;
      const x = (sx - v.ox) / v.scale;
      const y = (sy - v.oy) / v.scale;
      const radius = 22 / v.scale; // 保持屏幕命中半径恒定
      for (let i = 0; i < this.nodePts.length; i++) {
        const p = this.nodePts[i];
        if (Math.hypot(x - p.x, y - p.y) <= radius) {
          const node = this.route.nodes[i];
          return node ? node.id : null;
        }
      }
      return null;
    }
  };
}

module.exports = { createHudMap };
