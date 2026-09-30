/**
 * 组织架构选择（逐级下钻）
 *
 * 交互（面向领导，大按钮、路径清晰）：
 *  - 顶部面包屑显示已下钻路径，点击任意一级可回跳到该层；
 *  - 列表点击组织名 → 进入其下级；点击右侧「选定」→ 直接选择该级组织；
 *  - 无下级的组织点击整行即选定；
 *  - 已下钻到某组织时，顶部提供「选择当前组织」按钮，任意层级均可选中。
 *
 * 入口：登录后（from=login，未选组织时强制）/ 我的页修改（from=mine）
 */
const app = getApp();
const org = require('../../services/org');

Page({
  data: {
    from: '',
    stack: [], // 已下钻路径 [{id, name}]
    list: [], // 当前层级组织列表
    currentId: null, // 当前所处组织 id（stack 末级），null 表示顶级
    currentFullName: '', // 当前所处组织全路径名
    selectedId: null // 用户已选定的组织 id（回显）
  },

  onLoad(options) {
    const from = (options && options.from) || '';
    const user = app.globalData.user || {};
    this.setData({ from: from, selectedId: user.orgId || null });
    this.loadLevel(null);
  },

  /** 加载某层级列表；parentId 为 null 表示顶级 */
  loadLevel(parentId) {
    const list = org.getChildren(parentId);
    this.setData({
      list: list,
      currentId: parentId,
      currentFullName: parentId ? org.getFullName(parentId) : ''
    });
  },

  /** 点击组织名：有下级则下钻，无下级直接选定 */
  onTapRow(e) {
    const id = e.currentTarget.dataset.id;
    const hasChildren = e.currentTarget.dataset.has;
    if (hasChildren) {
      this.drillInto(id);
    } else {
      this.confirmSelect(id);
    }
  },

  /** 下钻进入某组织的下级 */
  drillInto(id) {
    const node = org.getOrg(id);
    if (!node) return;
    const stack = this.data.stack.concat([{ id: node.id, name: node.name }]);
    this.setData({ stack: stack });
    this.loadLevel(id);
  },

  /** 点击右侧「选定」：直接选择该级组织 */
  onTapSelect(e) {
    const id = e.currentTarget.dataset.id;
    this.confirmSelect(id);
  },

  /** 点击面包屑回跳到某一级；index = -1 表示回到顶级 */
  onTapCrumb(e) {
    const index = Number(e.currentTarget.dataset.index);
    let stack;
    if (index < 0) {
      stack = [];
    } else {
      stack = this.data.stack.slice(0, index + 1);
    }
    this.setData({ stack: stack });
    this.loadLevel(stack.length ? stack[stack.length - 1].id : null);
  },

  /** 选择当前正在浏览的组织（顶部按钮） */
  onSelectCurrent() {
    if (this.data.currentId) {
      this.confirmSelect(this.data.currentId);
    }
  },

  /** 确认选定组织：持久化 + 更新全局用户 + 跳转 */
  confirmSelect(orgId) {
    const updated = org.setUserOrg(orgId);
    // 同步全局登录态，供「我的」等页面回显
    if (app.globalData && app.globalData.user) {
      app.globalData.user = updated;
    }
    this.setData({ selectedId: orgId });

    wx.showToast({ title: '已选定组织', icon: 'success' });
    setTimeout(() => {
      this.afterSelect();
    }, 600);
  },

  /** 选定后的跳转：登录流程进首页，其余返回上一页 */
  afterSelect() {
    if (this.data.from === 'login') {
      wx.switchTab({ url: '/pages/home/home' });
      return;
    }
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: '/pages/mine/mine' });
    }
  }
});
