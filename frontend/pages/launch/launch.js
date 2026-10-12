/**
 * 启动页：扫码入驻入口 + 已入驻用户自动登录
 *
 * 入口参数：
 *  - options.scene：小程序码扫描场景字符串（经 URL 编码），形如 `i=CODE`
 *  - options.invite：预览/测试环境直传邀请码
 *  - options.redirect：旧有的扫码确认流程回跳目标
 *
 * 流程：
 *  1. wx.login 调 /auth/login 识别微信身份。
 *  2. active → 直接进入首页（或 redirect 原页）。
 *  3. disabled → 显示停用拦截。
 *  4. unregistered + 有效邀请码 → 跳入驻页；无邀请码或邀请码不可用 → 显示准入拦截。
 */
const auth = require('../../services/auth');

const HOME_PAGE = '/pages/home/home';
const ONBOARD_PAGE = '/pages/onboard/onboard';
const DISABLED_MSG = '账号已停用，请联系活动管理员';
const BLOCKED_MSG = '当前小程序仅对受邀人员开放，请联系活动管理员获取有效入驻二维码。';

/** 从场景串 `i=CODE` 中提取邀请码；兼容 `?i=CODE` / `i%3DCODE`。 */
function parseInviteFromScene(scene) {
  if (!scene) return '';
  let text = '';
  try {
    text = decodeURIComponent(scene);
  } catch (e) {
    text = scene;
  }
  const match = /(?:^|[?&])i=([A-Za-z0-9]{1,32})/.exec(text);
  return match ? match[1] : '';
}

Page({
  data: {
    phase: 'loading', // loading / blocked / disabled
    message: '正在进入长征…',
    errorMsg: ''
  },

  onLoad(options) {
    const opts = options || {};
    this.redirect = decodeURIComponent(opts.redirect || '');
    const scene = opts.scene || '';
    const inviteFromOpts = (opts.invite || '').trim();
    const inviteFromScene = parseInviteFromScene(scene);
    this.inviteCode = inviteFromOpts || inviteFromScene || '';
    this.start();
  },

  start() {
    this.setData({ phase: 'loading', errorMsg: '', message: '正在进入长征…' });
    auth
      .ensureLogin()
      .then(() => this.enterHome())
      .catch((err) => this.handleEnsureError(err));
  },

  handleEnsureError(err) {
    if (err && err.loggedOut) {
      const query = this.redirect ? '?redirect=' + encodeURIComponent(this.redirect) : '';
      wx.redirectTo({ url: '/pages/login/login' + query });
      return;
    }
    if (err && err.admission === 'disabled') {
      this.setData({ phase: 'disabled', message: DISABLED_MSG });
      return;
    }
    if (err && err.admission === 'unregistered') {
      this.handleUnregistered();
      return;
    }
    const network = err && err.network;
    const msg = network ? '网络异常，请检查网络后重试' : (err && err.message) || '登录失败，请重试';
    this.setData({ phase: 'blocked', message: msg, errorMsg: msg });
  },

  /** 未入驻：带邀请码则校验后跳入驻页；无码或邀请码不可用显示准入拦截。 */
  handleUnregistered() {
    if (!this.inviteCode) {
      this.setData({ phase: 'blocked', message: BLOCKED_MSG });
      return;
    }
    this.setData({ phase: 'loading', message: '正在校验邀请码…' });
    auth
      .verifyInvite(this.inviteCode)
      .then((info) => {
        auth.savePendingInvite({ code: this.inviteCode, orgId: info.orgId || null, orgName: info.orgName || '' });
        const q = 'invite=' + encodeURIComponent(this.inviteCode);
        const scope = info.orgId ? '&rootId=' + info.orgId + '&rootName=' + encodeURIComponent(info.orgName || '') : '';
        wx.redirectTo({ url: ONBOARD_PAGE + '?' + q + scope });
      })
      .catch((err) => {
        auth.clearPendingInvite();
        if (err && err.statusCode === 400) {
          this.setData({ phase: 'blocked', message: (err && err.message) || BLOCKED_MSG });
          return;
        }
        const msg = err && err.network ? '网络异常，请检查网络后重试' : (err && err.message) || BLOCKED_MSG;
        this.setData({ phase: 'blocked', message: msg });
      });
  },

  enterHome() {
    if (!this.redirect) {
      wx.switchTab({ url: HOME_PAGE });
      return;
    }
    const target = this.redirect;
    wx.redirectTo({
      url: target,
      fail: () => wx.switchTab({ url: target.split('?')[0], fail: () => wx.switchTab({ url: HOME_PAGE }) })
    });
  },

  onRetry() {
    if (this.data.phase === 'loading') return;
    this.start();
  },

  /** 重新扫码：解析扫出的二维码路径，取其中的 scene 作为新邀请码。 */
  onRescan() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => {
        const path = (res && (res.path || res.result)) || '';
        let invite = '';
        const m = /[?&]scene=([^&]+)/.exec(path);
        if (m) invite = parseInviteFromScene(m[1]);
        if (!invite) {
          const direct = /[?&]invite=([A-Za-z0-9]{1,32})/.exec(path);
          if (direct) invite = direct[1];
        }
        if (!invite) {
          wx.showToast({ title: '未识别到有效邀请码', icon: 'none' });
          return;
        }
        this.inviteCode = invite;
        this.start();
      },
      fail: () => wx.showToast({ title: '扫码已取消', icon: 'none' })
    });
  },

  onExit() {
    try {
      wx.exitMiniProgram({ fail: () => wx.navigateBack({ fail: () => {} }) });
    } catch (e) {
      // 兼容未实现 exitMiniProgram 的基础库版本
    }
  }
});
