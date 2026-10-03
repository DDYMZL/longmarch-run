/**
 * 长征完成仪式页（需求 §20）：完成第 10 个节点后的完整仪式动画。
 * 动画流程（§20.2）：最后一段路线推进 → 最后节点点亮发光 → 整条路线逐渐点亮
 *   → 10 节点全部亮起 → 星空展开 → 最终文字「我的长征 / 完成了」→ 完成数据（§20.3）。
 * 触发规则（§20.4）：仅第一次完成路线播放完整动画（route.ceremonyPending，由后端下发）；
 *   之后进入仅静态展示「已完成长征」+ 完成数据。观看后调 /march/ceremony 标记。
 * 绘制复用 utils/routeCanvas 的路线布局/采样/星形工具，帧内零分配（粒子/星点构建期固定）。
 */
const app = getApp();
const march = require('../../services/march');
const profile = require('../../services/profile');
const util = require('../../utils/util');
const routeCanvas = require('../../utils/routeCanvas');

// 仪式时间轴（秒）：各阶段起始时刻
const TL = {
  SEG_END: 1.2,      // 最后一段推进
  GLOW_END: 2.6,     // 最后节点点亮发光
  SWEEP_END: 5.0,    // 整条路线点亮
  PULSE_END: 5.8,    // 全节点齐亮脉冲
  STARS_END: 7.0,    // 星空展开
  TEXT2_AT: 7.5,     // 第二行文字
  STATS_AT: 8.1      // 完成数据卡
};

Page({
  data: {
    ready: false,
    pending: false,      // 是否首次仪式（false = 已完成回顾态，仅静态展示）
    phase: 'anim',       // anim | done
    showFinalText: false,
    showStats: false,
    stats: null,
    // 画布快照（动画收尾后把最终帧导出为静态图，DOM 数据卡浮于其上，
    // 规避 canvas 原生层在开发者工具中覆盖 DOM 的问题）
    sceneShot: '',
    coverCanvas: false
  },

  onLoad() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    Promise.all([march.getRoute(), profile.getSummary().catch(() => null)])
      .then(([route, summary]) => {
        if (!route || !route.finished) {
          wx.showToast({ title: '长征尚未完成', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 800);
          return;
        }
        this._route = route;
        const pending = !!route.ceremonyPending;
        this.setData({
          ready: true,
          pending,
          stats: this.buildStats(route, summary)
        });
        this.initScene();
      })
      .catch(() => {
        wx.showToast({ title: '加载失败', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
      });
  },

  /** 完成数据（§20.3）：累计行军 / 运动天数 / 答题 / 路线 / 勋章 / 累计积分 */
  buildStats(route, summary) {
    const s = (summary && summary.stats) || {};
    const quiz = (summary && summary.quiz) || {};
    const medals = (summary && summary.medals) || {};
    const points = (summary && summary.points) || {};
    return {
      totalStepsText: util.formatNumber(s.totalSteps != null ? s.totalSteps : route.currentSteps),
      sportDays: s.sportDays || 0,
      quizCount: quiz.totalCount || 0,
      litCount: route.litCount,
      totalCount: route.totalCount,
      medalOwned: medals.ownedCount || 0,
      medalTotal: medals.totalCount || 0,
      pointsText: util.formatNumber(points.total || 0)
    };
  },

  onHide() {
    this.stopScene();
  },

  onUnload() {
    this.stopScene();
  },

  /* ---------------- 场景 ---------------- */

  initScene() {
    const sys = wx.getSystemInfoSync();
    const cw = sys.windowWidth;
    const ch = sys.windowHeight;
    wx.createSelectorQuery()
      .select('#ceremonyCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const node = res[0].node;
        const dpr = sys.pixelRatio || 2;
        node.width = cw * dpr;
        node.height = ch * dpr;
        const ctx = node.getContext('2d');
        ctx.scale(dpr, dpr);
        this._canvas = node;
        this._ctx = ctx;
        this._cw = cw;
        this._ch = ch;
        this.buildScene();
        if (this.data.pending) {
          // 首次仪式：播放完整动画（§20.2）
          this._startAt = Date.now();
          this.startLoop();
        } else {
          // 回顾态（§20.4）：仅静态展示「已完成长征」+ 数据
          this._staticMode = true;
          this.setData({ phase: 'done', showFinalText: true, showStats: true });
          this.drawFrame(99);
          this.finalizeScene();
        }
      });
  },

  /** 构建期固定资源：路线布局/采样、星点、点亮粒子（帧内零分配） */
  buildScene() {
    const cw = this._cw;
    const ch = this._ch;
    const nodes = this._route.nodes;

    // 路线占据上部约 58% 区域（下方留给最终文字与数据卡）
    const areaH = ch * 0.58;
    this.nodePts = routeCanvas.getCanvasNodePositions(nodes, cw, areaH).map((p) => ({
      x: p.x,
      y: p.y + ch * 0.06
    }));
    const sampled = routeCanvas.sampleRoutePath(this.nodePts, 30);
    this.path = sampled.path;
    this.pathDist = sampled.dist;
    this.pathLen = sampled.len;
    this.nodePathIndex = sampled.nodePathIndex;

    // 星点：基础 70 颗 + 展开阶段追加 50 颗（§20.2「星空模式展开」）
    const mk = (n) => {
      const list = [];
      for (let i = 0; i < n; i++) {
        list.push({
          x: Math.random() * cw,
          y: Math.random() * ch,
          r: 0.5 + Math.random() * 1.3,
          phase: Math.random() * Math.PI * 2,
          freq: 0.6 + Math.random() * 1.6
        });
      }
      return list;
    };
    this.starsBase = mk(70);
    this.starsMore = mk(50);

    // 最后节点点亮粒子（§13.3 同规格，构建期固定）
    const last = this.nodePts[this.nodePts.length - 1];
    this.burst = [];
    for (let i = 0; i < 26 && last; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 50;
      this.burst.push({
        x: last.x,
        y: last.y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 16,
        r: 1 + Math.random() * 1.8,
        delay: 0.1 + Math.random() * 0.25
      });
    }
  },

  startLoop() {
    this.stopScene();
    const loop = () => {
      if (!this.running || !this._ctx) return;
      const t = this._staticMode ? 99 : (Date.now() - this._startAt) / 1000;
      this.drawFrame(t);
      this.tickTimeline(t);
      if (this._canvas && this._canvas.requestAnimationFrame) {
        this._animId = this._canvas.requestAnimationFrame(loop);
      } else {
        this._animId = setTimeout(loop, 16);
      }
    };
    this.running = true;
    loop();
  },

  stopScene() {
    this.running = false;
    if (this._animId !== undefined && this._canvas && this._canvas.cancelAnimationFrame) {
      this._canvas.cancelAnimationFrame(this._animId);
    }
    if (this._animId !== undefined) clearTimeout(this._animId);
    this._animId = undefined;
  },

  /** 时间轴副作用：到点切换最终文字 / 数据卡（只触发一次） */
  tickTimeline(t) {
    if (t >= TL.STATS_AT && !this.data.showStats) {
      this.setData({ phase: 'done', showFinalText: true, showStats: true });
      this.finalizeScene();
    } else if (t >= TL.TEXT2_AT && !this.data.showFinalText) {
      this.setData({ showFinalText: true });
    }
  },

  /**
   * 收尾：把画布最终帧快照为静态图并停帧，DOM 数据卡改为浮在静态图上
   * （canvas 原生层在开发者工具中会盖住 DOM 浮层）；快照失败时保留画布降级。
   */
  finalizeScene() {
    if (this._finalized || !this._canvas) return;
    this._finalized = true;
    this.stopScene();
    this.drawFrame(99);
    wx.canvasToTempFilePath({
      canvas: this._canvas,
      success: (r) => {
        this.setData({ sceneShot: r.tempFilePath, coverCanvas: true });
      },
      fail: () => { /* 降级：保留画布（真机同层渲染下数据卡仍可见） */ }
    });
  },

  /** 跳过动画：直接到最终状态 */
  skipAnim() {
    if (!this.data.pending || this.data.phase === 'done') return;
    this._startAt = Date.now() - TL.STATS_AT * 1000 - 100;
    this.setData({ phase: 'done', showFinalText: true, showStats: true });
    this.finalizeScene();
  },

  /* ---------------- 绘制 ---------------- */

  drawFrame(t) {
    const ctx = this._ctx;
    const cw = this._cw;
    const ch = this._ch;
    const nodes = this._route.nodes;

    // 深空背景（星空展开阶段后略微提亮）
    const expand = routeCanvas.easeOutCubic(Math.min(1, Math.max(0, (t - TL.PULSE_END) / (TL.STARS_END - TL.PULSE_END))));
    const sky = ctx.createLinearGradient(0, 0, 0, ch);
    sky.addColorStop(0, '#070D1A');
    sky.addColorStop(0.55, '#0D1B30');
    sky.addColorStop(1, expand > 0 ? '#1A2E4A' : '#14263E');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, cw, ch);

    this.drawStarfield(t, this.starsBase, 0.55 + expand * 0.45);
    if (expand > 0) this.drawStarfield(t, this.starsMore, expand);

    // 1) 最后一段推进（§20.2 第一步）：先画到倒数第二节点，再推进最后一段
    const n = this.nodePts.length;
    const lastSegStart = this.nodePathIndex[n - 2];
    const segP = routeCanvas.easeOutCubic(Math.min(1, t / TL.SEG_END));
    const segIdx = Math.floor(lastSegStart + (this.path.length - 1 - lastSegStart) * segP);
    // 2) 整线点亮（§20.2 第四步）：扫过全程
    const sweepP = routeCanvas.easeOutCubic(
      Math.min(1, Math.max(0, (t - TL.GLOW_END) / (TL.SWEEP_END - TL.GLOW_END)))
    );
    const sweepIdx = Math.floor(sweepP * (this.path.length - 1));
    const goldIdx = Math.max(segIdx, sweepIdx);

    // 虚线底（未完成引导线）
    ctx.save();
    ctx.setLineDash([6, 7]);
    ctx.beginPath();
    ctx.moveTo(this.path[0].x, this.path[0].y);
    for (let i = 1; i < this.path.length; i++) ctx.lineTo(this.path[i].x, this.path[i].y);
    ctx.strokeStyle = 'rgba(165,195,225,0.28)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // 金色已点亮段
    if (goldIdx > 0) {
      ctx.save();
      ctx.shadowColor = 'rgba(255,196,74,0.85)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(this.path[0].x, this.path[0].y);
      for (let i = 1; i <= goldIdx; i++) ctx.lineTo(this.path[i].x, this.path[i].y);
      ctx.strokeStyle = '#F0C65A';
      ctx.lineWidth = 4.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    }

    // 节点：推进段前 9 个先暗后随扫过点亮；最后节点在 GLOW 阶段点亮
    const glowT = Math.min(1, Math.max(0, (t - TL.SEG_END) / (TL.GLOW_END - TL.SEG_END)));
    const pulseT = Math.min(1, Math.max(0, (t - TL.SWEEP_END) / (TL.PULSE_END - TL.SWEEP_END)));
    const allLitPulse = pulseT > 0 && pulseT < 1 ? Math.sin(pulseT * Math.PI) : 0;
    nodes.forEach((node, i) => {
      const p = this.nodePts[i];
      let lit;
      if (i === n - 1) {
        lit = glowT >= 1 || sweepIdx >= this.nodePathIndex[i];
      } else {
        lit = sweepIdx >= this.nodePathIndex[i];
      }
      if (lit) {
        const breathe = 0.5 + 0.5 * Math.sin(t * 2 + i);
        const bump = 1 + allLitPulse * 0.5;
        const s = (26 + breathe * 10) * bump;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, s / 2);
        g.addColorStop(0, 'rgba(255,205,90,0.55)');
        g.addColorStop(1, 'rgba(255,205,90,0)');
        ctx.fillStyle = g;
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
        routeCanvas.drawStar(ctx, p.x, p.y, 5, 9 * bump, 3.8 * bump, t * 0.3);
        ctx.fillStyle = '#E8B84B';
        ctx.fill();
        routeCanvas.drawStar(ctx, p.x, p.y, 5, 4.2 * bump, 1.8 * bump, t * 0.3);
        ctx.fillStyle = '#FFF7DC';
        ctx.fill();
      } else {
        routeCanvas.drawStar(ctx, p.x, p.y, 5, 5.2, 2.2, 0);
        ctx.fillStyle = 'rgba(120,145,175,0.5)';
        ctx.fill();
      }
    });

    // 3) 最后节点点亮发光（§20.2 第二/三步）：扩散环 + 粒子扩散
    if (glowT > 0 && glowT < 1) {
      const last = this.nodePts[n - 1];
      const bump = Math.sin(glowT * Math.PI);
      routeCanvas.drawStar(ctx, last.x, last.y, 5, 10 * (1 + bump * 1.2), 4.2 * (1 + bump * 1.2), 0);
      ctx.fillStyle = 'rgba(255,233,168,' + (0.4 + (1 - glowT) * 0.6) + ')';
      ctx.fill();
      for (let k = 0; k < 2; k++) {
        const pr = Math.max(0, Math.min(1, glowT * 1.25 - k * 0.24));
        if (pr <= 0) continue;
        ctx.globalAlpha = (1 - pr) * 0.75;
        ctx.strokeStyle = '#FFD98A';
        ctx.lineWidth = 2.5 - pr * 1.4;
        ctx.beginPath();
        ctx.arc(last.x, last.y, 10 + pr * 52, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const tSec = glowT * (TL.GLOW_END - TL.SEG_END);
      for (const pt of this.burst) {
        const dt = tSec - pt.delay;
        if (dt <= 0 || dt >= 0.9) continue;
        const kk = dt / 0.9;
        ctx.globalAlpha = (1 - kk) * 0.85;
        ctx.fillStyle = '#FFE9A8';
        ctx.beginPath();
        ctx.arc(pt.x + pt.vx * dt, pt.y + pt.vy * dt + 20 * dt * dt, pt.r * (1 - kk * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // 6) 最终文字（§20.2）：「我的长征」「完成了」逐行淡入
    const text1A = Math.min(1, Math.max(0, (t - TL.STARS_END) / 0.6));
    const text2A = Math.min(1, Math.max(0, (t - TL.TEXT2_AT) / 0.6));
    ctx.textAlign = 'center';
    if (text1A > 0) {
      ctx.globalAlpha = text1A;
      ctx.fillStyle = '#F5D9A0';
      ctx.font = '600 22px sans-serif';
      ctx.fillText('我的长征', cw / 2, ch * 0.68);
    }
    if (text2A > 0) {
      ctx.globalAlpha = text2A;
      ctx.fillStyle = '#FFE9A8';
      ctx.font = 'bold 44px sans-serif';
      ctx.fillText('完成了', cw / 2, ch * 0.68 + 62);
    }
    ctx.globalAlpha = 1;
  },

  drawStarfield(t, stars, alphaScale) {
    const ctx = this._ctx;
    for (const s of stars) {
      const tw = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * s.freq + s.phase));
      ctx.globalAlpha = tw * alphaScale;
      ctx.fillStyle = '#EAF2FF';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },

  /* ---------------- 交互 ---------------- */

  /** 收下这份荣光：标记仪式已观看（§20.4）后返回 */
  handleConfirm() {
    const back = () => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/march/march' }) });
    if (!this.data.pending) {
      back();
      return;
    }
    march
      .markCeremony()
      .catch(() => {})
      .then(back);
  }
});
