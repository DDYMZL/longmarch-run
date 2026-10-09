/**
 * 个人中心
 * 数据区改引 profile summary 口径（累计步数/点亮节点/答题/积分），
 * 入口：我的长征 / 行军日历 / 组织架构 / 运动记录 / 答题记录 / 我的勋章 / 退出登录
 */
const app = getApp();
const auth = require('../../services/auth');
const profile = require('../../services/profile');
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
    medalCount: 0,
    medalTotal: 0
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
    // 档案聚合 + 勋章图标条（勋章列表接口会自动评估发放）
    Promise.all([profile.getSummary(), medal.getMedalList()])
      .then((results) => {
        const summary = results[0];
        const medalList = results[1];
        const ownedMedals = medalList.filter((m) => m.owned);

        this.setData({
          user: app.globalData.user,
          totalSteps: summary.stats.totalSteps,
          litCount: summary.stats.litCount,
          totalCount: summary.stats.totalCount,
          quizCount: summary.quiz.totalCount,
          points: summary.points.total,
          medalIcons: ownedMedals.slice(0, 6).map((m) => m.icon),
          medalCount: ownedMedals.length,
          medalTotal: medalList.length
        });
      })
      .catch(() => {
        this.setData({ user: app.globalData.user });
      });
  },

  /** 我的长征（档案页） */
  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  /** 行军日历 */
  goCalendar() {
    wx.navigateTo({ url: '/pages/calendar/calendar' });
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

  /** 账号与绑定（身份列表 / 解绑） */
  goAccount() {
    wx.navigateTo({ url: '/pages/account/account' });
  },

  /**
   * 修改昵称：每人仅一次（后端校验）。
   * 修改入口仅在未修改过时展示（wxml 按 nicknameChangedAt 隐藏），此处兜底拦截二次修改。
   */
  handleEditNickname() {
    const user = this.data.user;
    if (!user) return;
    if (user.nicknameChangedAt) {
      wx.showToast({ title: '昵称仅可修改一次', icon: 'none' });
      return;
    }
    // 提示语放标题（输入框外），输入框内不放 placeholderText；editable 弹窗 content 在模拟器会与输入框叠层，故不使用
    wx.showModal({
      title: '请输入真实姓名',
      editable: true,
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
