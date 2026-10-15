/**
 * 积分明细页：积分汇总 + 计分规则 + 按日明细（分页，onReachBottom 追加）。
 * 积分口径全部来自后端，前端仅展示。
 */
const app = getApp();
const points = require('../../services/points');

const PAGE_SIZE = 20;

function toRow(d) {
  return {
    date: d.date,
    text: d.date.slice(5),
    steps: d.steps,
    correctCount: d.correctCount,
    walk: d.walk,
    quiz: d.quiz,
    total: d.total
  };
}

Page({
  data: {
    summary: null,
    rules: null,
    items: [],
    page: 1,
    hasMore: false,
    loading: true,
    loadingMore: false,
    errorMsg: ''
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    this.refresh();
  },

  refresh() {
    const reqId = (this._reqId = (this._reqId || 0) + 1);
    return Promise.all([points.getSummary(), points.getDaily(1, PAGE_SIZE)])
      .then((results) => {
        if (reqId !== this._reqId) return;
        const s = results[0];
        const daily = results[1];
        this.setData({
          summary: {
            total: s.total,
            walk: s.walk,
            quiz: s.quiz,
            today: s.todayWalk + s.todayQuiz,
            todayWalk: s.todayWalk,
            todayQuiz: s.todayQuiz,
            todaySteps: s.todaySteps,
            todayCorrect: s.todayCorrect,
            walkCarry: s.walkCarry,
            rank: s.rank
          },
          rules: s.rules,
          items: daily.items.map(toRow),
          page: 1,
          hasMore: daily.items.length < daily.total,
          loading: false,
          errorMsg: ''
        });
      })
      .catch((err) => {
        if (reqId !== this._reqId) return;
        this.setData({ loading: false, errorMsg: (err && err.message) || '加载失败，请稍后重试' });
      })
      .then(() => wx.stopPullDownRefresh());
  },

  onPullDownRefresh() {
    this.refresh();
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    const next = this.data.page + 1;
    const reqId = this._reqId;
    this.setData({ loadingMore: true });
    points
      .getDaily(next, PAGE_SIZE)
      .then((daily) => {
        if (reqId !== this._reqId) return;
        const base = this.data.items.length;
        const patch = { page: next, loadingMore: false };
        daily.items.forEach((d, i) => {
          patch['items[' + (base + i) + ']'] = toRow(d);
        });
        patch.hasMore = daily.items.length > 0 && base + daily.items.length < daily.total;
        this.setData(patch);
      })
      .catch(() => {
        this.setData({ loadingMore: false });
        wx.showToast({ title: '加载失败，请稍后重试', icon: 'none' });
      });
  },

  handleRetry() {
    this.setData({ loading: true, errorMsg: '' });
    this.refresh();
  }
});
