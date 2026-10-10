/**
 * 步数排行榜：全员工累计步数总榜（跨所有组织）
 * 高亮显示「我」的名次；顶部展示我的成绩概览。
 */
const app = getApp();
const rank = require('../../services/rank');

Page({
  data: {
    list: [],
    myRank: null,
    mySteps: 0,
    total: 0
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    this.refresh();
  },

  refresh() {
    rank
      .getStepsRank()
      .then((r) => {
        this.setData({
          list: r.list,
          myRank: r.myRank,
          mySteps: r.mySteps,
          total: r.total
        });
      })
      .catch(() => {
        this.setData({ list: [], myRank: null, mySteps: 0, total: 0 });
      });
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  }
});
