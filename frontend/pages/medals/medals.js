/**
 * 勋章墙：展示全部勋章，区分已获得/未获得
 */
const app = getApp();
const medal = require('../../services/medal');

Page({
  data: {
    medals: [],
    ownedCount: 0,
    totalCount: 0
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
    // 先评估勋章（数据变化后可能新增），再读列表
    medal.checkAndGrant(app.globalData.user.id);
    const list = medal.getMedalList(app.globalData.user.id);
    this.setData({
      medals: list,
      ownedCount: list.filter((m) => m.owned).length,
      totalCount: list.length
    });
  }
});
