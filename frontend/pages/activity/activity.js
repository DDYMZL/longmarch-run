/**
 * 活动状态页：活动未发布 / 未开始 / 已结束（含结束后不可查看）时的统一引导页。
 * 来源：启动页按活动状态分流、查看类接口被活动拦截（request.js 自动跳转）、首页活动横幅。
 * 可查看时提供进入首页 / 排行入口；进行中时直接回首页。
 */
const activity = require('../../services/activity');

const STATUS_ICON = {
  unpublished: '📜',
  not_started: '⏳',
  ongoing: '🚩',
  ended: '🏆'
};

Page({
  data: {
    loading: true,
    errorMsg: '',
    status: null,
    icon: '',
    title: '',
    rangeText: ''
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    this.setData({ loading: true, errorMsg: '' });
    return activity
      .getStatus()
      .then((s) => {
        this.setData({
          loading: false,
          status: s,
          icon: STATUS_ICON[s.status] || '🚩',
          title: s.status === 'ended' ? s.endTitle : s.name,
          rangeText: activity.formatRange(s)
        });
      })
      .catch((err) => {
        this.setData({ loading: false, errorMsg: (err && err.message) || '活动状态获取失败，请稍后重试' });
      })
      .then(() => wx.stopPullDownRefresh());
  },

  onPullDownRefresh() {
    this.refresh();
  },

  goHome() {
    wx.switchTab({ url: '/pages/home/home', fail: () => wx.reLaunch({ url: '/pages/launch/launch' }) });
  },

  goRank() {
    wx.switchTab({ url: '/pages/rank/rank' });
  }
});
