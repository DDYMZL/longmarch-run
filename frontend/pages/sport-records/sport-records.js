/**
 * 运动记录页：最近 30 天每日步数 + 累计/平均
 */
const app = getApp();
const sport = require('../../services/sport');

Page({
  data: {
    records: [], // 从新到旧
    totalSteps: 0,
    avgSteps: 0
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
    sport
      .getRecent(30)
      .then((result) => {
        const recent = result.reverse(); // 新 -> 旧
        const sum = recent.reduce((s, r) => s + r.steps, 0);
        const hasDays = recent.filter((r) => r.steps > 0).length;

        this.setData({
          records: recent,
          totalSteps: sum,
          avgSteps: hasDays > 0 ? Math.round(sum / hasDays) : 0
        });
      })
      .catch(() => {
        this.setData({ records: [], totalSteps: 0, avgSteps: 0 });
      });
  }
});
