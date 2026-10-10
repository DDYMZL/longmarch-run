/**
 * 启动页（首页面 + 通用入驻二维码落地页）
 * 校验本地 Token 或静默 wx.login 登录，成功后进入首页（携带 redirect 时回原页）；
 * 失败停留本页提示并可重试，不会进入"假登录"状态。用户主动退出过则转登录页手动登录。
 */
const auth = require('../../services/auth');

const HOME_PAGE = '/pages/home/home';

Page({
  data: {
    loading: true,
    errorMsg: ''
  },

  onLoad(options) {
    this.redirect = decodeURIComponent((options && options.redirect) || '');
    this.start();
  },

  start() {
    this.setData({ loading: true, errorMsg: '' });
    auth
      .ensureLogin()
      .then(() => this.enter())
      .catch((err) => {
        if (err && err.loggedOut) {
          const query = this.redirect ? '?redirect=' + encodeURIComponent(this.redirect) : '';
          wx.redirectTo({ url: '/pages/login/login' + query });
          return;
        }
        const msg = err && err.network ? '网络异常，请检查网络后重试' : (err && err.message) || '登录失败，请重试';
        this.setData({ loading: false, errorMsg: msg });
      });
  },

  enter() {
    if (!this.redirect) {
      wx.switchTab({ url: HOME_PAGE });
      return;
    }
    const target = this.redirect;
    wx.redirectTo({
      url: target,
      // redirect 指向 tabBar 页时 redirectTo 失败，改用 switchTab（不支持参数）
      fail: () => wx.switchTab({ url: target.split('?')[0], fail: () => wx.switchTab({ url: HOME_PAGE }) })
    });
  },

  onRetry() {
    if (this.data.loading) return;
    this.start();
  }
});
