/**
 * 入驻页：扫码验证通过后填写姓名与组织，提交 /auth/onboard 建号并签发 Token。
 * 组织范围：邀请码带 orgId 的只能在该组织及其下级中选择，由 org-select 的 pick 模式限制。
 */
const auth = require('../../services/auth');

Page({
  data: {
    inviteCode: '',
    nickname: '',
    orgId: null,
    orgName: '',
    orgFullName: '',
    rootId: null,
    rootName: '',
    submitting: false,
    errorMsg: ''
  },

  onLoad(options) {
    const opts = options || {};
    const invite = (opts.invite || '').trim();
    const pending = auth.readPendingInvite() || {};
    const inviteCode = invite || pending.code || '';
    if (!inviteCode) {
      // 直接访问入驻页时，没有邀请码无法入驻，退回启动页由其显示准入拦截
      wx.redirectTo({ url: '/pages/launch/launch' });
      return;
    }
    const rootId = opts.rootId ? Number(opts.rootId) : pending.orgId || null;
    const rootName = decodeURIComponent(opts.rootName || '') || pending.orgName || '';
    this.setData({
      inviteCode: inviteCode,
      rootId: rootId,
      rootName: rootName,
      // 专属邀请码：默认先选定组织范围根（后端允许，可在下级继续细化）
      orgId: rootId,
      orgName: rootName,
      orgFullName: rootName
    });
  },

  onNickInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  /** 打开组织选择器（pick 模式；通过 eventChannel 回传选定结果） */
  onPickOrg() {
    const self = this;
    const query = this.data.rootId
      ? '?from=onboard&rootId=' + this.data.rootId + '&rootName=' + encodeURIComponent(this.data.rootName || '')
      : '?from=onboard';
    wx.navigateTo({
      url: '/pages/org-select/org-select' + query,
      events: {
        orgPicked(res) {
          self.setData({
            orgId: res.orgId,
            orgName: res.orgName || res.orgFullName,
            orgFullName: res.orgFullName
          });
        }
      }
    });
  },

  onSubmit() {
    if (this.data.submitting) return;
    const nickname = (this.data.nickname || '').trim();
    if (!nickname) {
      this.setData({ errorMsg: '请填写姓名' });
      return;
    }
    if (!this.data.orgId) {
      this.setData({ errorMsg: '请选择所属组织' });
      return;
    }
    this.setData({ submitting: true, errorMsg: '' });
    auth
      .onboard({
        inviteCode: this.data.inviteCode,
        nickname: nickname,
        orgId: this.data.orgId,
        avatar: ''
      })
      .then((res) => {
        auth.updateLocalUser({
          orgId: this.data.orgId,
          orgName: this.data.orgName,
          orgFullName: this.data.orgFullName
        });
        wx.showToast({ title: res.created ? '入驻成功' : '欢迎回来', icon: 'success' });
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 600);
      })
      .catch((err) => {
        this.setData({
          submitting: false,
          errorMsg: (err && err.message) || '入驻失败，请重试'
        });
      });
  },

  onCancel() {
    auth.clearPendingInvite();
    wx.redirectTo({ url: '/pages/launch/launch' });
  }
});
