const auth = require('./services/auth');

App({
  globalData: {
    user: null,
    // 是否已登录（本地 Mock 登录态）
    loggedIn: false
  },

  onLaunch() {
    // 恢复本地登录态
    this.globalData.user = auth.getLocalUser();
    this.globalData.loggedIn = !!this.globalData.user;

    // 登录后发放每日登录积分
    if (this.globalData.loggedIn) {
      const points = require('./services/points');
      points.grantDailyLogin(this.globalData.user.id);
    }
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
    // 清理内存数据缓存，避免下个用户读到脏数据
    require('./services/store').clearCache();
    this.globalData.user = null;
    this.globalData.loggedIn = false;
  }
});
