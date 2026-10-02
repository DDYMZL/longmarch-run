const auth = require('./services/auth');

App({
  globalData: {
    user: null,
    // 本地用户与 JWT 同时存在才视为已登录
    loggedIn: false
  },

  onLaunch() {
    // 恢复本地登录态
    this.globalData.user = auth.getLocalUser();
    this.globalData.loggedIn = !!this.globalData.user;
  },

  /**
   * 登录成功后刷新全局登录态
   */
  setLoginUser(user) {
    this.globalData.user = user;
    this.globalData.loggedIn = true;
  },

  /**
   * 登出
   */
  logout() {
    auth.clearLocalUser();
    this.globalData.user = null;
    this.globalData.loggedIn = false;
  }
});
