/**
 * 登录页
 * 流程：点击「微信授权登录」-> chooseAvatar 选取微信头像 -> wx.login 换用户信息与 Token（Mock）
 *       登录成功后头像被持久化保存，首页与「我的」均回显微信头像。
 */
const auth = require('../../services/auth');
const points = require('../../services/points');
const app = getApp();

Page({
  data: {
    loading: false,
    errorMsg: '',
    // 微信「昵称填写」能力采集的昵称（可选，留空默认“长征小战士”）
    nickname: ''
  },

  onLoad() {
    // 已登录则直接进入首页
    if (app.globalData.loggedIn) {
      wx.switchTab({ url: '/pages/home/home' });
    }
  },

  /** 填写昵称（可一键同步微信昵称） */
  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  /**
   * 「微信授权登录」按钮同时是头像选择器：
   * 用户选择微信头像后触发，随即完成登录，保证首页 / 我的回显微信头像。
   */
  onChooseAvatar(e) {
    const avatarUrl = (e.detail && e.detail.avatarUrl) || '';
    this.doLogin(avatarUrl);
  },

  /**
   * 执行登录
   * @param {string} avatar chooseAvatar 选取的头像临时路径
   */
  doLogin(avatar) {
    if (this.data.loading) return;
    this.setData({ loading: true, errorMsg: '' });

    auth
      .wxLogin({ nickname: this.data.nickname, avatar: avatar })
      .then((user) => {
        app.setLoginUser(user);
        // 每日登录积分
        points.grantDailyLogin(user.id);

        wx.showToast({ title: '登录成功', icon: 'success' });
        setTimeout(() => {
          if (!user.orgId) {
            // 首次登录引导选择组织架构
            wx.redirectTo({ url: '/pages/org-select/org-select?from=login' });
          } else {
            wx.switchTab({ url: '/pages/home/home' });
          }
        }, 600);
      })
      .catch((err) => {
        this.setData({ errorMsg: (err && err.message) || '微信授权失败，请重试' });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  }
});
