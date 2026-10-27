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
 *   帧内（视口固定，不随拖动缩放）——仅底部三态图例，
 *   克制呈现（暖白文字，不再使用 HUD 仪器元素与青蓝色）。
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
const PROGRESS_MS = 800; // 步数刷新增量推进时长
const ARRIVE_FX_MS = 2600; // 节点点亮动画时长
const PARTICLE_CAP = 64; // 点亮粒子总量上限
const FLY_MS = 1400; // WS 飞线单趟时长
const FOCUS_MS = 420; // 详情面板打开前的节点聚焦补间时长
const FLOW_SPEED = 26; // 路线流光速度（px/s，沿路径前进方向）

/* 关键历史节点（外环刻度装饰，标识丰碑身份）：遵义会议 / 飞夺泸定桥 / 延安（会师） */
const KEY_NODES = { 2: true, 6: true, 10: true };

/* 完整进入动画每次小程序生命周期只播一次（切模式重建内核后只播快速淡入，
 * 避免「每次刷新都重复冗长完整演出」；页面级 CSS 开场动画的首次标记在 march.js 另行管理） */
let INTRO_PLAYED = false;

/* 进入动画时间线（完整版）：星幕淡入 0~600ms → 星云星群随静态层同现 →
 * 路线自起点绘制 600~2600ms（已完成节点随描画依次亮起）→ 当前节点焦点 2400ms 起 →
 * 视口 UI（图例）2600~3200ms 淡入。轻量版压缩为 0~900ms。 */
const INTRO_FULL = { sky: 600, routeStart: 600, routeEnd: 2600, uiStart: 2600, uiEnd: 3200 };
const INTRO_LITE = { sky: 300, routeStart: 100, routeEnd: 700, uiStart: 600, uiEnd: 900 };

/* 延安终点页内仪式时间线：0~1s 焦点转向终点 → 0.2~1.4s 全程路线金色逐段重亮 →
 * 1~2.6s 金粒子向终点汇聚 → 2.2~3.6s 终点光环展开。播完后终点常亮胜利光环（静态完成态）。 */
const FINALE_MS = 3600;
const FINALE_PARTICLES = 30;

/* ---- 帧率自适应降级 ---- */
const PERF_WINDOW = 30; // 采样窗口帧数
const PERF_BUDGET_MS = 33; // 帧间隔预算（>33ms 即 <30fps）
const PERF_GAP_MS = 1000; // 超过此间隔视为暂停/切后台的时间跳变，丢弃该样本

/* ---- 视口固定 UI ---- */
const LEGEND = [
  { text: '已点亮', color: P.gold },
  { text: '当前', color: P.nodeCurrent },
  { text: '未解锁', color: 'rgba(220,190,180,0.4)' }
];
const LEGEND_STEP = 54; // 图例项水平间距

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
    nodePathIdx: null, // 各节点在采样路径上的下标（飞线终点定位、红线进度换算）
    progressMarks: null, // 各节点达标步数占全程的比例刻度（null=数据不可用，进度退化为采样点等分）
    litFloor: 0, // 已点亮节点中最远的位置比例（步数回落时红线不退回其之前）

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
    introFull: false, // 本次入场是否为完整版（模块级 INTRO_PLAYED 判定）
    progressAnim: null, // {from, to, start} 增量推进
    arriveFx: null, // [{nodeId, start, particles}] 点亮动画
    flyLine: null, // {nodeId, start} WS 飞线
    finale: null, // {start} 延安终点页内仪式（playFinale 触发）
    finaleParticles: null, // 终点仪式金粒子（汇聚向延安）
    _focus: null, // {start, fs/fox/foy, ts/tox/toy} 详情面板打开前的节点聚焦补间

    // 缓存
    _labelW: null, // 节点名文字宽度缓存

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
        this.introFull = !INTRO_PLAYED;
        INTRO_PLAYED = true;
        this.progressAnim = null;
      } else if (Math.abs(next - prevProgress) > 1e-4) {
        this.progressAnim = { from: prevProgress, to: next, start: Date.now() };
      }
    },

    /**
     * 进入动画阶段：null=已结束；否则返回 {el, tl} 供各层计算淡入/描画进度。
     * 纯时间推导无定时器，onHide 停 rAF 即中断、onShow 恢复自动续播（可中断可重入）。
     */
    introPhase() {
      if (!this.introStart) return null;
      const el = Date.now() - this.introStart;
      const tl = this.introFull ? INTRO_FULL : INTRO_LITE;
      if (el >= tl.uiEnd) {
        this.introStart = 0;
        return null;
      }
      return { el: el, tl: tl };
    },

    /** 全程行军进度（0~1）：优先取后端 routeProgress，旧接口降级为步数比例 */
    calcRouteProgress(route) {
      if (!route) return 0;
      if (typeof route.routeProgress === 'number') return Math.min(1, Math.max(0, route.routeProgress));
      if (!route.totalSteps) return 0;
      return Math.min(1, Math.max(0, route.currentSteps / route.totalSteps));
    },

    /** 当前生效的行军进度（步数口径 0~1）：增量推进动画期间按 easeOutCubic 插值 */
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
     * 步数口径进度 → 采样路径位置比例（0~1），红线终点定位用。
     * 采样点是「每段等分」的（各节点区间固定 30 子段），而各节点达标步数跨度不等
     * （现种子前 5 段各 5000 步、后 4 段各 10000 步），直接把步数比例当作路径比例会让
     * 红线终点与节点坐标错位——表现为「节点已点亮、红线却仍停在它之前」。此处按节点
     * 逐段换算：步数达到某节点即红线正好走到该节点采样位置，段内线性推进；并以最远
     * 已点亮节点为下限（点亮永久保留，步数回落时红线不退回其之前）。
     * 与实景模式 buildMapData 的已完成段插值共用 routeCanvas.locateSegment 口径。
     */
    pathRatio(ratio) {
      const marks = this.progressMarks;
      const last = this.path ? this.path.length - 1 : 0;
      const r = Math.min(1, Math.max(0, ratio || 0));
      if (!marks || last <= 0) return r; // 缺 targetSteps 刻度时退化为采样点等分（旧口径）
      const loc = routeCanvas.locateSegment(marks, Math.max(r, this.litFloor));
      if (loc.done) return 1;
      if (loc.seg < 0) return 0;
      const i0 = this.nodePathIdx[loc.seg];
      const i1 = this.nodePathIdx[loc.seg + 1];
      return (i0 + (i1 - i0) * loc.ratio) / last;
    },

    /** 本帧红线实际描到的路径位置比例（= pathRatio 乘入场描画的推进系数） */
    framePathRatio(intro) {
      const r = this.pathRatio(this.currentRatio());
      if (!intro) return r;
      const p = (intro.el - intro.tl.routeStart) / (intro.tl.routeEnd - intro.tl.routeStart);
      return r * routeCanvas.easeOutCubic(Math.min(1, Math.max(0, p)));
    },

    /**
     * 路径位置比例 → 采样下标。+1e-9 抵消「比例 ↔ 下标」往返的浮点误差，
     * 否则步数正好达到某节点阈值时会被 floor 少吃一个采样点（红线差一点没碰到节点）。
     */
    endIdxOf(ratio) {
      const last = this.path.length - 1;
      return Math.min(last, Math.max(1, Math.floor(ratio * last + 1e-9)));
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
      this.nodePathIdx = sampled.nodePathIndex;
      // 步数进度 → 路径位置的换算刻度（红线终点与节点点亮必须同口径，见 buildProgressScale）
      this.buildProgressScale(nodes);

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
        this.chapterZones.push({
          theme: theme,
          cx: cx,
          cy: cy,
          r: r,
          x0: p0.x,
          y0: p0.y,
          x1: p1.x,
          y1: p1.y,
          // 区段路径下标区间（静态层能量带描边用）
          pathIdx0: this.nodePathIdx[i0],
          pathIdx1: this.nodePathIdx[i1]
        });
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
     * 构建「步数进度比例 → 路径位置」换算刻度（每次数据注入随 buildGeometry 重建）。
     * progressMarks 为各节点 targetSteps 占末节点 targetSteps 的比例（与 routeProgress 同口径，
     * 故增量推进动画插值出的比例可直接换算）；litFloor 为已点亮节点中最远的比例刻度。
     * 节点不足 2 个或 targetSteps 缺失/末节点为 0 时置 null，进度换算退化为采样点等分。
     */
    buildProgressScale(nodes) {
      const lastTarget = nodes.length ? nodes[nodes.length - 1].targetSteps : 0;
      const usable =
        nodes.length >= 2 &&
        typeof lastTarget === 'number' &&
        lastTarget > 0 &&
        nodes.every((n) => typeof n.targetSteps === 'number');
      if (!usable) {
        this.progressMarks = null;
        this.litFloor = 0;
        return;
      }
      const marks = [];
      let floor = 0;
      nodes.forEach((n) => {
        const m = Math.min(1, Math.max(0, n.targetSteps / lastTarget));
        marks.push(m);
        if (n.status === 'completed' && m > floor) floor = m;
      });
      this.progressMarks = marks;
      this.litFloor = floor;
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

      // 章节区段地景与专属装饰（剪影/铁索/天光/能量轨迹）
      this.paintChapterScenery(c);

      // 暗角（收拢视线到路线）
      const vg = c.createRadialGradient(cw / 2, ch * 0.42, Math.min(cw, ch) * 0.36, cw / 2, ch * 0.5, Math.max(cw, ch) * 0.78);
      vg.addColorStop(0, 'rgba(2,4,10,0)');
      vg.addColorStop(1, 'rgba(2,4,10,0.42)');
      c.fillStyle = vg;
      c.fillRect(0, 0, cw, ch);
    },

    /**
     * 章节区段地景与专属装饰（静态烘焙进星幕层，跟随区段锚点）：
     * - silhouette 'ridge' 峡谷折岭（突围章：左右对峙山岭夹出 V 形峡谷）
     * - silhouette 'peaks' 雪山尖峰（翻越章：连绵三角峰 + 雪顶）
     * - extra 'dawn' 地平线天光（会师章：区段下方暖金椭圆天光 + 大团金雾）
     * - turning 章（赤水）区段路径下垫红色能量宽带，强化「战略转折」的能量轨迹意象
     * 全部为低透明氛围层，不遮挡节点与标签。
     */
    paintChapterScenery(c) {
      const zones = this.chapterZones || [];
      zones.forEach((z) => {
        const r = z.r;
        const base = z.cy + r * 0.62; // 地景基线（区段锚点下方）

        // 赤水转折：区段路径下垫红色能量带
        if (z.theme.key === 'turning' && this.path && z.pathIdx1 > z.pathIdx0) {
          c.strokeStyle = 'rgba(232,60,60,0.13)';
          c.lineWidth = 13;
          c.lineCap = 'round';
          c.lineJoin = 'round';
          c.beginPath();
          c.moveTo(this.path[z.pathIdx0].x, this.path[z.pathIdx0].y);
          for (let i = z.pathIdx0 + 1; i <= z.pathIdx1; i++) c.lineTo(this.path[i].x, this.path[i].y);
          c.stroke();
        }

        // 峡谷折岭剪影（突围章）
        if (z.theme.silhouette === 'ridge') {
          c.fillStyle = 'rgba(12,14,24,0.66)';
          // 左岭
          c.beginPath();
          c.moveTo(z.cx - r * 1.15, base);
          c.lineTo(z.cx - r * 0.72, base - r * 0.42);
          c.lineTo(z.cx - r * 0.46, base - r * 0.3);
          c.lineTo(z.cx - r * 0.18, base - r * 0.56);
          c.lineTo(z.cx - r * 0.04, base - r * 0.1);
          c.lineTo(z.cx - r * 0.02, base);
          c.closePath();
          c.fill();
          // 右岭
          c.beginPath();
          c.moveTo(z.cx + r * 1.15, base);
          c.lineTo(z.cx + r * 0.7, base - r * 0.38);
          c.lineTo(z.cx + r * 0.44, base - r * 0.52);
          c.lineTo(z.cx + r * 0.16, base - r * 0.3);
          c.lineTo(z.cx + r * 0.04, base - r * 0.08);
          c.lineTo(z.cx + r * 0.02, base);
          c.closePath();
          c.fill();
        }

        // 雪山尖峰剪影（翻越章）
        if (z.theme.silhouette === 'peaks') {
          c.fillStyle = 'rgba(14,20,34,0.7)';
          const w = r * 2.3;
          const x0 = z.cx - w / 2;
          c.beginPath();
          c.moveTo(x0, base);
          const peaks = 4;
          for (let i = 0; i < peaks; i++) {
            const px = x0 + (w / peaks) * (i + 0.5);
            const ph = r * (0.34 + (i % 2) * 0.16); // 峰高错落
            c.lineTo(px - w / peaks / 2, base);
            c.lineTo(px, base - ph);
            c.lineTo(px + w / peaks / 2, base);
          }
          c.lineTo(x0 + w, base);
          c.closePath();
          c.fill();
          // 雪顶（峰尖小三角，冷色微光）
          c.fillStyle = 'rgba(205,225,250,0.16)';
          for (let i = 0; i < peaks; i++) {
            const px = x0 + (w / peaks) * (i + 0.5);
            const ph = r * (0.34 + (i % 2) * 0.16);
            c.beginPath();
            c.moveTo(px - w / peaks * 0.14, base - ph * 0.72);
            c.lineTo(px, base - ph);
            c.lineTo(px + w / peaks * 0.14, base - ph * 0.72);
            c.closePath();
            c.fill();
          }
        }

        // 地平线天光（会师章）：椭圆径向渐变让左右边缘也自然消隐，避免矩形底色截断星空
        if (z.theme.extra === 'dawn') {
          const bandH = r * 0.5;
          c.save();
          c.translate(z.cx, base - bandH * 0.18);
          c.scale(r * 1.45, bandH);
          const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
          g.addColorStop(0, 'rgba(240,198,90,0.18)');
          g.addColorStop(0.45, 'rgba(240,198,90,0.1)');
          g.addColorStop(1, 'rgba(240,198,90,0)');
          c.fillStyle = g;
          c.fillRect(-1, -1, 2, 2);
          c.restore();
          if (this.glowGold) {
            c.globalAlpha = 0.35;
            c.drawImage(this.glowGold, z.cx - r * 0.9, base - r * 0.75, r * 1.8, r * 0.9);
            c.globalAlpha = 1;
          }
        }
      });
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
      this.finale = null;
      this.finaleParticles = null;
      this.route = null;
      this.nodeIndex = null;
      this.nodePts = null;
      this.path = null;
      this.nodePathIdx = null;
      this.progressMarks = null;
      this.litFloor = 0;
      this.flyLine = null;
      this.farStars = null;
      this.midStars = null;
      this.nearStars = null;
      this.nebulas = null;
      this.chapterZones = null;
      this.envMotes = null;
      this._labelW = null;
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
      const intro = this.introPhase();
      this.applyFocus();

      // 静态层（星幕/星云/区段雾带/暗角），不可用时降级直绘；进入动画第 1 步：星幕淡入
      const skyAlpha = intro ? Math.min(1, intro.el / intro.tl.sky) : 1;
      ctx.globalAlpha = skyAlpha;
      if (this.staticLayer) {
        ctx.drawImage(this.staticLayer, 0, 0, cw, ch);
      } else {
        this.paintSky(ctx);
      }
      ctx.globalAlpha = 1;

      ctx.save();
      ctx.translate(v.ox, v.oy);
      ctx.scale(v.scale, v.scale);

      if (skyAlpha > 0.6) this.drawNearStars(t);
      this.drawEnvMotes(t);
      this.drawRoute(t, intro);
      this.drawNodes(t, intro);
      this.drawArriveFx(t);
      this.drawFlyLine(t);
      this.drawFinale(t);

      ctx.restore();

      // 视口固定 UI（不随拖动缩放，仅三态图例）；进入动画第 6 步：最后淡入
      const uiAlpha = intro ? Math.min(1, Math.max(0, (intro.el - intro.tl.uiStart) / (intro.tl.uiEnd - intro.tl.uiStart))) : 1;
      if (uiAlpha > 0) {
        ctx.globalAlpha = uiAlpha;
        this.drawLegend(ctx);
        ctx.globalAlpha = 1;
      }
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
     * 进入动画第 3 步：路线在 intro 时间线窗口内自起点向前绘制。
     */
    drawRoute(t, intro) {
      const ctx = this.ctx;
      if (!this.path || this.path.length < 2) return;
      const lastIdx = this.path.length - 1;
      // 步数口径先换算为路径位置口径，红线终点才能与节点点亮位置对齐（见 pathRatio）；
      // 入场描画时再按 [tl.routeStart, tl.routeEnd] 窗口自起点绘出
      const front = this.framePathRatio(intro);
      const endIdx = this.endIdxOf(front);

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
      if (front > 0 && front < 1 && this.route && !this.route.finished) {
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

    /* ---------------- 节点（四态 + 差异化历史图标） ---------------- */

    drawNodes(t, intro) {
      const nodes = (this.route && this.route.nodes) || [];
      const ctx = this.ctx;
      const finished = !!(this.route && this.route.finished);
      // 入场描画：节点随红线笔尖依次亮起，与 drawRoute 共用同一「采样下标」口径，
      // 每帧只算一次笔尖位置（未描到保持 35% 暗态可辨识）
      const lastIdx = this.path ? this.path.length - 1 : 0;
      const introFront = intro && lastIdx > 0 ? this.framePathRatio(intro) : -1;
      nodes.forEach((node, i) => {
        const p = this.nodePts[i];
        if (!p) return;
        let appear = 1;
        if (introFront >= 0) {
          const nodeRatio = this.nodePathIdx[i] / lastIdx;
          appear = Math.min(1, Math.max(0.35, 0.35 + (introFront - nodeRatio) / 0.05));
        }
        ctx.globalAlpha = appear;
        if (node.status === 'completed') this.drawNodeCompleted(ctx, node, p, t);
        else if (node.status === 'current') this.drawNodeCurrent(ctx, node, p, t);
        else this.drawNodeLocked(ctx, node, p, t);
        // 延安终点：全程完成后常亮胜利光环（静态完成态，重进页面不播仪式也有仪式感）
        if (finished && i === nodes.length - 1) this.drawVictoryHalo(ctx, p, t);
        // 关键历史节点（遵义/泸定桥/延安）：外环四方位刻度，标识其丰碑身份
        if (KEY_NODES[node.id] && node.status !== 'unlocked') this.drawKeyNodeTicks(ctx, node, p);
        ctx.globalAlpha = 1;
        this.drawNodeLabel(ctx, node, p);
      });
    },

    /** 延安胜利光环（静态完成态）：常亮大金晕 + 双层缓呼吸光环 */
    drawVictoryHalo(ctx, p, t) {
      if (this.glowGold) {
        const s = 72 + 8 * Math.sin(t * 1.2);
        ctx.globalAlpha = 0.65;
        ctx.drawImage(this.glowGold, p.x - s / 2, p.y - s / 2, s, s);
        ctx.globalAlpha = 1;
      }
      for (let k = 0; k < 2; k++) {
        const rr = 14 + k * 7 + 1.5 * Math.sin(t * 1.2 + k);
        ctx.strokeStyle = P.gold;
        ctx.globalAlpha = 0.55 - k * 0.2;
        ctx.lineWidth = 1.4 - k * 0.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },

    /** 已点亮：明亮金色核心 + 金色双环 + 稳定呼吸 + 金色图标 */
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
      // 内环（丰碑双环）
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = P.gold;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.4, 0, Math.PI * 2);
      ctx.fill();
      this.drawNodeIcon(ctx, node, p, '#5C4210');
    },

    /** 当前节点：红色核心 + 脉冲扩散环 + 强辉光 + 环绕流动粒子 + 红色图标 */
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
      ctx.arc(p.x, p.y, 4.8, 0, Math.PI * 2);
      ctx.fill();
      this.drawNodeIcon(ctx, node, p, '#FFE9E4');
      // 环绕流动粒子（降级时关闭，纯氛围）
      if (!this.lowPerf) {
        for (let k = 0; k < 3; k++) {
          const a = t * 1.5 + (k * Math.PI * 2) / 3;
          const px = p.x + Math.cos(a) * 13.5;
          const py = p.y + Math.sin(a) * 13.5 * 0.72;
          ctx.globalAlpha = 0.75;
          ctx.fillStyle = P.routeFlow;
          ctx.beginPath();
          ctx.arc(px, py, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    },

    /** 未解锁：暗色核心 + 微弱外环 + 极轻呼吸（提示可点击查看历史）+ 暗色图标 */
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
      ctx.arc(p.x, p.y, 3.8, 0, Math.PI * 2);
      ctx.fill();
      this.drawNodeIcon(ctx, node, p, 'rgba(214,160,145,0.5)');
    },

    /**
     * 节点差异化历史图标：消费 data/star-themes.js 的归一化折线集，
     * 缩放描边进节点核心；无配置时回退五角星（保底不空）。
     */
    drawNodeIcon(ctx, node, p, color) {
      const icon = starThemes.getNodeIcon(node.id);
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = 3.4; // 图标半径（场景 px）：收于核心圆内
      if (!icon) {
        ctx.fillStyle = color;
        routeCanvas.drawStar(ctx, 0, 0, 5, 3, 1.3, 0);
        ctx.fill();
        ctx.restore();
        return;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.9;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 0; i < icon.length; i++) {
        const stroke = icon[i];
        ctx.beginPath();
        for (let j = 0; j < stroke.length; j++) {
          const x = stroke[j][0] * s;
          const y = stroke[j][1] * s;
          if (j === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    },

    /** 关键历史节点外环刻度（四方位短刻线；已点亮金色 / 当前红色） */
    drawKeyNodeTicks(ctx, node, p) {
      ctx.strokeStyle = node.status === 'completed' ? P.gold : P.nodeCurrent;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1.1;
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2 + Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(p.x + Math.cos(a) * 10.6, p.y + Math.sin(a) * 10.6);
        ctx.lineTo(p.x + Math.cos(a) * 12.6, p.y + Math.sin(a) * 12.6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },

    /** 节点名称标签（宽度缓存，按状态着色；字号随缩放反向调整，保持屏幕恒定字号防重叠） */
    drawNodeLabel(ctx, node, p) {
      const text = node.name || '';
      if (!text) return;
      const inv = 1 / this.view.scale;
      ctx.font = 10 * inv + 'px sans-serif';
      if (this._labelW[node.id] == null) {
        ctx.font = '10px sans-serif';
        this._labelW[node.id] = ctx.measureText(text).width;
        ctx.font = 10 * inv + 'px sans-serif';
      }
      const w = this._labelW[node.id] * inv;
      ctx.fillStyle =
        node.status === 'completed' ? P.labelDone : node.status === 'current' ? P.labelCurrent : P.labelLocked;
      ctx.fillText(text, p.x - w / 2, p.y + 20 * inv);
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
        // 阶段一（0~0.25）：蓄能——核心收缩聚光
        if (k < 0.25 && this.glowGold) {
          const c = 1 - k / 0.25;
          const s = 26 * c + 8;
          ctx.globalAlpha = 0.5 + 0.4 * (1 - c);
          ctx.drawImage(this.glowGold, p.x - s / 2, p.y - s / 2, s, s);
          ctx.globalAlpha = 1;
        }
        // 阶段二（0.15 起）：光环扩散 + 外环增强
        const k2 = Math.max(0, (k - 0.15) / 0.85);
        if (k2 > 0) {
          const rr = 10 + k2 * 34;
          ctx.strokeStyle = P.gold;
          ctx.globalAlpha = Math.max(0, 0.8 * (1 - k2));
          ctx.lineWidth = 2 * (1 - k2) + 0.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        // 阶段三：粒子扩散（降级时跳过，纯氛围无信息量）
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
        // 阶段四（0.3 起）：节点名称显现（金色，淡入）
        if (k > 0.3) {
          const node = (this.route && this.route.nodes || [])[i];
          if (node) {
            const ka = Math.min(1, (k - 0.3) / 0.25);
            ctx.font = 'bold 11px sans-serif';
            const w = ctx.measureText(node.name).width;
            ctx.globalAlpha = ka * Math.max(0, 1 - Math.max(0, k - 0.8) / 0.2);
            ctx.fillStyle = P.gold;
            ctx.fillText(node.name, p.x - w / 2, p.y - 18);
            ctx.globalAlpha = 1;
          }
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

    /* ---------------- 延安终点页内仪式（需求：全部点亮后页内轻仪式，落幕跳 ceremony 页） ---------------- */

    /**
     * 播放延安终点仪式。返回仪式总时长 ms（页面层据此延迟跳转 ceremony 页）；
     * 已在播或数据未就绪时返回 0（不重复触发）。动画失败不影响任何业务状态。
     */
    playFinale() {
      if (this.finale || !this.nodePts || !this.nodePts.length) return 0;
      const lastPt = this.nodePts[this.nodePts.length - 1];
      this.finale = {
        start: Date.now(),
        x: lastPt.x,
        y: lastPt.y,
        vs: this.view.scale,
        vox: this.view.ox,
        voy: this.view.oy
      };
      // 金粒子：从场景各处向终点汇聚（构建期一次性分配）
      this.finaleParticles = [];
      for (let i = 0; i < FINALE_PARTICLES; i++) {
        this.finaleParticles.push({
          x: Math.random() * this.cw,
          y: Math.random() * this.ch * 0.8,
          delay: 1000 + Math.random() * 500,
          dur: 1100 + Math.random() * 400
        });
      }
      return FINALE_MS;
    },

    /**
     * 终点仪式帧绘制（时间线）：0~1s 焦点转向终点（内核临时接管 view）
     * → 0.2~1.4s 全程路线金色逐段重亮 → 1~2.6s 金粒子汇聚 → 2.2s 起终点光环双圈展开。
     */
    drawFinale(t) {
      if (!this.finale) return;
      const ctx = this.ctx;
      const f = this.finale;
      const el = Date.now() - f.start;
      if (el >= FINALE_MS + 500) {
        this.finale = null;
        this.finaleParticles = null;
        return;
      }

      // 焦点转向延安（view 动画只影响后续帧；播完 view 停在终点附近，用户可自由拖动）
      if (el <= 1000) {
        const k = routeCanvas.easeOutCubic(el / 1000);
        const ts = 1.6;
        this.view.scale = f.vs + (ts - f.vs) * k;
        this.view.ox = f.vox + (this.cw / 2 - f.x * ts - f.vox) * k;
        this.view.oy = f.voy + (this.ch / 2 - f.y * ts - f.voy) * k;
        this.clampView();
      }

      // 全程金色逐段重亮
      const relight = Math.min(1, Math.max(0, (el - 200) / 1200));
      if (relight > 0 && this.path && this.path.length > 1) {
        const idx = Math.max(1, Math.floor(relight * (this.path.length - 1)));
        ctx.save();
        ctx.strokeStyle = P.gold;
        ctx.lineWidth = 4.5;
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.75 * (1 - relight * 0.4);
        routeCanvas.tracePath(ctx, this.path, idx);
        ctx.stroke();
        ctx.restore();
      }

      // 金粒子向终点汇聚（平方加速）
      ctx.fillStyle = P.gold;
      (this.finaleParticles || []).forEach((pt) => {
        const k = (el - pt.delay) / pt.dur;
        if (k <= 0) return;
        const kk = Math.min(1, k);
        const e = kk * kk;
        ctx.globalAlpha = 0.9 * (1 - kk * 0.55);
        ctx.beginPath();
        ctx.arc(pt.x + (f.x - pt.x) * e, pt.y + (f.y - pt.y) * e, 1.6, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;

      // 终点光环双圈展开
      if (el > 2200) {
        const k = (el - 2200) / 1400;
        for (let ring = 0; ring < 2; ring++) {
          const rk = Math.min(1, Math.max(0, k - ring * 0.25));
          if (rk <= 0) continue;
          ctx.strokeStyle = P.gold;
          ctx.globalAlpha = Math.max(0, 0.85 * (1 - rk));
          ctx.lineWidth = 2.5 * (1 - rk) + 0.5;
          ctx.beginPath();
          ctx.arc(f.x, f.y, 12 + rk * 60, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    },

    /* ---------------- 视口固定 UI（克制呈现） ---------------- */

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

    /** 跳过上屏进入动画（详情面板关闭后恢复画布时调用，避免路线重描一遍） */
    dismissIntro() {
      this.introStart = 0;
    },

    /**
     * 平滑聚焦到指定节点（详情面板打开前调用）：view 补间把节点移到屏幕
     * 水平居中、纵向 38% 处（下半屏留给玻璃面板），缩放至少提到 1.8 倍。
     * 补间由 draw 帧内消费（纯时间推导），返回动画时长 ms。
     */
    focusNode(id) {
      const idx = this.nodeIndex && this.nodeIndex[id];
      const pt = idx != null && this.nodePts ? this.nodePts[idx] : null;
      if (!pt) return 0;
      const ts = Math.min(2.5, Math.max(this.view.scale, 1.8));
      this._focus = {
        start: Date.now(),
        fs: this.view.scale, fox: this.view.ox, foy: this.view.oy,
        ts: ts, tox: this.cw / 2 - pt.x * ts, toy: this.ch * 0.38 - pt.y * ts
      };
      return FOCUS_MS;
    },

    /** 聚焦补间帧推进（draw 内调用；结束自动清除） */
    applyFocus() {
      const f = this._focus;
      if (!f) return;
      const k = Math.min(1, (Date.now() - f.start) / FOCUS_MS);
      const e = routeCanvas.easeOutCubic(k);
      this.view.scale = f.fs + (f.ts - f.fs) * e;
      this.view.ox = f.fox + (f.tox - f.fox) * e;
      this.view.oy = f.foy + (f.toy - f.foy) * e;
      this.clampView();
      if (k >= 1) this._focus = null;
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
