/**
 * 组织架构选择（逐级下钻）
 *
 * 交互（面向领导，大按钮、路径清晰）：
 *  - 顶部面包屑显示已下钻路径，点击任意一级可回跳到该层；
 *  - 列表点击组织名 → 进入其下级；点击右侧「选定」→ 直接选择该级组织；
 *  - 无下级的组织点击整行即选定；
 *  - 已下钻到某组织时，顶部提供「选择当前组织」按钮，任意层级均可选中。
 *
 * 入口：首页「选择所属组织」引导（from=home，选填）/ 我的页修改（from=mine）
 */
const app = getApp();
const org = require('../../services/org');
const auth = require('../../services/auth');

Page({
  data: {
    stack: [], // 已下钻路径 [{id, name}]
    list: [], // 当前层级组织列表
    currentId: null, // 当前所处组织 id（stack 末级），null 表示顶级
    currentFullName: '', // 当前所处组织全路径名
    selectedId: null, // 用户已选定的组织 id（回显）
    showNickInput: false, // 首次登录（未改名）时展示微信昵称采集
    nickname: '' // 昵称输入框内容
  },

  onLoad(options) {
    const from = (options && options.from) || '';
    const user = app.globalData.user || {};
    this.setData({
      selectedId: user.orgId || null,
      // 首页引导入口、且尚未使用过改名机会时顺带采集微信名
      showNickInput: from === 'home' && !user.nicknameChangedAt
    });
    this.loadLevel(null);
  },

  /** 加载某层级列表；parentId 为 null 表示顶级 */
  loadLevel(parentId) {
    org
      .getChildren(parentId)
      .then((list) => {
        this.setData({
          list: list,
          currentId: parentId,
          currentFullName: this.data.stack.map((s) => s.name).join(' / ')
        });
      })
      .catch(() => {
        this.setData({ list: [], currentId: parentId, currentFullName: '' });
      });
  },

  /** 点击组织名：有下级则下钻，无下级直接选定 */
  onTapRow(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const hasChildren = e.currentTarget.dataset.has;
    if (hasChildren) {
      this.drillInto(id, name);
    } else {
      this.confirmSelect(id);
    }
  },

  /** 下钻进入某组织的下级 */
  drillInto(id, name) {
    const stack = this.data.stack.concat([{ id: id, name: name }]);
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

  /** 昵称输入框内容变化 */
  onNickInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  /** 确认选定组织：先落昵称（可选）再调后端持久化 + 更新全局用户 + 跳转 */
  confirmSelect(orgId) {
    const nick = (this.data.nickname || '').trim();
    // 昵称设置失败不阻塞组织选择（后端默认昵称兜底）
    const setNick = this.data.showNickInput && nick
      ? auth.setInitialNickname(nick).catch(() => null)
      : Promise.resolve(null);
    setNick
      .then(() => org.select(orgId))
      .then((res) => {
        // 同步本地缓存与全局登录态，供「我的」等页面回显
        const updated = auth.updateLocalUser({
          orgId: res.orgId,
          orgName: res.orgName,
          orgFullName: res.fullName
        });
        if (app.globalData && app.globalData.user && updated) {
          app.globalData.user = updated;
        }
        this.setData({ selectedId: orgId });

        wx.showToast({ title: '已选定组织', icon: 'success' });
        setTimeout(() => {
          this.afterSelect();
        }, 600);
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.message) || '选定失败，请重试', icon: 'none' });
      });
  },

  /** 选定后返回上一页（无上一页时回「我的」） */
  afterSelect() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: '/pages/mine/mine' });
    }
  }
});
