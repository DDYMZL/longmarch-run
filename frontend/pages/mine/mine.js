/**
 * 个人中心
 * 展示：用户信息 / 累计步数 / 点亮节点 / 累计答题 / 积分 / 勋章
 * 入口：运动记录 / 答题记录 / 我的勋章 / 退出登录
 */
const app = getApp();
const sport = require('../../services/sport');
const march = require('../../services/march');
const quiz = require('../../services/quiz');
const points = require('../../services/points');
const medal = require('../../services/medal');

Page({
  data: {
    user: null,
    totalSteps: 0,
    litCount: 0,
    totalCount: 10,
    quizCount: 0,
    points: 0,
    medalIcons: [],
    medalCount: 0
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
    const userId = app.globalData.user.id;

    // 勋章检查（登录进入时刷新一次）
    medal.checkAndGrant(userId);

    const today = sport.getToday(userId);
    const route = march.getRoute(userId);
    const records = quiz.getRecords(userId);
    const medalList = medal.getMedalList(userId);
    const ownedMedals = medalList.filter((m) => m.owned);

    this.setData({
      user: app.globalData.user,
      totalSteps: today.totalSteps,
      litCount: route.litCount,
      totalCount: route.totalCount,
      quizCount: records.length,
      points: points.getTotal(userId),
      medalIcons: ownedMedals.slice(0, 6).map((m) => m.icon),
      medalCount: ownedMedals.length,
      medalTotal: medalList.length
    });
  },

  goSportRecords() {
    wx.navigateTo({ url: '/pages/sport-records/sport-records' });
  },

  goQuizRecords() {
    wx.navigateTo({ url: '/pages/quiz-records/quiz-records' });
  },

  goMedals() {
    wx.navigateTo({ url: '/pages/medals/medals' });
  },

  /** 选择 / 修改组织架构 */
  goOrgSelect() {
    wx.navigateTo({ url: '/pages/org-select/org-select?from=mine' });
  },

  /**
   * 退出登录
   */
  handleLogout() {
    wx.showModal({
      title: '提示',
      content: '确定退出登录吗？',
      confirmColor: '#C8102E',
      success: (res) => {
        if (res.confirm) {
          app.logout();
          wx.reLaunch({ url: '/pages/login/login' });
        }
      }
    });
  }
});
