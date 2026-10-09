/**
 * 账号与绑定：已绑定身份列表 + 解绑（wx_mini 登录凭证不可解绑）。
 */
const app = getApp();
const identity = require('../../services/identity');

/** 渠道展示名映射 */
const PROVIDER_NAMES = {
  wx_mini: '微信小程序',
  wx_web: '微信网页授权'
};

/** 时间格式化（后端 ISO 字符串 -> YYYY-MM-DD HH:mm），无 WXML 方法调用 */
function formatTime(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').slice(0, 16);
}

Page({
  data: {
    loading: true,
    identities: [],
    empty: false
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.loadList();
  },

  loadList() {
    this.setData({ loading: true });
    identity
      .listIdentities()
      .then((rows) => {
        const items = (rows || []).map((row) => ({
          id: row.id,
          provider: row.provider,
          providerName: PROVIDER_NAMES[row.provider] || row.provider,
          appId: row.appId,
          isPrimary: row.provider === 'wx_mini',
          verifiedAt: formatTime(row.verifiedAt),
          createdAt: formatTime(row.createdAt)
        }));
        this.setData({ identities: items, empty: items.length === 0, loading: false });
      })
      .catch((err) => {
        this.setData({ loading: false });
        wx.showToast({ title: (err && err.message) || '加载失败，请重试', icon: 'none' });
      });
  },

  /** 解绑确认（主身份按钮不在页面渲染，此处兜底拦截） */
  handleUnbind(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const item = this.data.identities.find((x) => x.id === id);
    if (!item) return;
    if (item.isPrimary) {
      wx.showToast({ title: '微信登录凭证不可解绑', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '解绑确认',
      content: '确定解绑「' + name + '」吗？解绑后该身份将无法用于登录 PC 端管理后台。',
      confirmColor: '#C8102E',
      success: (res) => {
        if (!res.confirm) return;
        identity
          .unbind(id)
          .then(() => {
            wx.showToast({ title: '已解绑', icon: 'success' });
            this.loadList();
          })
          .catch((err) => {
            wx.showToast({ title: (err && err.message) || '解绑失败，请重试', icon: 'none' });
          });
      }
    });
  }
});
