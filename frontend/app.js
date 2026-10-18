const auth = require('./services/auth');

App({
  globalData: {
    user: null,
    // 仅在后端校验 Token 通过（启动页 ensureLogin）或登录成功后置为 true，本地缓存不作数
    loggedIn: false,
    // 跨页写操作（答题/点亮/同步）置 true，首页 onShow 检测到则强制刷新绕过 30s 节流
    homeDirty: false
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
