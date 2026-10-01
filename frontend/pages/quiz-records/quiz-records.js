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
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.refresh();
  },

  refresh() {
    quiz
      .getRecords()
      .then((result) => {
        const records = result.map((r) => Object.assign({}, r, { text: r.date.slice(5) }));
        this.setData({ records });
      })
      .catch(() => {
        this.setData({ records: [] });
      });
  }
});
