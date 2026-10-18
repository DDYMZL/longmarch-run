/**
 * 登录页（用户主动退出后的手动登录入口；日常启动由启动页静默登录）
 * 流程：
 *   1. 可选：点击头像区域选择微信头像（取消选择不会静默无反应）
 *   2. 勾选协议
 *   3. 点击「微信授权登录」→ wx.login → 后端换 JWT → 若已选头像则上传
 * 登录成功后头像被上传到服务端，首页与「我的」均回显真实头像。
 */
const auth = require('../../services/auth');
const app = getApp();

Page({
  data: {
    avatarUrl: '',
    agreed: false,
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
   * 头像选择回调：仅存储临时路径，不触发登录。
   * 用户取消选择时 e.detail.avatarUrl 为空字符串，不做任何处理（解决"取消头像选择静默无反应"）。
   */
  onChooseAvatar(e) {
    const avatarUrl = (e.detail && e.detail.avatarUrl) || '';
    if (avatarUrl) {
      this.setData({ avatarUrl });
    }
    // 取消选择（avatarUrl 为空）时保持现状，不弹错误提示
  },

  /** 切换协议勾选状态 */
  toggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  /** 查看用户协议（弹窗展示，无需跳转独立页面） */
  goAgreement() {
    wx.showModal({
      title: '用户协议',
      content: '欢迎使用长征运动挑战！本应用为内部活动工具，仅收集您的微信运动步数用于活动积分计算。您在使用本应用即表示同意相关活动规则。如有疑问请联系活动管理员。',
      showCancel: false,
      confirmText: '我知道了',
      confirmColor: '#C8102E'
    });
  },

  /** 查看隐私政策 */
  goPrivacy() {
    wx.showModal({
      title: '隐私政策',
      content: '本应用仅收集：微信 OpenID（用于身份识别）、微信运动步数（用于活动积分）、头像与昵称（可选，用于展示）。数据仅存储于活动服务器，不对外分享。您可在「我的」页退出登录并清除本地数据。',
      showCancel: false,
      confirmText: '我知道了',
      confirmColor: '#C8102E'
    });
  },

  /**
   * 执行登录：普通按钮触发（不再依赖 bindchooseavatar）。
   * 登录前校验协议勾选；登录成功后若已选头像则上传到服务端。
   */
  doLogin() {
    if (this.data.loading) return;
    if (!this.data.agreed) {
      wx.showToast({ title: '请先勾选用户协议', icon: 'none' });
      return;
    }
    this.setData({ loading: true, errorMsg: '' });

    auth
      .wxLogin({ avatar: this.data.avatarUrl })
      .then(() => {
        wx.showToast({ title: '登录成功', icon: 'success' });
        setTimeout(() => {
          if (this.redirect) {
            wx.redirectTo({ url: this.redirect });
          } else {
            wx.switchTab({ url: '/pages/home/home' });
          }
        }, 600);
      })
      .catch((err) => {
        if (err && err.admission) {
          // 未入驻 / 已停用：由启动页统一走邀请码校验或准入拦截
          wx.reLaunch({ url: '/pages/launch/launch' });
          return;
        }
        this.setData({ errorMsg: (err && err.message) || '微信授权失败，请重试' });
      })
      .finally(() => {
        this.setData({ loading: false });
      });
  }
});
