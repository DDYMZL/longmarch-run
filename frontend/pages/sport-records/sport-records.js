/**
 * 运动记录页：分页展示每日步数（GET /sport/records），弱网错误态 + 重试。
 * 汇总卡（总累计步数/平均每日步数）直接消费后端下发的全局汇总字段 totalSteps/avgSteps；
 * 后端未返回时回退到「基于已加载记录」的近似计算，避免 undefined。
 */
const app = getApp();
const sport = require('../../services/sport');

const PAGE_SIZE = 20;

/** 单条记录 -> 展示字段（防御性映射，兼容 date/text 命名，减小 setData 体积） */
function toView(r) {
  const date = r.date || '';
  return {
    date: date,
    text: r.text || (date ? date.slice(5) : ''),
    steps: r.steps || 0
  };
}

Page({
  data: {
    records: [], // 从新到旧
    totalSteps: 0,
    avgSteps: 0,
    loading: true,
    errorMsg: '',
    loadingMore: false,
    hasMore: false
  },

  onShow() {
    // 未登录保护
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    this.refresh();
  },

  /** 重新拉取首页记录（区分网络失败错误态与空态） */
  refresh() {
    const requestId = (this._requestId || 0) + 1;
    this._requestId = requestId;
    this.setData({ loading: true, errorMsg: '' });
    return sport
      .getRecords(1, PAGE_SIZE)
      .then((r) => {
        if (requestId !== this._requestId) return;
        this._page = 1;
        this.setData({
          loading: false,
          errorMsg: '',
          records: (r.items || []).map(toView),
          hasMore: !!r.hasMore
        });
        this._updateSummary(r);
      })
      .catch((err) => {
        if (requestId !== this._requestId) return;
        this.setData({
          loading: false,
          records: [],
          totalSteps: 0,
          avgSteps: 0,
          errorMsg: err && err.network ? '网络异常，请检查网络后重试' : (err && err.message) || '运动记录加载失败'
        });
      });
  },

  /** 触底加载下一页（追加写入，避免整表 setData） */
  onReachBottom() {
    const { hasMore, loadingMore, loading, errorMsg } = this.data;
    if (!hasMore || loadingMore || loading || errorMsg) return;
    const nextPage = (this._page || 1) + 1;
    const requestId = this._requestId;
    this.setData({ loadingMore: true });
    sport
      .getRecords(nextPage, PAGE_SIZE)
      .then((r) => {
        if (requestId !== this._requestId) return;
        this._page = nextPage;
        const start = this.data.records.length;
        const patch = { hasMore: !!r.hasMore, loadingMore: false };
        (r.items || []).forEach((item, i) => {
          patch['records[' + (start + i) + ']'] = toView(item);
        });
        this.setData(patch);
        this._updateSummary(r);
      })
      .catch(() => {
        this.setData({ loadingMore: false });
        wx.showToast({ title: '加载失败，请上拉重试', icon: 'none' });
      });
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  handleRetry() {
    this.refresh();
  },

  /**
   * 汇总卡：优先用后端全局汇总字段 totalSteps/avgSteps（精确、全量）；
   * 缺失时回退到基于已加载记录的近似计算，避免出现 undefined。
   * @param {object} [r] getRecords 响应
   */
  _updateSummary(r) {
    const resp = r || {};
    let totalSteps = resp.totalSteps;
    let avgSteps = resp.avgSteps;
    if (typeof totalSteps !== 'number' || typeof avgSteps !== 'number') {
      const records = this.data.records;
      const sum = records.reduce((s, item) => s + item.steps, 0);
      const hasDays = records.filter((item) => item.steps > 0).length;
      if (typeof totalSteps !== 'number') totalSteps = sum;
      if (typeof avgSteps !== 'number') avgSteps = hasDays > 0 ? Math.round(sum / hasDays) : 0;
    }
    this.setData({ totalSteps: totalSteps, avgSteps: avgSteps });
  }
});
