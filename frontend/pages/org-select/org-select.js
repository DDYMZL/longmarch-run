/**
 * 组织架构选择（逐级下钻）
 *
 * 交互（面向领导，大按钮、路径清晰）：
 *  - 顶部面包屑显示已下钻路径，点击任意一级可回跳到该层；
 *  - 列表点击组织名 → 进入其下级；点击右侧「选定」→ 直接选择该级组织；
 *  - 无下级的组织点击整行即选定；
 *  - 已下钻到某组织时，顶部提供「选择当前组织」按钮，任意层级均可选中。
 *
 * 入口：首页「选择所属组织」引导（from=home，选填）/ 我的页（from=mine）/ 入驻页（from=onboard，仅回传）
 * 组织首次选定后锁定：再次进入只读展示，提示联系管理员调整。
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
    rootId: null, // pick 模式下的组织范围根 id，限制不得越界
    showNickInput: false, // 首次登录（未改名）时展示微信昵称采集
    nickname: '', // 昵称输入框内容
    locked: false, // 已选定组织：只读，调整需联系管理员
    lockedName: ''
  },

  onLoad(options) {
    const opts = options || {};
    const from = opts.from || '';
    this.pickMode = from === 'onboard';
    this.rootId = opts.rootId ? Number(opts.rootId) : null;
    const rootName = decodeURIComponent(opts.rootName || '');
    if (this.pickMode) {
      // 入驻场景尚未登录：不读 app.globalData、不采集昵称，仅通过 eventChannel 回传选定结果
      const initialStack = this.rootId ? [{ id: this.rootId, name: rootName || '所属组织' }] : [];
      this.setData({ stack: initialStack, showNickInput: false, selectedId: null, rootId: this.rootId });
      this.loadLevel(this.rootId || null);
      return;
    }
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    const user = app.globalData.user || {};
    this.setData({
      selectedId: user.orgId || null,
      showNickInput: from === 'home' && !user.nicknameChangedAt
    });
    // 组织选定后锁定：已锁定只读展示，未锁定才加载选择列表（后端同样拒绝二次修改）
    org
      .getMine()
      .then((mine) => {
        if (!mine.locked) {
          this.loadLevel(null);
          return;
        }
        auth.updateLocalUser({ orgId: mine.orgId, orgName: mine.orgName, orgFullName: mine.fullName });
        this.setData({ locked: true, lockedName: mine.fullName || mine.orgName, showNickInput: false });
      })
      .catch(() => this.loadLevel(null));
  },

  /** 加载某层级列表；parentId 为 null 表示顶级（快速连点下钻/回跳时只采纳最后一次请求） */
  loadLevel(parentId) {
    const requestId = (this._levelRequestId || 0) + 1;
    this._levelRequestId = requestId;
    org
      .getChildren(parentId)
      .then((list) => {
        if (requestId !== this._levelRequestId) return;
        this.setData({
          list: list,
          currentId: parentId,
          currentFullName: this.data.stack.map((s) => s.name).join(' / ')
        });
      })
      .catch(() => {
        if (requestId !== this._levelRequestId) return;
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

  /** 点击面包屑回跳到某一级；pick 模式下不允许回到 rootId 之上 */
  onTapCrumb(e) {
    const index = Number(e.currentTarget.dataset.index);
    const minIndex = this.pickMode && this.rootId ? 0 : -1;
    const safeIndex = Math.max(index, minIndex);
    let stack;
    if (safeIndex < 0) {
      stack = [];
    } else {
      stack = this.data.stack.slice(0, safeIndex + 1);
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

  /** 确认选定组织：pick 模式仅回传给入驻页；其余模式按原逻辑调后端持久化 */
  confirmSelect(orgId) {
    if (this._selecting) return;
    this._selecting = true;
    if (this.pickMode) {
      const node = this.findNode(orgId);
      const fullName = this.data.stack
        .concat(this.data.currentId === orgId ? [] : [{ id: orgId, name: node ? node.name : '' }])
        .map((s) => s.name)
        .filter(Boolean)
        .join(' / ');
      const channel = this.getOpenerEventChannel && this.getOpenerEventChannel();
      if (channel && channel.emit) {
        channel.emit('orgPicked', { orgId: orgId, orgName: node ? node.name : fullName, orgFullName: fullName });
      }
      wx.navigateBack();
      return;
    }
    const nick = (this.data.nickname || '').trim();
    const setNick = this.data.showNickInput && nick
      ? auth.setInitialNickname(nick).catch(() => null)
      : Promise.resolve(null);
    setNick
      .then(() => org.select(orgId))
      .then((res) => {
        auth.updateLocalUser({
          orgId: res.orgId,
          orgName: res.orgName,
          orgFullName: res.fullName
        });
        this.setData({ selectedId: orgId });
        wx.showToast({ title: '已选定组织', icon: 'success' });
        setTimeout(() => this.afterSelect(), 600);
      })
      .catch((err) => {
        this._selecting = false;
        wx.showToast({ title: (err && err.message) || '选定失败，请重试', icon: 'none' });
      });
  },

  findNode(orgId) {
    const list = this.data.list || [];
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].id === orgId) return list[i];
    }
    // 选当前层级：从 stack 末尾取
    const stack = this.data.stack || [];
    if (stack.length && stack[stack.length - 1].id === orgId) return stack[stack.length - 1];
    return null;
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
