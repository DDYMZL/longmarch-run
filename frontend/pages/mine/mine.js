/**
 * 个人中心
 * 展示：用户信息 / 累计步数 / 点亮节点 / 累计答题 / 积分 / 勋章
 * 入口：运动记录 / 答题记录 / 我的勋章 / 退出登录
 */
const app = getApp();
const auth = require('../../services/auth');
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
    // 并行拉取后端数据（勋章列表接口会自动评估发放）
    Promise.all([
      sport.getToday(),
      march.getRoute(),
      quiz.getRecords(),
      medal.getMedalList(),
      points.getTotal()
    ])
      .then((results) => {
        const today = results[0];
        const route = results[1];
        const records = results[2];
        const medalList = results[3];
        const totalPoints = results[4];
        const ownedMedals = medalList.filter((m) => m.owned);

        this.setData({
          user: app.globalData.user,
          totalSteps: today.totalSteps,
          litCount: route.litCount,
          totalCount: route.totalCount,
          quizCount: records.length,
          points: totalPoints,
          medalIcons: ownedMedals.slice(0, 6).map((m) => m.icon),
          medalCount: ownedMedals.length,
          medalTotal: medalList.length
        });
      })
      .catch(() => {
        this.setData({ user: app.globalData.user });
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
   * 修改昵称：每人仅一次（后端校验）。
   * 已修改过的用户点击时提示不可再次修改。
   */
  handleEditNickname() {
    const user = this.data.user;
    if (!user) return;
    if (user.nicknameChangedAt) {
      wx.showToast({ title: '昵称仅可修改一次', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '修改昵称',
      editable: true,
      placeholderText: '请输入新昵称',
      content: '昵称仅可修改一次，请确认无误后提交',
      confirmColor: '#C8102E',
      success: (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) {
          wx.showToast({ title: '昵称不能为空', icon: 'none' });
          return;
        }
        auth
          .updateNickname(name)
          .then((updated) => {
            if (updated) app.setLoginUser(updated);
            this.setData({ user: updated || user });
            wx.showToast({ title: '修改成功', icon: 'success' });
          })
          .catch((err) => {
            wx.showToast({
              title: (err && err.message) || '修改失败，请重试',
              icon: 'none'
            });
          });
      }
    });
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
