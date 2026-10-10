/**
 * 节点纪念票（需求 §19）：已点亮节点的数字纪念票。
 * 票面：长征步迹标识 / 节点名 / 历史日期 / 「我于{点亮日期}完成该历史节点」/ 当日步数。
 * Canvas 本地绘制，不依赖服务端图片；可保存到相册。
 */
const app = getApp();
const march = require('../../services/march');
const util = require('../../utils/util');

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
    const id = parseInt(options.id, 10);
    Promise.all([march.getNodeDetail(id), march.getFootprints()])
      .then(([node, footprints]) => {
        const fp = (footprints.nodes || []).find((n) => n.id === id);
        if (!node || node.status !== 'completed' || !fp) {
          this.setData({ error: '该节点尚未点亮，完成后可生成纪念票' });
          return;
        }
        this._ticket = {
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
      });
  },

  paint(ctx, w, h) {
    const t = this._ticket;
    ctx.clearRect(0, 0, w, h);

    // 票根外框：米黄纸面 + 圆角
    const m = 10;
    this.roundRect(ctx, m, m, w - m * 2, h - m * 2, 14);
    ctx.fillStyle = '#FBF3DC';
    ctx.fill();
    ctx.strokeStyle = '#C8102E';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 顶部红色票头
    this.roundRect(ctx, m, m, w - m * 2, 74, 14);
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

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  },

  /**
   * 保存纪念票到相册
   */
  handleSave() {
    if (this.data.saving || !this.data.ready || !this._canvas) return;
    this.setData({ saving: true });
    wx.canvasToTempFilePath({
      canvas: this._canvas,
      success: (res) => {
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
          fail: (err) => {
            if (err && /auth|authorize/.test(err.errMsg || '')) {
              wx.showToast({ title: '请授权保存到相册', icon: 'none' });
            } else {
              wx.showToast({ title: '保存失败', icon: 'none' });
            }
          }
        });
      },
      fail: () => wx.showToast({ title: '生成图片失败', icon: 'none' }),
      complete: () => this.setData({ saving: false })
    });
  }
});
