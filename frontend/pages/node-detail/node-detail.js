/**
 * 节点详情页（历史事件卡）
 * 结构：历史图片(有图 swiper / 无图插画) → 标题+关键词 → 时间/地点 → 数据卡
 *       → 简介 → 历史故事 → 历史意义 → 相关人物 → 路线位置(小地图)
 * 头部带区域氛围（需求 §12）：按节点所属区域主题渲染氛围渐变 + 粒子画布
 * （雪花/水雾/暖尘/星光），主题映射集中在 data/node-themes.js。
 */
const app = getApp();
const march = require('../../services/march');
const util = require('../../utils/util');
const nodeThemes = require('../../data/node-themes');

Page({
  data: {
    node: null,
    statusText: '',
    targetText: '',
    currentText: '',
    keywordList: [],
    markers: [],
    // 区域氛围（§12）：主题标识 / 环境描述 / 头部渐变
    themeKey: '',
    themeEnv: '',
    themeBgStyle: ''
  },

  onLoad(options) {
    // 未登录保护
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }

    const id = parseInt(options.id, 10);
    march
      .getNodeDetail(id)
      .then((node) => {
        const statusMap = {
          completed: '★ 已点亮',
          current: '◎ 进行中',
          unlocked: '○ 未解锁'
        };
        const theme = nodeThemes.getNodeTheme(node.id);

        this.setData({
          node,
          statusText: statusMap[node.status] || '未解锁',
          targetText: util.formatNumber(node.targetSteps),
          currentText: util.formatNumber(node.currentSteps),
          keywordList: node.keywords ? node.keywords.split(',').filter((k) => k) : [],
          themeKey: theme.theme,
          themeEnv: theme.environment,
          themeBgStyle: nodeThemes.themeBgStyle(theme),
          markers: [
            {
              id: node.id,
              latitude: node.latitude,
              longitude: node.longitude,
              width: 24,
              height: 24,
              callout: {
                content: node.name,
                color: '#5A1A1A',
                bgColor: '#FBF3DC',
                fontSize: 12,
                borderRadius: 8,
                padding: 6,
                display: 'ALWAYS'
              }
            }
          ]
        });
        wx.setNavigationBarTitle({ title: node.name });
        this.startAtmosphere(theme);
      })
      .catch(() => {
        wx.showToast({ title: '节点不存在', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
      });
  },

  onHide() {
    this.stopAtmosphere();
  },

  onUnload() {
    this.stopAtmosphere();
  },

  onShow() {
    // 从子页（人物/纪念票）返回时恢复氛围动画
    if (this.data.node && !this._atmoRunning) {
      this.startAtmosphere(nodeThemes.getNodeTheme(this.data.node.id));
    }
  },

  /* ---------------- 区域氛围（§12） ---------------- */

  /**
   * 氛围粒子画布：按主题 particleConfig 一次性生成粒子（上限 24 颗），
   * rAF 循环内零分配；雪花下落 / 暖尘上升 / 水雾漂移 / 星光闪烁。
   */
  startAtmosphere(theme) {
    this.stopAtmosphere();
    const cfg = theme.particleConfig;
    wx.createSelectorQuery()
      .select('#atmoCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const { node, width, height } = res[0];
        if (!width || !height) return;
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;
        node.width = width * dpr;
        node.height = height * dpr;
        const ctx = node.getContext('2d');
        ctx.scale(dpr, dpr);

        const count = Math.min(cfg.count || 12, 24);
        const parts = [];
        for (let i = 0; i < count; i++) {
          parts.push({
            x: Math.random() * width,
            y: Math.random() * height,
            r: 0.8 + Math.random() * 1.6,
            phase: Math.random() * Math.PI * 2,
            freq: 0.5 + Math.random() * 1.4,
            speed: 0.6 + Math.random() * 0.8
          });
        }
        this._atmo = { canvas: node, ctx, w: width, h: height, cfg, parts };
        this._atmoRunning = true;
        const loop = () => {
          if (!this._atmoRunning || !this._atmo) return;
          this.drawAtmosphere(Date.now() / 1000);
          if (this._atmo.canvas.requestAnimationFrame) {
            this._atmoId = this._atmo.canvas.requestAnimationFrame(loop);
          } else {
            this._atmoId = setTimeout(loop, 33);
          }
        };
        loop();
      });
  },

  drawAtmosphere(t) {
    const a = this._atmo;
    if (!a) return;
    const { ctx, w, h, cfg, parts } = a;
    ctx.clearRect(0, 0, w, h);
    const type = cfg.type;
    for (const p of parts) {
      ctx.fillStyle = cfg.color;
      if (type === 'snow') {
        const y = (p.y + t * 12 * p.speed) % (h + 8) - 4;
        const x = p.x + Math.sin(t * p.freq + p.phase) * 6;
        ctx.globalAlpha = 0.35 + 0.3 * Math.sin(t * p.freq + p.phase);
        ctx.beginPath();
        ctx.arc(x, y, p.r, 0, Math.PI * 2);
        ctx.fill();
      } else if (type === 'ember') {
        const y = h + 4 - ((p.y + t * 10 * p.speed) % (h + 8));
        const x = p.x + Math.sin(t * p.freq + p.phase) * 5;
        ctx.globalAlpha = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * p.freq * 1.6 + p.phase));
        ctx.beginPath();
        ctx.arc(x, y, p.r, 0, Math.PI * 2);
        ctx.fill();
      } else if (type === 'mist') {
        const x = (p.x + t * 9 * p.speed) % (w + 60) - 30;
        ctx.globalAlpha = 0.06 + 0.04 * Math.sin(t * 0.5 + p.phase);
        ctx.beginPath();
        ctx.ellipse(x, p.y, p.r * 12, p.r * 5, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // star：原地闪烁（延安黄昏星空）
        ctx.globalAlpha = 0.3 + 0.6 * (0.5 + 0.5 * Math.sin(t * p.freq + p.phase));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  },

  stopAtmosphere() {
    this._atmoRunning = false;
    if (this._atmo && this._atmo.canvas && this._atmo.canvas.cancelAnimationFrame) {
      this._atmo.canvas.cancelAnimationFrame(this._atmoId);
    }
    if (this._atmoId !== undefined) clearTimeout(this._atmoId);
    this._atmoId = undefined;
  },

  /**
   * 相关人物 -> 长征人物志详情（§14.3 节点详情 → 人物）
   */
  goPerson(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/person/person?id=' + id });
  },

  /**
   * 继续运动 -> 回首页同步步数
   */
  handleContinue() {
    wx.switchTab({ url: '/pages/home/home' });
  },

  /**
   * 生成节点纪念票（需求 §19：仅已点亮节点可见入口）
   */
  goTicket() {
    wx.navigateTo({ url: '/pages/ticket/ticket?id=' + this.data.node.id });
  }
});
