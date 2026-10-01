/**
 * 登录页
 * 流程：点击「微信授权登录」-> chooseAvatar 选取微信头像 -> wx.login 换后端用户与 JWT。
 * 登录页不展示昵称输入框：昵称默认「长征小战士」，登录后可在「我的」页修改一次。
 * 登录成功后头像被持久化保存，首页与「我的」均回显微信头像。
 */
const auth = require('../../services/auth');
const app = getApp();

Page({
  data: {
    loading: false,
    errorMsg: ''
  },

  onLoad() {
    // 已登录则直接进入首页
    if (app.globalData.loggedIn) {
      wx.switchTab({ url: '/pages/home/home' });
    }
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
   * 执行登录：不采集昵称，后端默认昵称「长征小战士」；
   * 首次登录（无组织）跳组织选择，否则直达首页。
   * @param {string} avatar chooseAvatar 选取的头像临时路径
   */
  doLogin(avatar) {
    if (this.data.loading) return;
    this.setData({ loading: true, errorMsg: '' });

    auth
      .wxLogin({ avatar: avatar })
      .then((user) => {
        app.setLoginUser(user);

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
