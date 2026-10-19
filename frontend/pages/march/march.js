/**
 * 长征路线页（地图版）
 * 双模式：实景地图（原生 <map>）/ 星空长征（Canvas 2D，需求 §13 独立体验模式）。
 *
 * 星空长征的绘制状态与绘制逻辑全部收在 utils/hudMap.js 渲染内核（this.hud）；本页只负责
 * 模式切换、数据拉取、rAF 循环、手势事件转发（pan/pinch 数学）与命中后跳转。
 * 星空全景（§13.4）：单指拖动平移、双指捏合缩放、双击复位。
 * 任意节点（含未解锁）均可点击查看历史详情。
 */
const app = getApp();
const march = require('../../services/march');
const sport = require('../../services/sport');
const arrivePopup = require('../../utils/arrivePopup');
const hudMap = require('../../utils/hudMap');
const nodeThemes = require('../../data/node-themes');

/** 列表/信息卡视图节点：仅保留模板用到的字段，减小 setData 体积 */
function toViewNode(node) {
  return {
    id: node.id,
    name: node.name,
    icon: node.icon,
    status: node.status,
    targetSteps: node.targetSteps,
    remain: node.remain
  };
}

Page({
  data: {
    nodes: [],
    currentSteps: 0,
    totalSteps: 0,
    litCount: 0,
    totalCount: 0,
    finished: false,
    // 地图模式：real = 实景地图（<map> 组件），canvas = 星空长征
    mode: 'real',
    mapLat: 34.5,
    mapLng: 108.5,
    mapScale: 4,
    includePoints: [],
    markers: [],
    polylines: [],
    // 实景地图当前选中的节点（点 marker 后在底部信息卡展示）
    selectedNode: null,
    // 选中节点区域氛围（§12：信息卡柔和主题色 + 环境描述）
    selectedThemeStyle: '',
    selectedThemeEnv: '',
    // 当前章节卡（章节系统后端统一下发）
    currentChapter: null,
    // 开场动画（需求 §5）：showIntro 首次完整开场 / showVeil 非首次快速过渡纱幕
    showIntro: false,
    showVeil: false,
    // 抵达事件卡弹层（light-up 返回新点亮节点/新完成章节后按队列播放）
    litPopup: null,
    // 就地同步行军步数（B6）：syncing 锁防止重复触发
    syncing: false
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    this.maybePlayIntro();
    // onHide 停掉了星空动画：先用已有路线恢复，刷新失败时画面也不冻结
    if (this.hud && this.routeData) this.startAnim();
    this.refresh();
  },

  /**
   * 开场动画（需求 §5）：首次进入长征 Tab 完整播放（1934/瑞金 → 长征开始，
   * 纯 CSS 轻量动画、可点击跳过、播放标记写入 Storage 缓存）；非首次仅
   * 300~800ms 快速过渡纱幕（不拦截操作）。地图加载与 refresh 并发进行不阻塞。
   */
  maybePlayIntro() {
    if (this._introChecked) {
      // 开场播放中切走 tab（onHide 已取消定时器）：回来后重新计时自动结束
      if (this.data.showIntro && !this._introTimer) {
        this._introTimer = setTimeout(() => this.dismissIntro(), 3350);
      }
      return;
    }
    this._introChecked = true;
    if (march.hasPlayedIntro()) {
      this.setData({ showVeil: true });
      this._veilTimer = setTimeout(() => this.setData({ showVeil: false }), 560);
      return;
    }
    this.setData({ showIntro: true });
    this._introTimer = setTimeout(() => this.dismissIntro(), 3350);
  },

  /** 点击跳过开场动画 */
  skipIntro() {
    this.dismissIntro();
  },

  /** 结束开场动画：写缓存标记，补播被压后的地图入场镜头与抵达事件队列 */
  dismissIntro() {
    if (!this.data.showIntro) return;
    if (this._introTimer) { clearTimeout(this._introTimer); this._introTimer = null; }
    this.setData({ showIntro: false });
    march.markIntroPlayed();
    if (!this._viewPlayed && this.data.mode === 'real' && this.routeData) {
      this._viewPlayed = true;
      this.playViewAnim();
    }
    this.playArriveIfNeeded();
    // 开场期间顺延的完成仪式（§20）
    if (this._ceremonyRoute) {
      const pendingRoute = this._ceremonyRoute;
      this._ceremonyRoute = null;
      this.maybeStartCeremony(pendingRoute);
    }
  },

  onHide() {
    this._refreshRequestId = (this._refreshRequestId || 0) + 1;
    if (this._viewTimer) clearTimeout(this._viewTimer);
    if (this.popupTimer) clearTimeout(this.popupTimer);
    if (this._introTimer) { clearTimeout(this._introTimer); this._introTimer = null; }
    if (this._ceremonyTimer) { clearTimeout(this._ceremonyTimer); this._ceremonyTimer = null; }
    this.stopAnim();
  },

  onUnload() {
    this._refreshRequestId = (this._refreshRequestId || 0) + 1;
    if (this._viewTimer) clearTimeout(this._viewTimer);
    if (this.popupTimer) clearTimeout(this.popupTimer);
    if (this._introTimer) clearTimeout(this._introTimer);
    if (this._veilTimer) clearTimeout(this._veilTimer);
    if (this._ceremonyTimer) { clearTimeout(this._ceremonyTimer); this._ceremonyTimer = null; }
    this.stopAnim();
  },

  /* ---------------- 数据 ---------------- */

  refresh() {
    const requestId = (this._refreshRequestId || 0) + 1;
    this._refreshRequestId = requestId;

    // 先尝试点亮达标节点（幂等，仅返回本次新点亮与新完成章节），再拉取路线；
    // 有新点亮时播放到达动画序列（轨迹推进 → 节点发光扩散 → 抵达事件卡 → 章节仪式）。
    return march
      .lightUpNodes()
      .catch(() => ({ newlyLit: [], newlyCompletedChapters: [] }))
      .then((res) => {
        if (this._refreshRequestId !== requestId) return null;
        this._pendingLit = res.newlyLit;
        this._pendingChapters = res.newlyCompletedChapters;
        // 有新点亮/新完成章节：影响首页路线与进度，置脏让首页强制刷新
        if ((res.newlyLit && res.newlyLit.length) || (res.newlyCompletedChapters && res.newlyCompletedChapters.length)) {
          app.globalData.homeDirty = true;
        }
        return march.getRoute();
      })
      .then((route) => {
        if (!route || this._refreshRequestId !== requestId) return;
        // last-good 缓存兜底：网络失败回读缓存时提示可能非最新
        if (route._fromCache) wx.showToast({ title: '网络异常，当前为最近缓存数据', icon: 'none' });
        this.renderRoute(route);
        this.playArriveIfNeeded();
        this.maybeStartCeremony(route);
      })
      .catch(() => {
        // 网络失败时保留上一次渲染的路线
      });
  },

  /** 下拉刷新：重新点亮并拉取路线 */
  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  /**
   * 就地同步行军步数（B6）：复用首页 handleSyncSteps 模式。
   * sport.syncToday 内部已处理微信运动授权（拒绝时走 authGuide 引导前往设置页）；
   * 成功后调 refresh()（内部 lightUpNodes + 抵达事件队列 + 路线重绘）。
   */
  handleSyncSteps() {
    if (this.data.syncing) return;
    this.setData({ syncing: true });
    sport
      .syncToday()
      .then((result) => {
        // 同步步数影响首页今日行军卡：置脏标记，返回首页时强制刷新（绕过 30s 节流）
        app.globalData.homeDirty = true;
        if (result && result.synced) {
          wx.showToast({ title: result.historyDetailsAvailable ? '近7天步数已同步' : '步数已同步', icon: 'success' });
        } else if (result && result.failedDates && result.failedDates.length > 0) {
          wx.showToast({ title: '部分日期同步失败，请稍后重试', icon: 'none' });
        } else {
          wx.showToast({ title: '步数已是最新', icon: 'none' });
        }
        this.refresh();
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.message) || '暂时无法获取微信运动数据，请稍后重试', icon: 'none' });
      })
      .finally(() => {
        this.setData({ syncing: false });
      });
  },

  /**
   * 长征完成仪式（需求 §20）：路线全部点亮且后端下发 ceremonyPending 时跳转仪式页
   * 播放完整动画（§20.4 仅第一次）。开场动画期间顺延；抵达事件卡队列播完再跳转；
   * 页面生命周期内只自动触发一次（用户中途返回不循环跳转）。
   */
  maybeStartCeremony(route) {
    if (!route || !route.ceremonyPending) return;
    if (this.data.showIntro) {
      this._ceremonyRoute = route;
      return;
    }
    // 已跳转过（本页生命周期内）或已有待触发的定时器时不重复安排；
    // 定时器被 onHide 取消（切 tab）时允许下次 onShow 重新安排
    if (this._ceremonyStarted || this._ceremonyTimer) return;
    const delay = this._popupMs || 0;
    this._popupMs = 0;
    this._ceremonyTimer = setTimeout(() => {
      this._ceremonyTimer = null;
      this._ceremonyStarted = true;
      wx.navigateTo({ url: '/pages/ceremony/ceremony' });
    }, delay);
  },

  /**
   * 完成横幅入口：已完成路线的用户可随时进仪式页查看「已完成长征」与完成数据（§20.4）
   */
  goCeremony() {
    if (!this.data.finished) return;
    wx.navigateTo({ url: '/pages/ceremony/ceremony' });
  },

  /**
   * 有新点亮节点或新完成章节时播放到达动画序列：
   * 星空长征模式下节点发光扩散（轨迹推进由路线入场/增量描画承担），
   * 随后按队列逐个弹「抵达事件卡 → 章节完成仪式卡」（需求 §4.5）。
   * 已点亮节点点击仅查看详情，不触发动画（动画只由 light-up 响应驱动）。
   */
  playArriveIfNeeded() {
    // 开场动画播放期间暂缓，待动画结束后由 dismissIntro 补播
    if (this.data.showIntro) return;
    const lit = this._pendingLit || [];
    const chapters = this._pendingChapters || [];
    this._pendingLit = null;
    this._pendingChapters = null;
    if (lit.length === 0 && chapters.length === 0) return;

    if (lit.length > 0 && this.hud) this.hud.playArrive(lit.map((n) => n.id));
    // 事件卡队列总时长：完成仪式跳转延迟到队列播完（§20.2：最后节点点亮后再进入仪式）
    this._popupMs = arrivePopup.playArriveQueue(this, lit, chapters);
  },

  /**
   * 用当前配置绘制路线；网络刷新与本地缓存共用同一渲染入口。
   * 轨迹推进规则（需求 §3.5）由渲染内核 setRoute 内部判定：仅首次渲染播放入场/镜头动画，
   * 步数刷新只从旧进度动画推进到新进度，不重播完整地图动画。
   */
  renderRoute(route) {
    this.routeData = route;

    // 章节视图（需求 §4.4）：progressPct 预计算供 WXML 进度条；全部完成时展示末章
    const chapters = route.chapters || [];
    const chapter =
      chapters.find((c) => c.id === route.currentChapterId) ||
      (route.finished && chapters.length ? chapters[chapters.length - 1] : null);
    const patch = {
      nodes: route.nodes.map(toViewNode),
      currentSteps: route.currentSteps,
      totalSteps: route.totalSteps,
      litCount: route.litCount,
      totalCount: route.totalCount,
      finished: route.finished,
      currentChapter: chapter
        ? Object.assign({}, chapter, { progressPct: Math.round((chapter.progress || 0) * 100) })
        : null
    };

    if (this.data.mode === 'real') {
      const mapData = this.buildMapData(route);
      const selectedNode =
        route.nodes.find((node) => node.status === 'current') ||
        route.nodes.find((node) => node.status !== 'completed') ||
        route.nodes[0] ||
        null;
      const selectedTheme = selectedNode ? nodeThemes.getNodeTheme(selectedNode.id) : null;
      Object.assign(patch, {
        markers: mapData.markers,
        polylines: mapData.polylines,
        selectedNode: selectedNode ? toViewNode(selectedNode) : null,
        selectedThemeStyle: selectedTheme ? nodeThemes.themeSoftStyle(selectedTheme) : '',
        selectedThemeEnv: selectedTheme ? selectedTheme.environment : ''
      });
      this.setData(patch);
      // 镜头俯冲只在首次进入播放（开场动画期间延至其结束），后续刷新保持当前视野
      if (!this._viewPlayed && !this.data.showIntro) {
        this._viewPlayed = true;
        this.playViewAnim();
      }
      return;
    }

    this.setData(patch);
    if (this.hud) {
      this.hud.setRoute(route);
      this.startAnim();
    }
  },

  /* ---------------- 实景地图 ---------------- */

  /**
   * 切换实景地图 / 星空长征
   */
  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;

    this.stopAnim();
    this.setData({ mode }, () => {
      if (mode === 'canvas') {
        this.initCanvas();
        return;
      }
      // <canvas> 已被 wx:else 移除：释放渲染内核（画布上下文、离屏静态层与光晕精灵），
      // 回到实景时用最新路线重建 markers
      if (this.hud) {
        this.hud.dispose();
        this.hud = null;
      }
      this.canvas = null;
      if (this.routeData) this.renderRoute(this.routeData);
      this.playViewAnim();
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
    const theme = nodeThemes.getNodeTheme(node.id);
    this.setData({
      selectedNode: toViewNode(node),
      selectedThemeStyle: nodeThemes.themeSoftStyle(theme),
      selectedThemeEnv: theme.environment
    });
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
        this.hud = hudMap.createHudMap({ ctx: ctx, cw: width, ch: height, dpr: dpr });
        if (this.routeData) this.hud.setRoute(this.routeData);
        this.startAnim();
      });
  },

  /* ---------------- 动画循环 ---------------- */

  /** rAF 循环：每帧调渲染内核 draw(t)；绘制状态与绘制逻辑全在 utils/hudMap.js */
  startAnim() {
    this.stopAnim();
    this.running = true;
    const loop = () => {
      if (!this.running || !this.hud) return;
      this.hud.draw(Date.now() / 1000);
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

  /* ---------------- 交互（§13.4 星空全景：拖动/缩放/双击复位/点击命中） ----------------
   * pan/pinch 手势数学属于事件层，留在本页；观景变换 view 由渲染内核持有，
   * 改写后必须调 hud.clampView() 钳制（缩放 1~2.5 倍、平移不使场景离开画布）。
   */

  onMapTouchStart(e) {
    const hud = this.hud;
    if (!hud) return;
    const ts = e.touches || [];
    if (ts.length === 1) {
      this._gesture = {
        mode: 'pan', startX: ts[0].x, startY: ts[0].y,
        ox: hud.view.ox, oy: hud.view.oy,
        moved: false, t0: Date.now()
      };
    } else if (ts.length >= 2) {
      this._gesture = {
        mode: 'pinch',
        dist0: Math.hypot(ts[0].x - ts[1].x, ts[0].y - ts[1].y),
        scale0: hud.view.scale,
        cx: (ts[0].x + ts[1].x) / 2, cy: (ts[0].y + ts[1].y) / 2,
        moved: true
      };
    }
  },

  onMapTouchMove(e) {
    const g = this._gesture;
    const hud = this.hud;
    if (!g || !hud) return;
    const v = hud.view;
    const ts = e.touches || [];
    if (g.mode === 'pan' && ts.length === 1) {
      const dx = ts[0].x - g.startX;
      const dy = ts[0].y - g.startY;
      if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
      if (g.moved) {
        v.ox = g.ox + dx;
        v.oy = g.oy + dy;
        hud.clampView();
      }
    } else if (ts.length >= 2) {
      const d = Math.hypot(ts[0].x - ts[1].x, ts[0].y - ts[1].y);
      if (g.mode !== 'pinch') {
        // 单指转双指：重新锚定捏合基准，避免缩放跳变
        this._gesture = {
          mode: 'pinch', dist0: d, scale0: v.scale,
          cx: (ts[0].x + ts[1].x) / 2, cy: (ts[0].y + ts[1].y) / 2,
          moved: true
        };
        return;
      }
      const ns = Math.min(2.5, Math.max(1, g.scale0 * d / (g.dist0 || 1)));
      // 以双指中心为锚点缩放：保持锚点处场景坐标不动
      const sx = (g.cx - v.ox) / v.scale;
      const sy = (g.cy - v.oy) / v.scale;
      v.scale = ns;
      v.ox = g.cx - sx * ns;
      v.oy = g.cy - sy * ns;
      g.moved = true;
      hud.clampView();
    }
  },

  onMapTouchEnd(e) {
    const g = this._gesture;
    this._gesture = null;
    if (!g) return;
    // 干净单指轻点（未移动、短促）→ 双击复位 / 单击命中节点
    if (g.mode === 'pan' && !g.moved && Date.now() - g.t0 < 350) {
      const ts = (e.changedTouches && e.changedTouches[0]) || null;
      if (!ts) return;
      const now = Date.now();
      if (now - (this._lastTap || 0) < 300) {
        this._lastTap = 0;
        if (this.hud) this.hud.resetView();
        return;
      }
      this._lastTap = now;
      this.hitNode(ts.x, ts.y);
    }
  },

  /**
   * 节点命中 → 进详情（命中判定与屏幕→场景逆变换在渲染内核 hitTest；
   * 含未解锁节点，可查看历史）
   */
  hitNode(sx, sy) {
    if (!this.hud) return;
    const id = this.hud.hitTest(sx, sy);
    if (id) wx.navigateTo({ url: '/pages/node-detail/node-detail?id=' + id });
  },

  /**
   * 点击列表节点（含未解锁节点，可查看历史）
   */
  handleNodeTap(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/node-detail/node-detail?id=' + id });
  }
});
