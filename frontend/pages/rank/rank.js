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
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    // 已登录但未选组织 -> 强制先完成组织选择
    if (!app.globalData.user.orgId) {
      wx.redirectTo({ url: '/pages/org-select/org-select?from=login' });
      return;
    }
    this.refresh();
  },

  refresh() {
    const r = rank.getStepsRank(app.globalData.user.id);
    this.setData({
      list: r.list,
      myRank: r.myRank,
      mySteps: r.mySteps,
      total: r.total
    });
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  }
});
