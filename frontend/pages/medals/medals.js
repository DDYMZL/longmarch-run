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
    // 后端勋章列表接口会自动评估发放，直接读取
    medal
      .getMedalList()
      .then((list) => {
        this.setData({
          medals: list,
          ownedCount: list.filter((m) => m.owned).length,
          totalCount: list.length
        });
      })
      .catch(() => {
        this.setData({ medals: [], ownedCount: 0, totalCount: 0 });
      });
  }
});
