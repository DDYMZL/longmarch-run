/**
 * 登录页（用户主动退出后的手动登录入口；日常启动由启动页静默登录）
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

  onLoad(options) {
    // 扫码确认等流程携带 redirect：登录后原路返回（默认进入首页）
    this.redirect = decodeURIComponent((options && options.redirect) || '');
    if (app.globalData.loggedIn) {
      if (this.redirect) {
        wx.redirectTo({ url: this.redirect });
      } else {
        wx.switchTab({ url: '/pages/home/home' });
      }
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
   * 执行登录：不采集昵称，后端默认昵称「长征小战士」；成功后直达首页（组织在首页 /「我的」选填）。
   * @param {string} avatar chooseAvatar 选取的头像临时路径
   */
  doLogin(avatar) {
    if (this.data.loading) return;
    this.setData({ loading: true, errorMsg: '' });

    auth
      .wxLogin({ avatar: avatar })
      .then(() => {
        wx.showToast({ title: '登录成功', icon: 'success' });
        setTimeout(() => {
          if (this.redirect) {
            // 扫码确认流程：立即返回确认页（场景凭证有效期短，不打断）
            wx.redirectTo({ url: this.redirect });
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
