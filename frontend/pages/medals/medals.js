/**
 * 勋章墙：按分类分组展示（入门/路线/挑战/完成），
 * 隐藏且未获得的勋章显示 🔒 神秘态，点击弹出详情（名称/获得时间/获得条件）。
 */
const app = getApp();
const medal = require('../../services/medal');
const util = require('../../utils/util');

/** 分类展示顺序 */
const CATEGORY_ORDER = [
  { key: 'starter', name: '入门勋章' },
  { key: 'route', name: '路线勋章' },
  { key: 'challenge', name: '挑战勋章' },
  { key: 'complete', name: '完成勋章' }
];

Page({
  data: {
    groups: [],
    ownedCount: 0,
    totalCount: 0,
    selected: null
  },

  onShow() {
    // 未登录保护
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.refresh();
  },

  refresh() {
    // 后端勋章列表接口会自动评估发放，直接读取
    medal
      .getMedalList()
      .then((list) => {
        const sorted = list.slice().sort((a, b) => a.sortOrder - b.sortOrder);
        const groups = CATEGORY_ORDER.map((cat) => ({
          key: cat.key,
          name: cat.name,
          medals: sorted
            .filter((m) => m.category === cat.key)
            .map((m) => this.toDisplay(m))
        })).filter((g) => g.medals.length > 0);

        // 未知分类兜底（未来新增分类时仍能展示）
        const known = CATEGORY_ORDER.map((c) => c.key);
        const rest = sorted.filter((m) => known.indexOf(m.category) < 0).map((m) => this.toDisplay(m));
        if (rest.length > 0) {
          groups.push({ key: 'other', name: '其他勋章', medals: rest });
        }

        this.setData({
          groups,
          ownedCount: list.filter((m) => m.owned).length,
          totalCount: list.length
        });
      })
      .catch(() => {
        this.setData({ groups: [], ownedCount: 0, totalCount: 0 });
      });
  },

  /**
   * 展示态：隐藏且未获得 -> 🔒 神秘勋章（条件不公开）
   */
  toDisplay(m) {
    const locked = m.hidden && !m.owned;
    return {
      id: m.id,
      owned: m.owned,
      hidden: m.hidden,
      locked,
      icon: locked ? '🔒' : m.icon,
      name: locked ? '神秘勋章' : m.name,
      desc: m.conditionDesc || m.desc,
      grantedText: m.owned && m.grantedAt ? util.formatTime(m.grantedAt) : ''
    };
  },

  /**
   * 点击勋章 -> 详情弹层
   */
  handleMedalTap(e) {
    const item = e.currentTarget.dataset.item;
    if (!item) return;
    this.setData({ selected: item });
  },

  closeDetail() {
    this.setData({ selected: null });
  },

  noop() {}
});
