/**
 * 节点纪念票（需求 §19）：已点亮节点的数字纪念票。
 * 票面：长征步迹标识 / 节点名 / 历史日期 / 「我于{点亮日期}完成该历史节点」/ 当日步数。
 * Canvas 本地绘制，不依赖服务端图片；可保存到相册。
 */
const app = getApp();
const march = require('../../services/march');
const util = require('../../utils/util');
const routeCanvas = require('../../utils/routeCanvas');
const { ensureScope } = require('../../utils/authGuide');

Page({
  data: {
    ready: false,
    error: '',
    nodeName: '',
    saving: false
  },

  onLoad(options) {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
    const id = parseInt(options.id, 10);
    Promise.all([march.getNodeDetail(id), march.getFootprints()])
      .then(([node, footprints]) => {
        const fp = (footprints.nodes || []).find((n) => n.id === id);
        if (!node || node.status !== 'completed' || !fp) {
          this.setData({ error: '该节点尚未点亮，完成后可生成纪念票' });
          return;
        }
        this._ticket = {
          id: id,
          icon: node.icon,
          name: node.name,
          historicalTime: node.historicalTime,
          litDate: fp.litDate || '未知日期',
          daySteps: fp.daySteps,
          cumSteps: fp.cumSteps,
          serial: 'NO.' + String(fp.litDate || '').replace(/-/g, '') + '-' + String(id).padStart(2, '0')
        };
        this.setData({ ready: true, nodeName: node.name });
        wx.setNavigationBarTitle({ title: node.name + '纪念票' });
        this.drawTicket();
      })
      .catch(() => {
        this.setData({ error: '纪念票数据加载失败，请稍后重试' });
      });
  },

  /**
   * Canvas 绘制纪念票（dpr 适配与画像雷达图一致）
   */
  drawTicket() {
    wx.createSelectorQuery()
      .in(this)
      .select('#ticketCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const { node, width, height } = res[0];
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;
        node.width = width * dpr;
        node.height = height * dpr;
        const ctx = node.getContext('2d');
        ctx.scale(dpr, dpr);
        this._canvas = node;
        this.paint(ctx, width, height);
        // 绘制完成后异步导出分享图（失败不影响主流程）
        try {
          wx.canvasToTempFilePath({
            canvas: node,
            success: (r) => { this._shareImg = r.tempFilePath; },
            fail: () => { /* 分享图导出失败时 onShareAppMessage 降级无图 */ }
          });
        } catch (e) { /* 低版本基础库不支持时静默降级 */ }
      });
  },

  paint(ctx, w, h) {
    const t = this._ticket;
    ctx.clearRect(0, 0, w, h);

    // 票根外框：米黄纸面 + 圆角
    const m = 10;
    routeCanvas.drawRoundRect(ctx, m, m, w - m * 2, h - m * 2, 14);
    ctx.fillStyle = '#FBF3DC';
    ctx.fill();
    ctx.strokeStyle = '#C8102E';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 顶部红色票头
    routeCanvas.drawRoundRect(ctx, m, m, w - m * 2, 74, 14);
    ctx.fillStyle = '#A00D26';
    ctx.fill();
    ctx.fillRect(m, m + 60, w - m * 2, 14); // 补圆角下沿成直角
    ctx.fillStyle = '#F5D9A0';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('长征步迹', w / 2, m + 32);
    ctx.font = '12px sans-serif';
    ctx.fillText('节 点 纪 念 票', w / 2, m + 56);

    // 节点图标 + 名称 + 历史日期
    ctx.textAlign = 'center';
    ctx.font = '44px sans-serif';
    ctx.fillText(t.icon || '★', w / 2, m + 138);
    ctx.fillStyle = '#5A1A1A';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(t.name, w / 2, m + 178);
    ctx.fillStyle = '#B8860B';
    ctx.font = '13px sans-serif';
    ctx.fillText(t.historicalTime || '', w / 2, m + 202);

    // 打孔分隔线（两侧半圆缺口 + 虚线）
    const dy = m + 224;
    ctx.strokeStyle = '#C8102E';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(m + 12, dy);
    ctx.lineTo(w - m - 12, dy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#7A0E20';
    ctx.beginPath();
    ctx.arc(m, dy, 7, 0, Math.PI * 2);
    ctx.arc(w - m, dy, 7, 0, Math.PI * 2);
    ctx.fill();

    // 完成宣言
    ctx.fillStyle = '#5A1A1A';
    ctx.font = '15px sans-serif';
    ctx.fillText('我于 ' + t.litDate, w / 2, dy + 36);
    ctx.fillText('完成该历史节点', w / 2, dy + 60);

    // 当日步数 / 累计步数
    ctx.fillStyle = '#A00D26';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(util.formatNumber(t.daySteps) + ' 步', w / 2, dy + 94);
    ctx.fillStyle = '#8C6D2F';
    ctx.font = '12px sans-serif';
    ctx.fillText('当日步数' + (t.cumSteps > 0 ? ' · 累计 ' + util.formatNumber(t.cumSteps) + ' 步' : ''), w / 2, dy + 116);

    // 票号
    ctx.fillStyle = '#B8860B';
    ctx.font = '11px sans-serif';
    ctx.fillText(t.serial, w / 2, h - m - 16);
  },

  /**
   * 保存纪念票到相册（授权失败时引导前往设置页开启）
   */
  handleSave() {
    if (this.data.saving || !this.data.ready || !this._canvas) return;
    this.setData({ saving: true });
    wx.canvasToTempFilePath({
      canvas: this._canvas,
      success: (res) => {
        this._saveToAlbum(res.tempFilePath);
      },
      fail: () => {
        wx.showToast({ title: '生成图片失败', icon: 'none' });
        this.setData({ saving: false });
      }
    });
  },

  /** 实际写入相册；权限被拒时引导用户前往设置页开启 */
  _saveToAlbum(filePath) {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => {
        wx.showToast({ title: '已保存到相册', icon: 'success' });
        this.setData({ saving: false });
      },
      fail: (err) => {
        this.setData({ saving: false });
        if (err && /auth|authorize/.test(err.errMsg || '')) {
          ensureScope('scope.writePhotosAlbum', '需要相册写入权限才能保存纪念票，请在设置中开启。')
            .then((granted) => {
              if (granted) {
                this.setData({ saving: true });
                this._saveToAlbum(filePath);
              }
            });
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      }
    });
  },

  /** 分享给好友：标题带节点名，分享图用绘制完成后导出的 _shareImg（失败降级无图） */
  onShareAppMessage() {
    const t = this._ticket;
    const title = t ? '我在长征步迹完成了「' + t.name + '」节点！' : '长征步迹 · 节点纪念票';
    // 分享图：尝试导出画布临时路径，失败则用默认
    try {
      const img = this._shareImg;
      return { title, imageUrl: img || undefined, path: '/pages/ticket/ticket?id=' + (this._ticket && this._ticket.id || '') };
    } catch (e) {
      return { title };
    }
  },

  onShareTimeline() {
    const t = this._ticket;
    const title = t ? '长征步迹 · 我完成了「' + t.name + '」' : '长征步迹 · 节点纪念票';
    return { title, imageUrl: this._shareImg || undefined };
  }
});
