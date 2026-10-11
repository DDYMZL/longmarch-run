/**
 * 答题记录页：日期 / 答题数 / 正确数 / 得分 / 获得积分
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
          score: r.score,
          points: r.points
        }));
        this.setData({ records });
      })
      .catch(() => {
        this.setData({ records: [] });
      });
  }
});
