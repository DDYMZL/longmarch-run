/**
 * 星空长征 Canvas 渲染内核 · 史诗风重构版（pages/march 星空模式专用）。
 *
 * 职责边界：页面只负责模式切换、数据拉取、手势事件转发与命中后交互；本模块持有
 * 全部绘制状态（几何采样、星野、粒子、离屏静态层、光晕精灵、观景变换、动画时钟）
 * 与全部绘制逻辑。rAF 循环留在页面（生命周期由 onHide/onUnload 掌控），每帧调 draw(t)。
 *
 * 视觉规则（史诗风重构：深空星幕 + 红色征途 + 金色丰碑 + 粒子流光）：
 *   静态层（离屏烘焙一次）——深空蓝黑渐变底 / 星云雾带 / 远景微星 / 中景星 /
 *   章节区段雾带（data/star-themes.js 主题色）/ 暗角；
 *   帧内（观景变换内）——近景星闪烁漂移（亮星带十字光芒）/ 章节环境粒子 /
 *   路线（未解锁暗红基底 + 已完成金红主径 + 当前段沿路径方向的红色流光）/
 *   节点四态（未解锁暗核微环、已点亮金环金核、当前红核脉冲辉光，差异化历史图标）/
 *   行进旗帜 / 节点抵达特效 / WS 飞线（红金数据流光）；
 *   帧内（视口固定，不随拖动缩放）——全员数据胶囊 / 进度仪表环 / 三态图例 / 操作提示，
 *   克制呈现（暖白文字 + 半透明深底，不再使用 HUD 仪器元素与青蓝色）。
 *   配色铁律：叙事色只用红（#D8454F 系）与金（#F0C65A 系），见 data/star-themes.js PALETTE。
 *
 * 性能约束：静态背景离屏烘焙一次；星点/粒子构建期一次性分配，帧内零分配；
 *   光晕与雾带用预渲染精灵 drawImage，不每帧建径向渐变；文字宽度 measureText 缓存；
 *   每帧长折线描边 ≤5 次、drawImage ≤40 次、fillText ≤22 次。
 * 帧率自适应降级：draw(t) 内滚动采样 PERF_WINDOW 帧间隔，均值 > PERF_BUDGET_MS
 *   （即 <30fps）置 lowPerf，关掉近景星漂移与抵达粒子扩散——两者纯氛围、无信息量；
 *   降级不自动恢复，避免阈值附近反复开关造成视觉抖动；暂停/切后台的时间跳变样本丢弃。
 *
 * 观景变换 view 由页面手势层直接改写（pan/pinch 数学属于事件层），改完须调 clampView()；
 * 命中测试 hitTest() 内部做屏幕→场景逆变换。
 */
const routeCanvas = require('./routeCanvas');
const starThemes = require('../data/star-themes');

const P = starThemes.PALETTE;

/* ---- 星野参数（三层：远静态 / 中静态双色呼吸 / 近帧内闪烁漂移）---- */
const FAR_STAR_COUNT = 150; // 远景微星（静态烘焙）
const MID_STAR_COUNT = 90; // 中景星（静态烘焙，alpha 分档）
const NEAR_STAR_COUNT = 34; // 近景星（帧内闪烁 + 漂移）
const BRIGHT_STAR_COUNT = 7; // 近景中的亮星（十字光芒 + 明显缩放呼吸）
const STAR_TINTS = ['#EAF2FF', '#EAF2FF', '#FFF1D6', '#FFE9C8', '#CFE0FF'];

/* ---- 动画参数 ---- */
const INTRO_MS = 1600; // 首次渲染入场描画时长（路线自起点绘出）
const PROGRESS_MS = 800; // 步数刷新增量推进时长
const ARRIVE_FX_MS = 2600; // 节点点亮动画时长
const PARTICLE_CAP = 64; // 点亮粒子总量上限
const FLY_MS = 1400; // WS 飞线单趟时长
const FLOW_SPEED = 26; // 路线流光速度（px/s，沿路径前进方向）

/* ---- 帧率自适应降级 ---- */
const PERF_WINDOW = 30; // 采样窗口帧数
const PERF_BUDGET_MS = 33; // 帧间隔预算（>33ms 即 <30fps）
const PERF_GAP_MS = 1000; // 超过此间隔视为暂停/切后台的时间跳变，丢弃该样本

/* ---- 视口固定 UI ---- */
const HINT_TEXT = '拖动平移 · 双指缩放 · 双击复位 · 点节点看历史';
const LEGEND = [
  { text: '已点亮', color: P.gold },
  { text: '当前', color: P.nodeCurrent },
  { text: '未解锁', color: 'rgba(220,190,180,0.4)' }
];
const LEGEND_STEP = 54; // 图例项水平间距
const RING_R = 18; // 右上进度仪表环半径

/** 大数缩写（全员数据胶囊）：≥1 亿 / ≥1 万 保留一位小数，其余千分位。仅 setStats 时调用 */
function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 创建渲染内核实例。
 * @param {Object} opts
 * @param {Object} opts.ctx  已按 dpr scale 过的 2d 上下文
 * @param {number} opts.cw   画布 CSS 宽
 * @param {number} opts.ch   画布 CSS 高
 * @param {number} opts.dpr  像素比（离屏层按此放大烘焙）
 */
function createStarMap(opts) {
  return {
    ctx: opts.ctx,
    cw: opts.cw,
    ch: opts.ch,
    dpr: opts.dpr || 2,

    // 观景变换：scale 1~2.5，ox/oy ≤ 0（页面手势层改写后须调 clampView）
    view: { scale: 1, ox: 0, oy: 0 },

    // 路线数据与几何
    route: null,
    nodeIndex: null,
    nodePts: null,
    path: null,
    pathDist: null,
    pathLen: 0,
    nodePathIdx: null, // 各节点在采样路径上的下标（飞线终点定位）

    // 星野（构建期一次性分配）
    farStars: null,
    midStars: null,
    nearStars: null,
    nebulas: null, // 星云雾带摆放（静态烘焙）

    // 区段氛围（按章节）
    chapterZones: null, // [{theme, cx, cy, r}] 静态烘焙雾带 + 帧内粒子锚点
    envMotes: null, // 章节环境粒子（雪粒/暖尘/金尘/水雾）

    // 离屏静态层与光晕精灵
    staticLayer: null,
    glowGold: null,
    glowRed: null,
    glowSoft: null, // 暖白软雾（星云/区段雾带）

    // 动画状态
    introStart: 0, // 入场描画起点（ms，0=未开始）
    progressAnim: null, // {from, to, start} 增量推进
    arriveFx: null, // [{nodeId, start, particles}] 点亮动画
    flyLine: null, // {nodeId, start} WS 飞线

    // L7 实时数据注入（setStats 一次性格式化，帧内不拼字符串）
    stats: null,
    statsText: null, // {users, lit, steps}

    // 缓存
    _labelW: null, // 节点名文字宽度缓存
    _hintW: 0,
    _ringPct: -1,
    _ringText: '',

    // 帧率采样（降级判定）
    lowPerf: false,
    _perfBuf: null,
    _perfI: 0,
    _perfN: 0,
    _perfSum: 0,
    _perfLast: 0,
    _perfAvg: 0,

    /* ---------------- 数据注入 ---------------- */

    /**
     * 注入路线数据。首次注入播放入场描画；后续注入仅从旧进度增量推进到新进度，
     * 不重播完整地图动画（步数刷新不重置画面）。
     */
    setRoute(route) {
      const prev = this.route;
      const prevProgress = prev ? this.calcRouteProgress(prev) : 0;
      this.route = route;
      this.nodeIndex = {};
      (route.nodes || []).forEach((n, i) => {
        this.nodeIndex[n.id] = i;
      });
      this.buildGeometry();
      // 精灵须先于静态层构建（paintSky 的星云/区段雾带依赖 glowSoft 与 _zoneSprites）；
      // 区段雾带依赖节点坐标，路线每次刷新都重烘静态层
      if (!this.glowSoft) this.buildGlowSprites();
      this.buildStatic();
      const next = this.calcRouteProgress(route);
      if (!prev) {
        this.introStart = Date.now();
        this.progressAnim = null;
      } else if (Math.abs(next - prevProgress) > 1e-4) {
        this.progressAnim = { from: prevProgress, to: next, start: Date.now() };
      }
    },

    /** 全程行军进度（0~1）：优先取后端 routeProgress，旧接口降级为步数比例 */
    calcRouteProgress(route) {
      if (!route) return 0;
      if (typeof route.routeProgress === 'number') return Math.min(1, Math.max(0, route.routeProgress));
      if (!route.totalSteps) return 0;
      return Math.min(1, Math.max(0, route.currentSteps / route.totalSteps));
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
      return anim.from + (anim.to - anim.from) * routeCanvas.easeOutCubic(p);
    },

    /**
     * L7 全员统计注入：数值在此一次性格式化（帧内不拼字符串）。
     * 任一接口失败时页面层保持 last-good，不会调进空值。
     */
    setStats(stats) {
      this.stats = stats || null;
      if (!stats) {
        this.statsText = null;
        return;
      }
      this.statsText = {
        users: stats.todayUsers == null ? '--' : fmtNum(stats.todayUsers),
        lit: stats.todayLit == null ? '--' : fmtNum(stats.todayLit),
        steps: stats.todaySteps == null ? '--' : fmtNum(stats.todaySteps)
      };
    },

    /* ---------------- 构建（一次性分配） ---------------- */

    /** 构建绘制静态资源：节点坐标、路径采样、三层星野、星云雾带、章节区段与环境粒子 */
    buildGeometry() {
      const { cw, ch } = this;
      const nodes = (this.route && this.route.nodes) || [];
      this.nodePts = routeCanvas.getCanvasNodePositions(nodes, cw, ch);

      // Catmull-Rom 平滑路径采样
      const sampled = routeCanvas.sampleRoutePath(this.nodePts, 30);
      this.path = sampled.path;
      this.pathDist = sampled.dist;
      this.pathLen = sampled.len;
      this.nodePathIdx = sampled.nodePathIndex;

      // 远景微星（静态烘焙，不闪）
      this.farStars = [];
      for (let i = 0; i < FAR_STAR_COUNT; i++) {
        const p = this.sampleSkyPoint(0.5);
        this.farStars.push({ x: p.x, y: p.y, r: 0.35 + Math.random() * 0.45, a: 0.2 + Math.random() * 0.3 });
      }

      // 中景星（静态烘焙，alpha 分档形成层次；闪烁由近景星承担）
      this.midStars = [];
      for (let i = 0; i < MID_STAR_COUNT; i++) {
        const p = this.sampleSkyPoint(0.35);
        this.midStars.push({
          x: p.x,
          y: p.y,
          r: 0.6 + Math.random() * 0.8,
          a: 0.35 + Math.random() * 0.4,
          color: STAR_TINTS[Math.floor(Math.random() * STAR_TINTS.length)]
        });
      }

      // 近景星（帧内：闪烁 + 缓慢漂移，出屏回绕；前 BRIGHT_STAR_COUNT 颗为亮星带十字光芒）
      this.nearStars = [];
      for (let i = 0; i < NEAR_STAR_COUNT; i++) {
        const big = i < BRIGHT_STAR_COUNT;
        const p = this.sampleSkyPoint(0.3);
        this.nearStars.push({
          x: p.x,
          y: p.y,
          r: big ? 1.5 + Math.random() * 0.9 : 0.9 + Math.random() * 0.7,
          lo: big ? 0.4 : 0.25, // 闪烁亮度下限
          span: big ? 0.6 : 0.5,
          freq: big ? 0.5 + Math.random() * 0.5 : 0.6 + Math.random() * 1.2, // 闪烁周期约 1.3~8s
          phase: Math.random() * Math.PI * 2,
          vx: (Math.random() - 0.5) * 1.2, // 漂移速度 px/s（极缓，营造纵深）
          vy: (Math.random() - 0.5) * 0.8,
          color: STAR_TINTS[Math.floor(Math.random() * STAR_TINTS.length)],
          glint: big
        });
      }
      // 按颜色排序：绘制时 fillStyle 只切换几次
      this.nearStars.sort((a, b) => (a.color < b.color ? -1 : a.color > b.color ? 1 : 0));

      // 星云雾带摆放（静态烘焙）：银河带方向 3 团大雾 + 深空补 2 团，低透明度
      this.nebulas = [];
      const nebSeed = [
        { x: 0.2, y: 0.16, s: 1.5, a: 0.1 },
        { x: 0.55, y: 0.3, s: 1.9, a: 0.08 },
        { x: 0.85, y: 0.42, s: 1.4, a: 0.09 },
        { x: 0.35, y: 0.6, s: 1.2, a: 0.06 },
        { x: 0.7, y: 0.08, s: 1.1, a: 0.07 }
      ];
      nebSeed.forEach((n) => {
        this.nebulas.push({ x: n.x * cw, y: n.y * ch, r: 90 * n.s * (cw / 375), a: n.a });
      });

      // 章节区段：取章节首末节点路径中点为雾带锚点，半径按区段路径长度
      this.chapterZones = [];
      const chapters = (this.route && this.route.chapters) || [];
      chapters.forEach((ch) => {
        const ids = ch.nodeIds || [];
        if (!ids.length) return;
        const theme = starThemes.getChapterTheme(ch);
        const i0 = this.nodeIndex[ids[0]];
        const i1 = this.nodeIndex[ids[ids.length - 1]];
        if (i0 == null || i1 == null) return;
        const p0 = this.nodePts[i0];
        const p1 = this.nodePts[i1];
        const cx = (p0.x + p1.x) / 2;
        const cy = (p0.y + p1.y) / 2;
        const r = Math.max(56, Math.hypot(p1.x - p0.x, p1.y - p0.y) * 0.62 + 34);
        this.chapterZones.push({ theme: theme, cx: cx, cy: cy, r: r, x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y });
      });

      // 章节环境粒子（帧内）：锚定各区段，类型/颜色/数量取自主题配置，构建期一次性分配
      this.envMotes = [];
      this.chapterZones.forEach((z) => {
        const cfg = z.theme.particle;
        const n = Math.min(cfg.count, 22);
        for (let k = 0; k < n; k++) {
          this.envMotes.push({
            type: cfg.type,
            color: cfg.color,
            size: cfg.size,
            rise: cfg.rise, // 上升(+) / 下落(-) 速度 px/s
            bx: z.cx,
            by: z.cy,
            ox: (Math.random() - 0.5) * z.r * 1.7,
            oy: (Math.random() - 0.5) * z.r * 1.1,
            range: z.r,
            phase: Math.random() * Math.PI * 2,
            freq: 0.4 + Math.random() * 0.9
          });
        }
      });

      // 节点名标签宽度缓存（避免每帧 measureText）
      this._labelW = {};
    },

    /**
     * 星点采样：bandRatio 概率落在左上→右中的斜向银河带（近似高斯散布），其余均匀散布于天空区，
     * 避免网格感；避让节点 16px 范围（最多重试 6 次），保证节点不被星点干扰。
     */
    sampleSkyPoint(bandRatio) {
      const { cw, ch } = this;
      const skyH = ch * 0.78;
      const pts = this.nodePts || [];
      let x = 0;
      let y = 0;
      for (let k = 0; k < 6; k++) {
        if (Math.random() < bandRatio) {
          const u = Math.random();
          const g = (Math.random() + Math.random() + Math.random() - 1.5) * 0.12 * ch;
          x = Math.min(cw, Math.max(0, u * cw - g * 0.4));
          y = Math.min(skyH, Math.max(0, (0.05 + 0.46 * u) * ch + g));
        } else {
          x = Math.random() * cw;
          y = Math.random() * skyH;
        }
        if (!pts.some((p) => Math.abs(p.x - x) < 16 && Math.abs(p.y - y) < 16)) break;
      }
      return { x, y };
    },

    /* ---------------- 离屏缓存 ---------------- */

    /** 构建静态背景离屏层：深空渐变底 / 星云雾带 / 远中景星 / 章节区段雾带 / 暗角。
     *  离屏画布不可用时降级为每帧直绘（paintSky 直接画到主上下文）。 */
    buildStatic() {
      try {
        const dpr = this.dpr;
        const off = wx.createOffscreenCanvas({ type: '2d', width: this.cw * dpr, height: this.ch * dpr });
        const octx = off.getContext('2d');
        octx.scale(dpr, dpr);
        this.paintSky(octx);
        this.staticLayer = off;
      } catch (e) {
        this.staticLayer = null;
      }
    },

    /**
     * 深空星幕静态绘制（烘焙内容）：四段深空蓝黑渐变 → 星云雾带（暖白软雾精灵）
     * → 远景微星 / 中景星 → 章节区段主题雾带 → 暗角收边。
     */
    paintSky(c) {
      const { cw, ch } = this;
      // 深空底（上→下四段）
      const sky = c.createLinearGradient(0, 0, 0, ch);
      const band = P.skyDeep;
      sky.addColorStop(0, band[0]);
      sky.addColorStop(0.38, band[1]);
      sky.addColorStop(0.72, band[2]);
      sky.addColorStop(1, band[3]);
      c.fillStyle = sky;
      c.fillRect(0, 0, cw, ch);

      // 星云雾带（柔和辉光，不喧宾夺主）
      if (this.glowSoft) {
        (this.nebulas || []).forEach((n) => {
          c.globalAlpha = n.a;
          c.drawImage(this.glowSoft, n.x - n.r, n.y - n.r * 0.62, n.r * 2, n.r * 1.24);
        });
        c.globalAlpha = 1;
      }

      // 远景微星
      c.fillStyle = '#DCE8FF';
      (this.farStars || []).forEach((s) => {
        c.globalAlpha = s.a;
        c.beginPath();
        c.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        c.fill();
      });
      c.globalAlpha = 1;

      // 中景星（按颜色分档）
      (this.midStars || []).forEach((s) => {
        c.globalAlpha = s.a;
        c.fillStyle = s.color;
        c.beginPath();
        c.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        c.fill();
      });
      c.globalAlpha = 1;

      // 章节区段主题雾带（环绕区段路径，双层：外晕 + 核心）
      if (this.glowSoft) {
        (this.chapterZones || []).forEach((z) => {
          c.globalAlpha = 0.85;
          c.drawImage(this.zoneSprite(z.theme, false), z.cx - z.r, z.cy - z.r * 0.8, z.r * 2, z.r * 1.6);
          c.globalAlpha = 0.9;
          c.drawImage(this.zoneSprite(z.theme, true), z.cx - z.r * 0.6, z.cy - z.r * 0.48, z.r * 1.2, z.r * 0.96);
        });
        c.globalAlpha = 1;
      }

      // 暗角（收拢视线到路线）
      const vg = c.createRadialGradient(cw / 2, ch * 0.42, Math.min(cw, ch) * 0.36, cw / 2, ch * 0.5, Math.max(cw, ch) * 0.78);
      vg.addColorStop(0, 'rgba(2,4,10,0)');
      vg.addColorStop(1, 'rgba(2,4,10,0.42)');
      c.fillStyle = vg;
      c.fillRect(0, 0, cw, ch);
    },

    /** 构建光晕精灵（金/红/暖白）：预渲染到离屏小画布，帧内 drawImage 缩放复用 */
    buildGlowSprites() {
      const stops = (rgb) => [
        [0, 'rgba(' + rgb + ',0.85)'],
        [0.4, 'rgba(' + rgb + ',0.32)'],
        [1, 'rgba(' + rgb + ',0)']
      ];
      this.glowGold = routeCanvas.createGlowSprite(stops('240,198,90'));
      this.glowRed = routeCanvas.createGlowSprite(stops('255,90,78'));
      this.glowSoft = routeCanvas.createGlowSprite([
        [0, 'rgba(190,205,240,0.5)'],
        [0.5, 'rgba(160,175,220,0.18)'],
        [1, 'rgba(140,155,205,0)']
      ]);
      this._zoneSprites = {}; // 区段主题雾带精灵缓存（theme.key + core）
    },

    /** 区段主题雾带精灵（按主题色预渲染，core=true 取更浓的核心色）；不可用时返回 null */
    zoneSprite(theme, core) {
      const key = theme.key + (core ? ':c' : ':n');
      if (this._zoneSprites[key]) return this._zoneSprites[key];
      const color = core ? theme.nebulaCore : theme.nebula;
      const m = color.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/);
      const sprite = m
        ? routeCanvas.createGlowSprite([
            [0, 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + (parseFloat(m[4]) * 2.2) + ')'],
            [0.55, color],
            [1, 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',0)']
          ])
        : this.glowSoft;
      this._zoneSprites[key] = sprite;
      return sprite;
    },

    /** 释放离屏层、精灵与构建期数组（切回实景模式时调用） */
    dispose() {
      this.ctx = null;
      this.staticLayer = null;
      this.glowGold = null;
      this.glowRed = null;
      this.glowSoft = null;
      this._zoneSprites = null;
      this.arriveFx = null;
      this.progressAnim = null;
      this.route = null;
      this.nodeIndex = null;
      this.nodePts = null;
      this.path = null;
      this.pathDist = null;
      this.nodePathIdx = null;
      this.stats = null;
      this.statsText = null;
      this.flyLine = null;
      this.farStars = null;
      this.midStars = null;
      this.nearStars = null;
      this.nebulas = null;
      this.chapterZones = null;
      this.envMotes = null;
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

    /** 帧率采样与降级判定：滚动 PERF_WINDOW 帧间隔均值 > PERF_BUDGET_MS 即置 lowPerf（粘性不恢复） */
    samplePerf(t) {
      const now = t * 1000;
      const last = this._perfLast;
      this._perfLast = now;
      if (!last) return;
      const dt = now - last;
      if (dt > PERF_GAP_MS || dt <= 0) return; // 切后台/断点时间跳变，丢弃
      if (!this._perfBuf) this._perfBuf = new Float32Array(PERF_WINDOW);
      if (this._perfN < PERF_WINDOW) {
        this._perfBuf[this._perfN++] = dt;
        this._perfSum += dt;
      } else {
        this._perfSum += dt - this._perfBuf[this._perfI];
        this._perfBuf[this._perfI] = dt;
        this._perfI = (this._perfI + 1) % PERF_WINDOW;
      }
      this._perfAvg = this._perfSum / this._perfN;
      if (!this.lowPerf && this._perfN === PERF_WINDOW && this._perfAvg > PERF_BUDGET_MS) {
        this.lowPerf = true;
      }
    },

    /**
     * 单帧总绘制。
     * @param {number} t 页面 rAF 传入的时间戳（秒）
     */
    draw(t) {
      const ctx = this.ctx;
      if (!ctx) return;
      this.samplePerf(t);
      const { cw, ch } = this;
      const v = this.view;

      // 静态层（星幕/星云/区段雾带/暗角），不可用时降级直绘
      if (this.staticLayer) {
        ctx.drawImage(this.staticLayer, 0, 0, cw, ch);
      } else {
        this.paintSky(ctx);
      }

      ctx.save();
      ctx.translate(v.ox, v.oy);
      ctx.scale(v.scale, v.scale);

      this.drawNearStars(t);
      this.drawEnvMotes(t);
      this.drawRoute(t);
      this.drawNodes(t);
      this.drawArriveFx(t);
      this.drawFlyLine(t);

      ctx.restore();

      // 视口固定 UI（不随拖动缩放）
      this.drawStatsCapsule(ctx);
      this.drawProgressRing(ctx);
      this.drawLegend(ctx);
      this.drawHint(ctx);
    },

    /** 近景星：闪烁（sin 相位）+ 极缓漂移（出屏回绕）；亮星带十字光芒。降级时只画静态位置 */
    drawNearStars(t) {
      const ctx = this.ctx;
      const { cw, ch } = this;
      let lastColor = null;
      (this.nearStars || []).forEach((s) => {
        if (!this.lowPerf) {
          s.x += s.vx * 0.016;
          s.y += s.vy * 0.016;
          if (s.x < -4) s.x = cw + 4;
          else if (s.x > cw + 4) s.x = -4;
          if (s.y < -4) s.y = ch + 4;
          else if (s.y > ch + 4) s.y = -4;
        }
        const tw = this.lowPerf ? 0.75 : s.lo + s.span * (0.5 + 0.5 * Math.sin(t * s.freq * Math.PI * 2 + s.phase));
        if (s.color !== lastColor) {
          ctx.fillStyle = s.color;
          lastColor = s.color;
        }
        ctx.globalAlpha = tw;
        const r = s.glint ? s.r * (0.9 + 0.2 * tw) : s.r;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (s.glint && !this.lowPerf) {
          // 十字光芒
          ctx.globalAlpha = tw * 0.5;
          ctx.fillRect(s.x - r * 3.2, s.y - 0.5, r * 6.4, 1);
          ctx.fillRect(s.x - 0.5, s.y - r * 3.2, 1, r * 6.4);
        }
      });
      ctx.globalAlpha = 1;
    },

    /** 章节环境粒子（雪粒下落/暖尘上升/金尘漂浮/水雾弥散），锚定区段、构建期分配 */
    drawEnvMotes(t) {
      const ctx = this.ctx;
      const cap = this.lowPerf ? 0.5 : 1; // 降级时减半绘制
      const list = this.envMotes || [];
      const n = Math.floor(list.length * cap);
      for (let i = 0; i < n; i++) {
        const m = list[i];
        // 位置：锚点 + 偏移 + 随时间垂直漂移（rise>0 上升，<0 下落），水平正弦轻摆
        const span = m.range * 1.1;
        let dy = m.oy + (m.rise > 0 ? -(t * m.rise * 4) % span : (t * -m.rise * 4) % span);
        if (dy > span / 2) dy -= span;
        if (dy < -span / 2) dy += span;
        const x = m.bx + m.ox + Math.sin(t * m.freq + m.phase) * 5;
        const y = m.by + dy;
        ctx.globalAlpha = (m.type === 'snow' ? 0.55 : 0.4) * (0.6 + 0.4 * Math.sin(t * m.freq * 2 + m.phase));
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.arc(x, y, m.size * (m.type === 'mist' ? 1.6 : 1), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },

    /**
     * 红色征途路线：
     * 未解锁段暗红基底（全程）→ 已完成段金红主径（外发光 + 红主径 + 金内核）
     * → 当前段沿路径方向的红色流光（虚线 offset 逐帧前移）→ 行进旗帜。
     */
    drawRoute(t) {
      const ctx = this.ctx;
      if (!this.path || this.path.length < 2) return;
      const ratio = this.currentRatio();
      // 入场描画：首次渲染时路线自起点绘出
      let drawRatio = ratio;
      if (this.introStart) {
        const p = (Date.now() - this.introStart) / INTRO_MS;
        if (p >= 1) {
          this.introStart = 0;
        } else {
          drawRatio = ratio * routeCanvas.easeOutCubic(Math.max(0, p));
        }
      }
      const endIdx = Math.max(1, Math.floor(drawRatio * (this.path.length - 1)));
      const lastIdx = this.path.length - 1;

      // 全程暗红基底（未解锁段可辨识）
      ctx.strokeStyle = P.routeLocked;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      routeCanvas.tracePath(ctx, this.path, lastIdx);
      ctx.stroke();

      if (endIdx > 1) {
        // 已完成段：红色外发光 + 红色主径 + 金色内核
        ctx.strokeStyle = P.routeDoneGlow;
        ctx.lineWidth = 7;
        routeCanvas.tracePath(ctx, this.path, endIdx);
        ctx.stroke();

        ctx.strokeStyle = P.routeDone;
        ctx.lineWidth = 3;
        routeCanvas.tracePath(ctx, this.path, endIdx);
        ctx.stroke();

        ctx.strokeStyle = P.gold;
        ctx.lineWidth = 1.1;
        ctx.globalAlpha = 0.85;
        routeCanvas.tracePath(ctx, this.path, endIdx);
        ctx.stroke();
        ctx.globalAlpha = 1;

        // 当前段流光（沿路径方向流动；降级时降低频率由调用方省帧，仍保留）
        const offset = -((t * FLOW_SPEED) % 14);
        ctx.strokeStyle = P.routeFlow;
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        routeCanvas.drawDashFlow(ctx, this.path, endIdx, 5, 9, offset);
      }

      // 行进旗帜（当前进度点；未完成时显示）
      if (ratio > 0 && ratio < 1 && this.route && !this.route.finished) {
        this.drawProgressFlag(ctx, this.path[endIdx]);
      }
    },

    /** 行进旗帜：金色旗座光晕 + 红色小旗 */
    drawProgressFlag(ctx, p) {
      if (!p) return;
      if (this.glowGold) {
        ctx.globalAlpha = 0.8;
        ctx.drawImage(this.glowGold, p.x - 14, p.y - 14, 28, 28);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = P.gold;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x, p.y - 13);
      ctx.stroke();
      ctx.fillStyle = P.nodeCurrent;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 13);
      ctx.lineTo(p.x + 8, p.y - 10);
      ctx.lineTo(p.x, p.y - 7);
      ctx.closePath();
      ctx.fill();
    },

    /* ---------------- 节点（E2 基础三态；差异化图标在 E4 接入） ---------------- */

    drawNodes(t) {
      const nodes = (this.route && this.route.nodes) || [];
      const ctx = this.ctx;
      nodes.forEach((node, i) => {
        const p = this.nodePts[i];
        if (!p) return;
        if (node.status === 'completed') this.drawNodeCompleted(ctx, node, p, t);
        else if (node.status === 'current') this.drawNodeCurrent(ctx, node, p, t);
        else this.drawNodeLocked(ctx, node, p, t);
        this.drawNodeLabel(ctx, node, p);
      });
    },

    /** 已点亮：明亮金色核心 + 金色光环 + 稳定呼吸 */
    drawNodeCompleted(ctx, node, p, t) {
      const breathe = 0.85 + 0.15 * Math.sin(t * 1.6 + p.x);
      if (this.glowGold) {
        ctx.globalAlpha = 0.55 * breathe;
        ctx.drawImage(this.glowGold, p.x - 17, p.y - 17, 34, 34);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = P.gold;
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = P.gold;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.2, 0, Math.PI * 2);
      ctx.fill();
    },

    /** 当前节点：红色核心 + 脉冲扩散环 + 强辉光 */
    drawNodeCurrent(ctx, node, p, t) {
      if (this.glowRed) {
        ctx.globalAlpha = 0.75;
        const s = 40 + 6 * Math.sin(t * 2.2);
        ctx.drawImage(this.glowRed, p.x - s / 2, p.y - s / 2, s, s);
        ctx.globalAlpha = 1;
      }
      // 脉冲环
      const pr = 8 + ((t * 14) % 12);
      ctx.strokeStyle = P.nodeCurrent;
      ctx.globalAlpha = Math.max(0, 0.7 * (1 - (pr - 8) / 12));
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // 主环 + 核心
      ctx.strokeStyle = P.nodeCurrent;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = P.nodeCurrent;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.6, 0, Math.PI * 2);
      ctx.fill();
    },

    /** 未解锁：暗色核心 + 微弱外环 + 极轻呼吸（提示可点击查看历史） */
    drawNodeLocked(ctx, node, p, t) {
      const breathe = 0.7 + 0.3 * Math.sin(t * 1.1 + p.y);
      ctx.strokeStyle = P.nodeLockedRing;
      ctx.globalAlpha = breathe;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = P.nodeLockedCore;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.6, 0, Math.PI * 2);
      ctx.fill();
    },

    /** 节点名称标签（宽度缓存，按状态着色） */
    drawNodeLabel(ctx, node, p) {
      const text = node.name || '';
      if (!text) return;
      ctx.font = '10px sans-serif';
      if (this._labelW[node.id] == null) this._labelW[node.id] = ctx.measureText(text).width;
      const w = this._labelW[node.id];
      ctx.fillStyle =
        node.status === 'completed' ? P.labelDone : node.status === 'current' ? P.labelCurrent : P.labelLocked;
      ctx.fillText(text, p.x - w / 2, p.y + 20);
    },

    /* ---------------- 抵达特效与飞线 ---------------- */

    /** 新点亮节点播放抵达动画：亮起 → 光环扩散 → 粒子四散 → 稳定发光 */
    playArrive(ids) {
      if (!ids || !ids.length) return;
      if (!this.arriveFx) this.arriveFx = [];
      ids.forEach((id) => {
        const i = this.nodeIndex ? this.nodeIndex[id] : null;
        if (i == null || !this.nodePts[i]) return;
        this.arriveFx.push({ nodeId: id, start: Date.now(), particles: this.makeArriveParticles(this.nodePts[i]) });
      });
    },

    /** 点亮粒子（总量封顶 PARTICLE_CAP，构建期模式：一次性分配） */
    makeArriveParticles(p) {
      const list = [];
      const existing = (this.arriveFx || []).reduce((acc, fx) => acc + fx.particles.length, 0);
      const budget = Math.max(0, PARTICLE_CAP - existing);
      const n = Math.min(14, budget);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
        list.push({
          x: p.x,
          y: p.y,
          vx: Math.cos(a) * (18 + Math.random() * 26),
          vy: Math.sin(a) * (18 + Math.random() * 26),
          r: 1 + Math.random() * 1.6
        });
      }
      return list;
    },

    drawArriveFx(t) {
      if (!this.arriveFx || !this.arriveFx.length) return;
      const ctx = this.ctx;
      const now = Date.now();
      this.arriveFx = this.arriveFx.filter((fx) => now - fx.start < ARRIVE_FX_MS);
      this.arriveFx.forEach((fx) => {
        const i = this.nodeIndex ? this.nodeIndex[fx.nodeId] : null;
        if (i == null || !this.nodePts[i]) return;
        const p = this.nodePts[i];
        const k = (now - fx.start) / ARRIVE_FX_MS;
        // 光环扩散
        const rr = 10 + k * 34;
        ctx.strokeStyle = P.gold;
        ctx.globalAlpha = Math.max(0, 0.8 * (1 - k));
        ctx.lineWidth = 2 * (1 - k) + 0.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        // 粒子扩散（降级时跳过，纯氛围无信息量）
        if (!this.lowPerf) {
          ctx.fillStyle = P.gold;
          fx.particles.forEach((pt) => {
            const px = pt.x + pt.vx * k * 1.6;
            const py = pt.y + pt.vy * k * 1.6;
            ctx.globalAlpha = Math.max(0, 0.9 * (1 - k));
            ctx.beginPath();
            ctx.arc(px, py, pt.r * (1 - k * 0.5), 0, Math.PI * 2);
            ctx.fill();
          });
          ctx.globalAlpha = 1;
        }
      });
    },

    /** WS 他人点亮事件：红金数据流光沿路线飞向目标节点 */
    playFlyLine(nodeId) {
      const i = this.nodeIndex ? this.nodeIndex[nodeId] : null;
      if (i == null) return;
      this.flyLine = { nodeId: nodeId, start: Date.now() };
    },

    drawFlyLine(t) {
      const fly = this.flyLine;
      if (!fly || !this.path || this.path.length < 2) return;
      const now = Date.now();
      const k = (now - fly.start) / FLY_MS;
      if (k >= 1) {
        this.flyLine = null;
        return;
      }
      const i = this.nodeIndex[fly.nodeId];
      if (i == null) return;
      const endPathIdx = this.nodePathIdx[i];
      const head = Math.floor(k * endPathIdx);
      if (head < 2) return;
      const tail = Math.max(0, head - Math.floor(this.path.length * 0.06));
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = P.routeFlow;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.85 * (1 - k * 0.4);
      ctx.beginPath();
      ctx.moveTo(this.path[tail].x, this.path[tail].y);
      for (let j = tail + 1; j <= head; j++) ctx.lineTo(this.path[j].x, this.path[j].y);
      ctx.stroke();
      // 头部光点
      if (this.glowRed) {
        const hp = this.path[head];
        ctx.globalAlpha = 0.9;
        ctx.drawImage(this.glowRed, hp.x - 8, hp.y - 8, 16, 16);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    },

    /* ---------------- 视口固定 UI（克制呈现） ---------------- */

    /** 左上全员数据胶囊：单行三段（今日参与/点亮/全员步数），深色半透明底 */
    drawStatsCapsule(ctx) {
      if (!this.statsText) return;
      const s = this.statsText;
      ctx.font = '10px sans-serif';
      const label = '今日 ';
      const w1 = ctx.measureText(label).width;
      const wU = ctx.measureText(s.users).width;
      const wDot = ctx.measureText(' · ').width;
      const wL = ctx.measureText(s.lit).width;
      const wS = ctx.measureText(s.steps).width;
      const suffix = ' 步';
      const wSu = ctx.measureText(suffix).width;
      const totalW = w1 + wU + wDot + wL + wDot + wS + wSu + 20;
      const x = 12;
      const y = 12;
      ctx.fillStyle = 'rgba(10,14,26,0.55)';
      routeCanvas.drawRoundRect(ctx, x, y, totalW, 20, 10);
      ctx.fill();
      ctx.fillStyle = 'rgba(230,220,205,0.75)';
      let cx = x + 10;
      ctx.fillText(label, cx, y + 14);
      cx += w1;
      ctx.fillStyle = P.gold;
      ctx.fillText(s.users, cx, y + 14);
      cx += wU;
      ctx.fillStyle = 'rgba(230,220,205,0.5)';
      ctx.fillText(' · ', cx, y + 14);
      cx += wDot;
      ctx.fillStyle = P.gold;
      ctx.fillText(s.lit, cx, y + 14);
      cx += wL;
      ctx.fillStyle = 'rgba(230,220,205,0.5)';
      ctx.fillText(' · ', cx, y + 14);
      cx += wDot;
      ctx.fillStyle = P.gold;
      ctx.fillText(s.steps, cx, y + 14);
      cx += wS;
      ctx.fillStyle = 'rgba(230,220,205,0.75)';
      ctx.fillText(suffix, cx, y + 14);
    },

    /** 右上进度仪表环：金红弧 + 整数百分比（按整数变化缓存文本） */
    drawProgressRing(ctx) {
      const ratio = this.calcRouteProgress(this.route);
      const pct = Math.round(ratio * 100);
      const cx = this.cw - RING_R - 14;
      const cy = RING_R + 12;
      ctx.strokeStyle = 'rgba(240,198,90,0.2)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, RING_R, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = P.gold;
      ctx.lineCap = 'round';
      routeCanvas.drawArcGauge(ctx, cx, cy, RING_R, ratio);
      ctx.stroke();
      if (pct !== this._ringPct) {
        this._ringPct = pct;
        this._ringText = pct + '%';
      }
      ctx.font = '10px sans-serif';
      ctx.fillStyle = P.labelDone;
      const w = ctx.measureText(this._ringText).width;
      ctx.fillText(this._ringText, cx - w / 2, cy + 3.5);
    },

    /** 底部三态图例 */
    drawLegend(ctx) {
      const y = this.ch - 30;
      const totalW = LEGEND_STEP * (LEGEND.length - 1);
      let x = (this.cw - totalW) / 2;
      ctx.font = '9px sans-serif';
      LEGEND.forEach((item) => {
        ctx.fillStyle = item.color;
        ctx.beginPath();
        ctx.arc(x, y - 3, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(230,220,205,0.6)';
        ctx.fillText(item.text, x + 6, y);
        x += LEGEND_STEP;
      });
    },

    /** 底部操作提示（宽度缓存） */
    drawHint(ctx) {
      ctx.font = '9px sans-serif';
      if (!this._hintW) this._hintW = ctx.measureText(HINT_TEXT).width;
      ctx.fillStyle = 'rgba(220,210,195,0.35)';
      ctx.fillText(HINT_TEXT, (this.cw - this._hintW) / 2, this.ch - 12);
    },

    /* ---------------- 观景变换与命中 ---------------- */

    /** 钳制观景变换：缩放 1~2.5，平移不使场景离开画布 */
    clampView() {
      const v = this.view;
      v.scale = Math.min(2.5, Math.max(1, v.scale));
      const minOx = this.cw - this.cw * v.scale;
      const minOy = this.ch - this.ch * v.scale;
      v.ox = Math.min(0, Math.max(minOx, v.ox));
      v.oy = Math.min(0, Math.max(minOy, v.oy));
    },

    /** 双击复位 */
    resetView() {
      this.view.scale = 1;
      this.view.ox = 0;
      this.view.oy = 0;
    },

    /**
     * 节点命中测试：屏幕坐标 → 场景逆变换，取 26px 场景半径内最近节点
     * （命中半径大于发光视觉半径，保证点击区域足够大）。
     * @returns {number|null} 节点 id
     */
    hitTest(sx, sy) {
      const v = this.view;
      const x = (sx - v.ox) / v.scale;
      const y = (sy - v.oy) / v.scale;
      const nodes = (this.route && this.route.nodes) || [];
      if (!this.nodePts) return null;
      let best = null;
      let bestD = 26;
      nodes.forEach((n, i) => {
        const p = this.nodePts[i];
        if (!p) return;
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestD) {
          bestD = d;
          best = n.id;
        }
      });
      return best;
    }
  };
}

module.exports = { createStarMap };
