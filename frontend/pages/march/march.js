/**
 * 长征路线页（地图版）
 * 双模式：实景地图（原生 <map>）/ 插画地图（Canvas 2D）。
 * 插画地图采用“星空远征”深空质感：
 *   渐变夜空 + 中心微光 + 经纬网格 + 程序化层叠山峦 + 金色装饰边框 + 罗盘
 *   闪烁星空（含十字光芒）/ 飘移薄雾
 *   发光长征路线（Catmull-Rom 平滑曲线 + 外发光 + 流光彗尾）
 *   节点三态（未解锁暗环 / 进行中红色信标脉冲 / 已点亮金色光晕呼吸）
 *   当前进度旗帜（沿路线插值定位 + 摆动 + 基座光晕）
 * 静态层离屏缓存、渐变与光晕精灵复用，保证 rAF 每帧低开销、点击不卡顿。
 * 任意节点（含未解锁）均可点击查看历史详情。
 */
const app = getApp();
const march = require('../../services/march');

// 云朵 / 薄雾（相对坐标 + 尺度 + 速度）
const CLOUDS = [
  { x: 0.12, y: 0.14, s: 1.0, v: 0.012 },
  { x: 0.52, y: 0.07, s: 0.7, v: 0.02 },
  { x: 0.88, y: 0.2, s: 0.85, v: 0.016 }
];

/**
 * 将任意路线经纬度归一化到 Canvas 安全绘制区域。
 */
function getCanvasNodePositions(nodes, width, height) {
  if (!nodes.length) return [];
  const latitudes = nodes.map((node) => node.latitude);
  const longitudes = nodes.map((node) => node.longitude);
  const minLat = Math.min.apply(null, latitudes);
  const maxLat = Math.max.apply(null, latitudes);
  const minLng = Math.min.apply(null, longitudes);
  const maxLng = Math.max.apply(null, longitudes);
  const latRange = maxLat - minLat;
  const lngRange = maxLng - minLng;

  return nodes.map((node) => ({
    x: lngRange ? width * (0.12 + ((node.longitude - minLng) / lngRange) * 0.76) : width * 0.5,
    y: latRange ? height * (0.12 + ((maxLat - node.latitude) / latRange) * 0.72) : height * 0.5
  }));
}

/** 缓动函数 easeOutCubic */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** 绘制五角星路径 */
function drawStar(ctx, cx, cy, spikes, outerR, innerR, rot) {
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = rot + (i * Math.PI) / spikes - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** 绘制圆角矩形路径 */
function drawRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

Page({
  data: {
    nodes: [],
    currentSteps: 0,
    totalSteps: 0,
    litCount: 0,
    totalCount: 0,
    finished: false,
    // 地图模式：real = 实景地图（<map> 组件），canvas = 插画地图
    mode: 'real',
    mapLat: 34.5,
    mapLng: 108.5,
    mapScale: 4,
    includePoints: [],
    markers: [],
    polylines: [],
    // 实景地图当前选中的节点（点 marker 后在底部信息卡展示）
    selectedNode: null,
    // 抵达事件卡弹层（light-up 返回新点亮节点后逐个播放）
    litPopup: null
  },

  onReady() {
    // 实景地图默认模式，插画地图切换到 canvas 时再初始化
    if (this.data.mode === 'canvas') {
      this.initCanvas();
    }
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    // 已登录但未选组织 -> 强制先完成组织选择
    if (!app.globalData.user.orgId) {
      wx.redirectTo({ url: '/pages/org-select/org-select?from=login' });
      return;
    }
    this.refresh();
  },

  onHide() {
    this._refreshRequestId = (this._refreshRequestId || 0) + 1;
    if (this._viewTimer) clearTimeout(this._viewTimer);
    if (this.popupTimer) clearTimeout(this.popupTimer);
    this.stopAnim();
  },

  onUnload() {
    this._refreshRequestId = (this._refreshRequestId || 0) + 1;
    if (this._viewTimer) clearTimeout(this._viewTimer);
    if (this.popupTimer) clearTimeout(this.popupTimer);
    this.stopAnim();
  },

  /* ---------------- 数据 ---------------- */

  refresh() {
    const requestId = (this._refreshRequestId || 0) + 1;
    this._refreshRequestId = requestId;

    // 先尝试点亮达标节点（幂等，仅返回本次新点亮），再拉取路线；
    // 有新点亮时播放到达动画序列（轨迹推进 → 节点发光扩散 → 抵达事件卡）。
    march
      .lightUpNodes()
      .catch(() => [])
      .then((newlyLit) => {
        if (this._refreshRequestId !== requestId) return null;
        this._pendingLit = newlyLit;
        return march.getRoute();
      })
      .then((route) => {
        if (!route || this._refreshRequestId !== requestId) return;
        this.renderRoute(route);
        this.playArriveIfNeeded();
      })
      .catch(() => {
        // 网络失败时保留上一次渲染的路线
      });
  },

  /**
   * 有新点亮节点时播放到达动画序列：
   * 插画地图模式下节点发光扩散（轨迹推进由路线入场描画承担），随后逐个弹「抵达事件卡」。
   * 已点亮节点点击仅查看详情，不触发动画（动画只由 light-up 响应驱动）。
   */
  playArriveIfNeeded() {
    const lit = this._pendingLit;
    this._pendingLit = null;
    if (!lit || lit.length === 0) return;

    if (this.data.mode === 'canvas') {
      this.arriveFx = { ids: lit.map((n) => n.id), start: Date.now() };
    }
    this.playArrivePopup(lit);
  },

  /**
   * 抵达事件卡（逐个播放）：恭喜抵达 + 历史时间 + 积分 + 下一站距离
   */
  playArrivePopup(nodes) {
    let i = 0;
    const showNext = () => {
      if (i >= nodes.length) {
        this.setData({ litPopup: null });
        return;
      }
      const n = nodes[i];
      this.setData({
        litPopup: {
          key: Date.now(),
          name: n.name,
          icon: n.icon || '★',
          historicalTime: n.historicalTime || '',
          gainedPoints: n.gainedPoints || 0,
          nextName: n.nextNode ? n.nextNode.name : '',
          nextRemain: n.nextNode ? n.nextNode.remain : 0
        }
      });
      i++;
      if (this.popupTimer) clearTimeout(this.popupTimer);
      this.popupTimer = setTimeout(showNext, 2400);
    };
    showNext();
  },

  /**
   * 用当前配置绘制路线；网络刷新与本地缓存共用同一渲染入口。
   * 轨迹推进规则（需求 §3.5）：仅首次渲染播放入场/镜头动画；
   * 步数刷新只从旧进度动画推进到新进度，不重播完整地图动画。
   */
  renderRoute(route) {
    const prevProgress =
      this.routeData && typeof this.routeData.routeProgress === 'number'
        ? this.routeData.routeProgress
        : null;
    this.routeData = route;

    if (this.data.mode === 'real') {
      const mapData = this.buildMapData(route);
      const selectedNode =
        route.nodes.find((node) => node.status === 'current') ||
        route.nodes.find((node) => node.status !== 'completed') ||
        route.nodes[0] ||
        null;
      this.setData({
        nodes: route.nodes,
        currentSteps: route.currentSteps,
        totalSteps: route.totalSteps,
        litCount: route.litCount,
        totalCount: route.totalCount,
        finished: route.finished,
        markers: mapData.markers,
        polylines: mapData.polylines,
        selectedNode: selectedNode
      });
      // 镜头俯冲只在首次进入播放，后续刷新保持当前视野
      if (!this._viewPlayed) {
        this._viewPlayed = true;
        this.playViewAnim();
      }
      return;
    }

    this.setData({
      nodes: route.nodes,
      currentSteps: route.currentSteps,
      totalSteps: route.totalSteps,
      litCount: route.litCount,
      totalCount: route.totalCount,
      finished: route.finished
    });
    if (this.ctx) {
      if (prevProgress === null || !this.path) {
        // 首次渲染：重建静态层并播放完整入场描画
        this.buildMap();
        this.buildStaticLayer();
        this.buildGlowSprites();
        this.animStart = Date.now();
      } else {
        // 步数刷新：仅播放新增部分的轨迹推进（约 800ms）
        this.progressAnim = { from: prevProgress, to: this.calcRouteProgress(route), start: Date.now() };
      }
      this.startAnim();
    }
  },

  /**
   * 全程行军进度（0~1）：优先取后端 routeProgress，旧接口降级为步数比例
   */
  calcRouteProgress(route) {
    if (typeof route.routeProgress === 'number') return Math.min(1, Math.max(0, route.routeProgress));
    return route.totalSteps > 0 ? Math.min(1, route.currentSteps / route.totalSteps) : 0;
  },

  /**
   * 当前生效的绘制进度：增量推进动画期间按 easeOutCubic 插值
   */
  currentRatio() {
    const base = this.calcRouteProgress(this.routeData);
    const anim = this.progressAnim;
    if (!anim) return base;
    const p = Math.min(1, (Date.now() - anim.start) / 800);
    if (p >= 1) {
      this.progressAnim = null;
      return base;
    }
    return anim.from + (base - anim.from) * easeOutCubic(p);
  },

  /* ---------------- 实景地图 ---------------- */

  /**
   * 切换实景地图 / 插画地图
   */
  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;

    this.stopAnim();
    this.setData({ mode }, () => {
      if (mode === 'canvas') {
        this.initCanvas();
      } else {
        this.playViewAnim();
      }
    });
  },

  /**
   * 构建 <map> 组件的 markers 与 polylines
   */
  buildMapData(route) {
    const targets = route.nodes.map((node) => node.targetSteps);
    const coords = route.nodes.map((node) => ({
      latitude: node.latitude,
      longitude: node.longitude
    }));
    const cur = Math.min(Math.max(route.currentSteps, 0), route.totalSteps);

    // 已完成路线坐标：逐节点累计，超出部分在当前目标段内线性插值
    const donePts = [];
    for (let i = 0; i < coords.length; i++) {
      if (cur >= targets[i]) {
        donePts.push(coords[i]);
      } else {
        if (i > 0) {
          const t0 = targets[i - 1];
          const t1 = targets[i];
          const r = t1 > t0 ? (cur - t0) / (t1 - t0) : 1;
          const p0 = coords[i - 1];
          const p1 = coords[i];
          donePts.push({
            latitude: p0.latitude + (p1.latitude - p0.latitude) * r,
            longitude: p0.longitude + (p1.longitude - p0.longitude) * r
          });
        }
        break;
      }
    }

    // 节点 marker（默认图标；名称改为点击气泡展示，替代常驻 label，避免密集点位名称错位/重叠）
    const labelStyle = {
      completed: { color: '#B8860B', bgColor: '#FBF3DC' },
      current: { color: '#C8102E', bgColor: '#FFF1F3' },
      unlocked: { color: '#999999', bgColor: '#F2F2F2' }
    };
    const markers = route.nodes.map((node) => {
      const style = labelStyle[node.status] || labelStyle.unlocked;
      return {
        id: node.id,
        latitude: node.latitude,
        longitude: node.longitude,
        width: 16,
        height: 16,
        callout: {
          content: (node.status === 'completed' ? '★ ' : node.status === 'current' ? '◎ ' : '○ ') + node.name,
          color: style.color,
          bgColor: style.bgColor,
          fontSize: 12,
          borderRadius: 8,
          padding: 6,
          display: 'BYCLICK'
        }
      };
    });

    // 当前进度旗帜 marker
    if (donePts.length > 0 && !route.finished) {
      const flag = donePts[donePts.length - 1];
      markers.push({
        id: 999,
        latitude: flag.latitude,
        longitude: flag.longitude,
        width: 20,
        height: 20,
        label: {
          content: '🚩 我在这里',
          color: '#FFFFFF',
          bgColor: '#C8102E',
          fontSize: 11,
          borderRadius: 10,
          padding: 5,
          anchorX: 0,
          anchorY: -26
        }
      });
    }

    // 路线：灰色全程 + 金色已完成段
    const polylines = [];
    if (coords.length > 1) {
      polylines.push({
        points: coords,
        color: '#B9B2A4CC',
        width: 5,
        dottedLine: false,
        arrowLine: false
      });
    }
    if (donePts.length > 1) {
      polylines.push({
        points: donePts,
        color: '#D4A017',
        width: 7,
        borderColor: '#8B6914',
        borderWidth: 1,
        arrowLine: true,
        dottedLine: false
      });
    }

    return { markers, polylines };
  },

  /**
   * 镜头推进动画：从全国视野俯冲到长征路线区域
   */
  playViewAnim() {
    if (this._viewTimer) clearTimeout(this._viewTimer);
    this.setData({
      includePoints: [],
      mapLat: 34.5,
      mapLng: 108.5,
      mapScale: 4
    });
    this._viewTimer = setTimeout(() => {
      const nodes = (this.routeData && this.routeData.nodes) || [];
      this.setData({
        includePoints: nodes.map((node) => ({ latitude: node.latitude, longitude: node.longitude }))
      });
    }, 700);
  },

  /**
   * 点击地图标记：不再直接跳转，而是选中该节点，在地图底部信息卡展示
   * （任意状态含未解锁均可选中查看）
   */
  handleMarkerTap(e) {
    const id = e.markerId || (e.detail && e.detail.markerId);
    if (!id || id === 999) return;
    const node = this.routeData.nodes.find((n) => n.id === id);
    if (!node) return;
    this.setData({ selectedNode: node });
  },

  /**
   * 点击 marker 气泡 -> 直接进入节点历史详情
   */
  handleCalloutTap(e) {
    const id = (e.detail && e.detail.markerId) || e.markerId;
    if (!id || id === 999) return;
    wx.navigateTo({ url: '/pages/node-detail/node-detail?id=' + id });
  },

  /**
   * 信息卡「查看详情」
   */
  goSelectedDetail() {
    const node = this.data.selectedNode;
    if (!node) return;
    wx.navigateTo({ url: '/pages/node-detail/node-detail?id=' + node.id });
  },

  /* ---------------- Canvas 初始化 ---------------- */

  initCanvas() {
    const query = wx.createSelectorQuery();
    query
      .select('#routeMap')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const { node, width, height } = res[0];
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;

        node.width = width * dpr;
        node.height = height * dpr;

        const ctx = node.getContext('2d');
        ctx.scale(dpr, dpr);

        this.canvas = node;
        this.ctx = ctx;
        this.cw = width;
        this.ch = height;
        this.dpr = dpr;

        this.buildMap();
        this.buildStaticLayer();
        this.buildGlowSprites();
        this.animStart = Date.now();
        this.startAnim();
      });
  },

  /**
   * 构建地图静态资源：路径采样、节点坐标、星空、山峦
   */
  buildMap() {
    const { cw, ch } = this;
    const nodes = (this.routeData && this.routeData.nodes) || [];
    this.nodePts = getCanvasNodePositions(nodes, cw, ch);

    // Catmull-Rom 平滑路径采样
    const segs = 30;
    const pts = this.nodePts;
    const n = pts.length;
    const path = [];
    if (n === 1) path.push(pts[0]);
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(n - 1, i + 2)];
      for (let j = 0; j <= segs; j++) {
        const t = j / segs;
        const t2 = t * t;
        const t3 = t2 * t;
        path.push({
          x:
            0.5 *
            (2 * p1.x +
              (-p0.x + p2.x) * t +
              (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
              (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y:
            0.5 *
            (2 * p1.y +
              (-p0.y + p2.y) * t +
              (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
              (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
        });
      }
    }
    this.path = path;

    // 累计距离
    const dist = [0];
    for (let i = 1; i < path.length; i++) {
      dist.push(dist[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
    }
    this.pathDist = dist;
    this.pathLen = dist[dist.length - 1];

    // 节点在 path 上的采样索引（i * (segs+1)）
    this.nodePathIndex = [];
    for (let i = 0; i < n; i++) this.nodePathIndex.push(i * (segs + 1));

    // 星空（大小星混合，部分大星带十字光芒；闪烁相位/频率各异）
    this.stars = [];
    for (let i = 0; i < 82; i++) {
      const big = Math.random() < 0.16;
      this.stars.push({
        x: Math.random() * cw,
        y: Math.random() * ch * 0.72,
        r: big ? 1.5 + Math.random() * 1.1 : 0.5 + Math.random() * 0.9,
        phase: Math.random() * Math.PI * 2,
        freq: 0.5 + Math.random() * 1.6,
        glint: big
      });
    }

    // 节点名标签宽度缓存（避免每帧 measureText）
    this._labelW = {};
  },

  /* ---------------- 动画循环 ---------------- */

  startAnim() {
    this.stopAnim();
    this.running = true;
    const loop = () => {
      if (!this.running || !this.ctx) return;
      this.draw(Date.now() / 1000);
      if (this.canvas && this.canvas.requestAnimationFrame) {
        this.animId = this.canvas.requestAnimationFrame(loop);
      } else {
        this.animId = setTimeout(loop, 16);
      }
    };
    loop();
  },

  stopAnim() {
    this.running = false;
    if (this.animId !== undefined && this.canvas && this.canvas.cancelAnimationFrame) {
      this.canvas.cancelAnimationFrame(this.animId);
    }
    if (this.animId !== undefined) clearTimeout(this.animId);
    this.animId = undefined;
  },

  /* ---------------- 绘制 ---------------- */

  draw(t) {
    const ctx = this.ctx;
    const { cw, ch } = this;
    const route = this.routeData;
    if (!route) return;

    // 静态 scenery（底色/山峦/河流）已缓存到离屏层：每帧仅贴图，
    // 避免重复创建渐变与重建路径，大幅降低主线程开销，保证点击交互不卡顿。
    if (this.staticLayer) {
      ctx.drawImage(this.staticLayer, 0, 0, cw, ch);
    } else {
      ctx.clearRect(0, 0, cw, ch);
      this.paintScenery(ctx);
    }
    this.drawClouds(t);
    this.drawStars(t);
    this.drawRoute(t);
    this.drawNodes(t);
    this.drawArriveFx();
    this.drawProgressFlag(t);
  },

  /**
   * 到达动画：新点亮节点发光扩散（两层扩散金环 + 渐隐光晕，约 2.2s）
   */
  drawArriveFx() {
    const fx = this.arriveFx;
    if (!fx || !this.routeData || !this.nodePts) return;
    const elapsed = (Date.now() - fx.start) / 2200;
    if (elapsed >= 1) {
      this.arriveFx = null;
      return;
    }
    const ctx = this.ctx;
    const glow = easeOutCubic(Math.min(1, elapsed * 1.15));

    fx.ids.forEach((id) => {
      let idx = -1;
      for (let i = 0; i < this.routeData.nodes.length; i++) {
        if (this.routeData.nodes[i].id === id) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return;
      const p = this.nodePts[idx];

      // 中心光晕放大渐隐（图标激活）
      if (this.glowGold) {
        const s = 40 + glow * 64;
        ctx.globalAlpha = (1 - elapsed) * 0.9;
        ctx.drawImage(this.glowGold, p.x - s / 2, p.y - s / 2, s, s);
      }
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
  },

  /**
   * 构建静态背景离屏层（底色渐变 + 两层山峦 + 河流）
   * 这些元素不随帧变化，缓存后每帧直接 drawImage；若离屏画布不可用则降级为每帧直绘。
   */
  buildStaticLayer() {
    // 画布重建（如切换模式）时路径可能变化，重置渐变缓存
    this._goldGrad = null;
    this._goldGradIdx = -1;
    this._flagGrad = null;
    try {
      const dpr = this.dpr || 2;
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
   * 构建光晕精灵（金/红）：将径向光晕预渲染到离屏小画布，
   * 绘制节点/粒子/旗座时直接 drawImage 缩放复用，避免每帧创建径向渐变，兼顾观感与性能。
   */
  buildGlowSprites() {
    const make = (rgb) => {
      try {
        const size = 64;
        const off = wx.createOffscreenCanvas({ type: '2d', width: size, height: size });
        const c = off.getContext('2d');
        const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        g.addColorStop(0, 'rgba(' + rgb + ',0.85)');
        g.addColorStop(0.4, 'rgba(' + rgb + ',0.32)');
        g.addColorStop(1, 'rgba(' + rgb + ',0)');
        c.fillStyle = g;
        c.fillRect(0, 0, size, size);
        return off;
      } catch (e) {
        return null;
      }
    };
    this.glowGold = make('255,205,90');
    this.glowRed = make('255,80,105');
  },

  /**
   * 静态 scenery（离屏缓存）：渐变夜空 + 中心微光 + 经纬网格 + 层叠山峦
   *   + 金色装饰边框 + 罗盘 + 虚线路线底。深空黄昏质感，营造“远征地图”观感。
   */
  paintScenery(ctx) {
    const { cw, ch } = this;

    // 1. 夜空底色（线性渐变）
    const sky = ctx.createLinearGradient(0, 0, 0, ch);
    sky.addColorStop(0, '#0A1524');
    sky.addColorStop(0.42, '#14293F');
    sky.addColorStop(0.72, '#1C3A52');
    sky.addColorStop(1, '#274B60');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, cw, ch);

    // 2. 中心微光（径向，营造纵深）
    const halo = ctx.createRadialGradient(cw * 0.5, ch * 0.34, 8, cw * 0.5, ch * 0.34, Math.max(cw, ch) * 0.72);
    halo.addColorStop(0, 'rgba(96,150,200,0.20)');
    halo.addColorStop(1, 'rgba(96,150,200,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, cw, ch);

    // 3. 经纬网格（地图质感）
    ctx.save();
    ctx.strokeStyle = 'rgba(150,195,235,0.05)';
    ctx.lineWidth = 1;
    const grid = 42;
    for (let x = grid; x < cw; x += grid) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch); ctx.stroke();
    }
    for (let y = grid; y < ch; y += grid) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw, y); ctx.stroke();
    }
    ctx.restore();

    // 4. 层叠山峦（程序化，带渐变与山脊高光）
    this.drawRidges(ctx);

    // 5. 金色装饰边框 + 罗盘
    this.drawFrame(ctx);
    this.drawCompass(ctx, cw - 46, 48, 20);

    // 6. 虚线路线底（未完成部分的引导线，静态缓存）
    const path = this.path;
    if (path && path.length) {
      ctx.save();
      ctx.setLineDash([7, 7]);
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
      ctx.strokeStyle = 'rgba(165,195,225,0.30)';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    }
  },

  /** 层叠山峦：3 层由远及近，纵向渐变填充 + 山脊高光线 */
  drawRidges(ctx) {
    const { cw, ch } = this;
    const layers = [
      { base: 0.56, amp: 0.05, k1: 2.0, k2: 5.3, top: '#3C628C', bot: '#22384F', a: 0.5, crest: 'rgba(150,195,235,0.18)' },
      { base: 0.71, amp: 0.07, k1: 2.8, k2: 6.6, top: '#2C4C74', bot: '#16283D', a: 0.75, crest: 'rgba(150,195,235,0.14)' },
      { base: 0.88, amp: 0.09, k1: 3.5, k2: 8.1, top: '#1B3050', bot: '#0C1725', a: 1, crest: 'rgba(150,195,235,0.10)' }
    ];
    const ridgeY = (L, x) => {
      const nx = x / cw;
      return L.base * ch - L.amp * ch *
        (Math.sin(nx * Math.PI * L.k1 + L.k2) * 0.6 + Math.sin(nx * Math.PI * L.k2 * 1.7) * 0.4);
    };
    layers.forEach((L) => {
      const grad = ctx.createLinearGradient(0, (L.base - L.amp) * ch, 0, ch);
      grad.addColorStop(0, L.top);
      grad.addColorStop(1, L.bot);
      ctx.globalAlpha = L.a;
      // 山脊高光线
      ctx.beginPath();
      ctx.moveTo(0, ridgeY(L, 0));
      for (let x = 6; x <= cw; x += 6) ctx.lineTo(x, ridgeY(L, x));
      ctx.strokeStyle = L.crest;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 山体填充
      ctx.beginPath();
      ctx.moveTo(0, ch);
      ctx.lineTo(0, ridgeY(L, 0));
      for (let x = 6; x <= cw; x += 6) ctx.lineTo(x, ridgeY(L, x));
      ctx.lineTo(cw, ch);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.globalAlpha = 1;
    });
  },

  /** 金色装饰边框（双线 + 四角描金） */
  drawFrame(ctx) {
    const { cw, ch } = this;
    const m = 12;
    ctx.save();
    ctx.strokeStyle = 'rgba(212,160,23,0.30)';
    ctx.lineWidth = 2;
    ctx.strokeRect(m, m, cw - m * 2, ch - m * 2);
    ctx.strokeStyle = 'rgba(212,160,23,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(m + 5, m + 5, cw - (m + 5) * 2, ch - (m + 5) * 2);
    ctx.strokeStyle = 'rgba(232,199,106,0.65)';
    ctx.lineWidth = 2;
    const c = 16;
    const corners = [[m, m, 1, 1], [cw - m, m, -1, 1], [m, ch - m, 1, -1], [cw - m, ch - m, -1, -1]];
    corners.forEach((q) => {
      ctx.beginPath();
      ctx.moveTo(q[0] + q[2] * c, q[1]);
      ctx.lineTo(q[0], q[1]);
      ctx.lineTo(q[0], q[1] + q[3] * c);
      ctx.stroke();
    });
    ctx.restore();
  },

  /** 罗盘玫瑰（右上角装饰） */
  drawCompass(ctx, cx, cy, r) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(232,199,106,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(232,199,106,0.22)';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2); ctx.stroke();
    const needle = (ang, color, len) => {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
      ctx.lineTo(Math.cos(ang + 0.42) * len * 0.3, Math.sin(ang + 0.42) * len * 0.3);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    needle(-Math.PI / 2, '#E8C76A', r * 0.92);
    needle(Math.PI / 2, 'rgba(190,210,235,0.55)', r * 0.92);
    needle(0, 'rgba(190,210,235,0.32)', r * 0.7);
    needle(Math.PI, 'rgba(190,210,235,0.32)', r * 0.7);
    ctx.fillStyle = '#FFE9A8';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -r - 4);
    ctx.restore();
  },

  /** 飘移薄雾（动态，每帧绘制）：柔光椭圆雾带，营造高山云雾氛围 */
  drawClouds(t) {
    const ctx = this.ctx;
    const { cw, ch } = this;
    CLOUDS.forEach((c) => {
      const cx = ((c.x + t * c.v) % 1.3 - 0.15) * cw;
      const cy = c.y * ch;
      const rx = 50 * c.s;
      const ry = 20 * c.s;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
      g.addColorStop(0, 'rgba(160,200,235,0.13)');
      g.addColorStop(0.6, 'rgba(160,200,235,0.06)');
      g.addColorStop(1, 'rgba(160,200,235,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  },

  /** 闪烁星空：大小星混合，大星带十字光芒 */
  drawStars(t) {
    const ctx = this.ctx;
    this.stars.forEach((s) => {
      const tw = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * s.freq + s.phase));
      ctx.globalAlpha = tw;
      ctx.fillStyle = '#EAF2FF';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
      if (s.glint) {
        ctx.globalAlpha = tw * 0.45;
        ctx.strokeStyle = '#CFE4FF';
        ctx.lineWidth = 0.8;
        const g = s.r * 3.4;
        ctx.beginPath();
        ctx.moveTo(s.x - g, s.y); ctx.lineTo(s.x + g, s.y);
        ctx.moveTo(s.x, s.y - g); ctx.lineTo(s.x, s.y + g);
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;
  },

  /** 路线：发光金色已完成段（外发光 + 内核亮线，渐变按 endIdx 缓存）+ 流光彗尾 */
  drawRoute(t) {
    const ctx = this.ctx;
    const route = this.routeData;
    const path = this.path;

    // 已完成段长度（按行军进度比例，含增量推进动画）+ 入场描画进度
    const progressRatio = this.currentRatio();
    const completedLen = this.pathLen * progressRatio;
    const intro = Math.min(1, (Date.now() - this.animStart) / 1400);
    const shownLen = completedLen * easeOutCubic(intro);
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
      // 外发光层（一次 shadowBlur 描边）
      ctx.save();
      ctx.shadowColor = 'rgba(255,196,74,0.85)';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i <= endIdx; i++) ctx.lineTo(path[i].x, path[i].y);
      ctx.strokeStyle = this._goldGrad;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
      // 内核亮线（提升“能量路径”质感）
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i <= endIdx; i++) ctx.lineTo(path[i].x, path[i].y);
      ctx.strokeStyle = 'rgba(255,250,230,0.9)';
      ctx.lineWidth = 1.8;
      ctx.stroke();
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
  },

  /** 节点三态徽章：已点亮金色光晕呼吸 / 进行中红色信标脉冲 / 未解锁暗环 */
  drawNodes(t) {
    const ctx = this.ctx;
    const route = this.routeData;
    const nodePts = this.nodePts;

    route.nodes.forEach((node, i) => {
      const p = nodePts[i];
      if (node.status === 'completed') {
        // 金色光晕呼吸（复用光晕精灵，缩放脉冲）
        const pulse = 0.5 + 0.5 * Math.sin(t * 2 + i);
        const s = 30 + pulse * 12;
        if (this.glowGold) ctx.drawImage(this.glowGold, p.x - s / 2, p.y - s / 2, s, s);
        // 金环
        ctx.strokeStyle = 'rgba(255,231,168,0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
        ctx.stroke();
        // 金盘 + 旋转白星
        ctx.fillStyle = '#E8B84B';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6.4, 0, Math.PI * 2);
        ctx.fill();
        drawStar(ctx, p.x, p.y, 5, 4.6, 2, t * 0.6);
        ctx.fillStyle = '#FFF7DC';
        ctx.fill();
      } else if (node.status === 'current') {
        // 扩散脉冲环
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
        // 红色信标（复用光晕精灵）
        if (this.glowRed) {
          const s = 36;
          ctx.drawImage(this.glowRed, p.x - s / 2, p.y - s / 2, s, s);
        }
        ctx.fillStyle = '#FF3D57';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        // 未解锁：暗色环 + 中心点
        ctx.strokeStyle = 'rgba(150,175,205,0.45)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(120,145,175,0.5)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      this.drawNodeLabel(ctx, node, p);
    });
  },

  /** 节点名标签：深色圆角底衬 + 状态色文字（暗背景下保证可读） */
  drawNodeLabel(ctx, node, p) {
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const labelX = Math.min(Math.max(p.x, 30), this.cw - 30);
    const labelY = p.y + 22;
    if (!this._labelW) this._labelW = {};
    const w = this._labelW[node.name] || (this._labelW[node.name] = ctx.measureText(node.name).width);
    // 底衬
    ctx.fillStyle = 'rgba(6,13,24,0.6)';
    drawRoundRect(ctx, labelX - w / 2 - 6, labelY - 10, w + 12, 15, 7.5);
    ctx.fill();
    // 文字
    if (node.status === 'completed') {
      ctx.fillStyle = '#FFE9A8';
    } else if (node.status === 'current') {
      ctx.fillStyle = '#FF9AA8';
    } else {
      ctx.fillStyle = '#93A6BC';
    }
    ctx.fillText(node.name, labelX, labelY);
  },

  /** 当前进度旗帜：呼吸光点 + 轻微粒子（需求 §3.3）+ 基座光晕 + 摆动旗面 */
  drawProgressFlag(t) {
    const ctx = this.ctx;
    const route = this.routeData;
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
    drawStar(ctx, 10, 0, 5, 3.4, 1.5, 0);
    ctx.fillStyle = '#FFE08A';
    ctx.fill();
    ctx.restore();
  },

  /* ---------------- 工具 ---------------- */

  /** 距离 -> 路径索引（二分） */
  dist2Index(len) {
    const dist = this.pathDist;
    let lo = 0;
    let hi = dist.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (dist[mid] <= len) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  },

  /* ---------------- 交互 ---------------- */

  /**
   * 点击地图：命中节点则进详情（含未解锁节点，可查看历史）
   */
  handleMapTap(e) {
    const { x, y } = e.detail;
    if (!this.nodePts) return;
    for (let i = 0; i < this.nodePts.length; i++) {
      const p = this.nodePts[i];
      if (Math.hypot(x - p.x, y - p.y) <= 22) {
        const node = this.routeData.nodes[i];
        wx.navigateTo({ url: '/pages/node-detail/node-detail?id=' + node.id });
        return;
      }
    }
  },

  /**
   * 点击列表节点（含未解锁节点，可查看历史）
   */
  handleNodeTap(e) {
    const node = e.currentTarget.dataset.node;
    wx.navigateTo({ url: '/pages/node-detail/node-detail?id=' + node.id });
  }
});
