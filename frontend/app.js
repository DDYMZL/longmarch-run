const auth = require('./services/auth');

App({
  globalData: {
    user: null,
    // 仅在后端校验 Token 通过（启动页 ensureLogin）或登录成功后置为 true，本地缓存不作数
    loggedIn: false
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
