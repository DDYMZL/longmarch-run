/**
 * 答题记录页：分页展示日期/答对题数/正确率/超时题数/积分（GET /quiz/records），
 * 弱网错误态 + 重试。
 */
const app = getApp();
const quiz = require('../../services/quiz');

const PAGE_SIZE = 20;

/** 单条记录 -> 表格展示字段（丢弃 wrongList 等明细，减小 setData 体积） */
function toView(r) {
  const date = r.date || '';
  return {
    date: date,
    text: date ? date.slice(5) : '',
    totalCount: r.totalCount || 0,
    correctCount: r.correctCount || 0,
    accuracy: r.accuracy || 0,
    timeoutCount: r.timeoutCount || 0,
    points: r.points || 0
  };
}

Page({
  data: {
    records: [],
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
    return quiz
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
      })
      .catch((err) => {
        if (requestId !== this._requestId) return;
        this.setData({
          loading: false,
          records: [],
          errorMsg: err && err.network ? '网络异常，请检查网络后重试' : (err && err.message) || '答题记录加载失败'
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
    quiz
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
  }
});
