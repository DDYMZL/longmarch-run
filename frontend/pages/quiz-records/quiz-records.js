/**
 * 答题记录页：日期 / 答对题数 / 正确率 / 超时题数 / 答题积分
 */
const app = getApp();
const quiz = require('../../services/quiz');

Page({
  data: {
    records: []
  },

  onShow() {
    // 未登录保护
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    this.refresh();
  },

  refresh() {
    quiz
      .getRecords()
      .then((result) => {
        // 仅取表格展示字段（丢弃 wrongList 等明细，减小 setData 体积）
        const records = result.map((r) => ({
          date: r.date,
          text: r.date.slice(5),
          totalCount: r.totalCount,
          correctCount: r.correctCount,
          accuracy: r.accuracy,
          timeoutCount: r.timeoutCount,
          points: r.points
        }));
        this.setData({ records });
      })
      .catch(() => {
        this.setData({ records: [] });
      });
  }
});
