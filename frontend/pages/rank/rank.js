/**
 * 积分排行榜（V2.0）：员工总积分榜 / 部门榜（与管理端排名同口径）
 * 布局：前 3 名金银铜领奖台 / 第 4~10 名荣誉卡 / 第 11 名起分页列表（触底加载）；
 * 本人在任一区域高亮，名次在 10 名以外时底部常驻「我的名次」条。
 * B7 增强：
 *   - scope 切换「全员 / 我的部门」（个人榜按组织过滤）；
 *   - tab 切换「个人榜 / 部门榜」（部门榜为组织聚合排名）；
 *   - 点击领奖台/荣誉卡/列表项弹出用户卡抽屉（GET /rank/user/{id}）；
 *   - onShow 订阅 WS，收到 sport.sync/quiz.answer/march.light-up 防抖静默刷新，onHide 退订。
 */
const app = getApp();
const rank = require('../../services/rank');
const ws = require('../../services/ws');

const PAGE_SIZE = 20;
// 领奖台展示顺序：亚军 - 冠军 - 季军
const PODIUM_ORDER = [1, 0, 2];
const MEDALS = ['gold', 'silver', 'bronze'];
// 触发静默刷新的推送类型
const REFRESH_TYPES = ['sport.sync', 'quiz.answer', 'march.light-up'];
const WS_DEBOUNCE = 1200;

/** 榜单项 -> 展示字段（只保留渲染所需，减小 setData 体积） */
function toView(item) {
  return {
    userId: item.userId,
    rank: item.rank,
    nickname: item.nickname,
    avatar: item.avatar,
    initial: (item.nickname || '跑').slice(0, 1),
    orgName: item.orgName || '未选择组织',
    points: item.points,
    walkPoints: item.walkPoints,
    quizPoints: item.quizPoints,
    isMe: item.isMe
  };
}

/** 部门榜项 -> 展示字段 */
function toOrgView(item, index) {
  return {
    orgId: item.orgId,
    rank: index + 1,
    orgName: item.orgName || '未命名部门',
    memberCount: item.memberCount || 0,
    totalSteps: item.totalSteps || 0,
    avgPoints: item.avgPoints || 0,
    litNodes: item.litNodes || 0
  };
}

Page({
  data: {
    loading: true,
    errorMsg: '',
    // 视图维度：tab=person 个人榜 / org 部门榜；scope=all 全员 / org 我的部门（仅个人榜）
    tab: 'person',
    scope: 'all',
    // 当前用户是否有组织：无组织时禁用「我的部门」范围切换（后端 scope=org 会 403/降级）
    hasOrg: false,
    // 个人榜
    podium: [],
    elite: [],
    list: [],
    me: null,
    total: 0,
    hasMore: false,
    loadingMore: false,
    // 部门榜
    orgList: [],
    // 用户卡抽屉
    showUserCard: false,
    userCardLoading: false,
    userCard: null
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    const u = app.globalData.user || {};
    this.setData({ hasOrg: !!(u.orgId) });
    if (!this._wsUnsub) {
      this._wsUnsub = ws.subscribe((msg) => this.handleWsMessage(msg));
    }
    this.refresh();
  },

  onHide() {
    if (this._wsTimer) { clearTimeout(this._wsTimer); this._wsTimer = null; }
    if (this._wsUnsub) { this._wsUnsub(); this._wsUnsub = null; }
  },

  onUnload() {
    if (this._wsTimer) { clearTimeout(this._wsTimer); this._wsTimer = null; }
    if (this._wsUnsub) { this._wsUnsub(); this._wsUnsub = null; }
  },

  /**
   * WS 推送：运动同步 / 答题 / 点亮节点均会影响积分排名，
   * 防抖后静默刷新（不展示 loading，避免打断浏览）。
   */
  handleWsMessage(msg) {
    if (!msg || REFRESH_TYPES.indexOf(msg.type) === -1) return;
    if (this._wsTimer) clearTimeout(this._wsTimer);
    this._wsTimer = setTimeout(() => {
      this._wsTimer = null;
      this.refresh(true);
    }, WS_DEBOUNCE);
  },

  /**
   * 重新拉取当前维度数据。
   * @param {boolean} [silent] 静默刷新（不置 loading，WS 触发时用）
   */
  refresh(silent) {
    if (this.data.tab === 'org') return this.loadOrgRank(silent);
    return this.loadPersonRank(silent);
  },

  /** 个人榜：前 10 名 + 第 11 名起首页 + 本人（按 scope 过滤） */
  loadPersonRank(silent) {
    const requestId = (this._requestId || 0) + 1;
    this._requestId = requestId;
    if (!silent) this.setData({ loading: true });
    const opts = { scope: this.data.scope };
    return rank
      .getPointsRank(1, PAGE_SIZE, opts)
      .then((r) => {
        if (requestId !== this._requestId) return;
        const top = (r.top || []).map(toView);
        this._page = 1;
        const patch = {
          loading: false,
          errorMsg: '',
          podium: PODIUM_ORDER.filter((i) => top[i]).map((i) => Object.assign({ medal: MEDALS[i] }, top[i])),
          elite: top.slice(3),
          list: (r.list || []).map(toView),
          me: r.me ? toView(r.me) : null,
          total: r.total,
          hasMore: r.hasMore
        };
        // 后端可能因用户无组织把 scope=org 降级为 all：以 scopeApplied 为准回写，保证范围文案/高亮一致
        if (r.scopeApplied && r.scopeApplied !== this.data.scope) patch.scope = r.scopeApplied;
        this.setData(patch);
      })
      .catch((err) => {
        if (requestId !== this._requestId) return;
        // 已有榜单时保留旧数据只提示；首屏失败展示错误态
        if (this.data.podium.length || this.data.list.length) {
          if (!silent) wx.showToast({ title: '排行榜刷新失败，请稍后重试', icon: 'none' });
          this.setData({ loading: false });
        } else {
          this.setData({ loading: false, errorMsg: (err && err.message) || '排行榜加载失败' });
        }
      });
  },

  /** 部门榜：组织聚合排名 */
  loadOrgRank(silent) {
    const requestId = (this._requestId || 0) + 1;
    this._requestId = requestId;
    if (!silent) this.setData({ loading: true });
    return rank
      .getOrgRank()
      .then((r) => {
        if (requestId !== this._requestId) return;
        this.setData({
          loading: false,
          errorMsg: '',
          orgList: (r.items || []).map(toOrgView)
        });
      })
      .catch((err) => {
        if (requestId !== this._requestId) return;
        if (this.data.orgList.length) {
          if (!silent) wx.showToast({ title: '部门榜刷新失败，请稍后重试', icon: 'none' });
          this.setData({ loading: false });
        } else {
          this.setData({ loading: false, errorMsg: (err && err.message) || '部门榜加载失败' });
        }
      });
  },

  /** 切换个人榜 / 部门榜 */
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.tab) return;
    this.setData({ tab, errorMsg: '' });
    this.refresh();
  },

  /** 切换全员 / 我的部门（仅个人榜）；无组织时禁止切到「我的部门」，避免后端 403 */
  switchScope(e) {
    const scope = e.currentTarget.dataset.scope;
    if (!scope || scope === this.data.scope || this.data.tab !== 'person') return;
    if (scope === 'org' && !this.data.hasOrg) {
      wx.showToast({ title: '你还未选择部门', icon: 'none' });
      return;
    }
    this.setData({ scope, errorMsg: '' });
    this.refresh();
  },

  /** 触底加载第 11 名起的下一页（追加写入，避免整表 setData；仅个人榜） */
  onReachBottom() {
    if (this.data.tab !== 'person') return;
    const { hasMore, loadingMore, loading } = this.data;
    if (!hasMore || loadingMore || loading) return;
    const nextPage = this._page + 1;
    const requestId = this._requestId;
    this.setData({ loadingMore: true });
    rank
      .getPointsRank(nextPage, PAGE_SIZE, { scope: this.data.scope })
      .then((r) => {
        if (requestId !== this._requestId) return;
        this._page = nextPage;
        const start = this.data.list.length;
        const patch = { hasMore: r.hasMore, loadingMore: false };
        (r.list || []).forEach((item, i) => {
          patch['list[' + (start + i) + ']'] = toView(item);
        });
        this.setData(patch);
      })
      .catch(() => {
        this.setData({ loadingMore: false });
        wx.showToast({ title: '加载失败，请上拉重试', icon: 'none' });
      });
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  handleRetry() {
    this.setData({ loading: true, errorMsg: '' });
    this.refresh();
  },

  /** 点击榜单项 / 领奖台 / 荣誉卡：拉取用户卡并弹出抽屉 */
  openUserCard(e) {
    const userId = e.currentTarget.dataset.userid;
    if (!userId) return;
    this.setData({ showUserCard: true, userCardLoading: true, userCard: null });
    rank
      .getUserCard(userId)
      .then((card) => {
        this.setData({
          userCardLoading: false,
          userCard: {
            nickname: card.nickname || '长征小战士',
            avatar: card.avatar || '',
            initial: (card.nickname || '跑').slice(0, 1),
            orgName: card.orgName || '未选择组织',
            points: card.points || 0,
            steps: card.steps || 0,
            litNodes: card.litNodes || 0,
            medalCount: card.medalCount || 0,
            rank: card.rank || 0
          }
        });
      })
      .catch((err) => {
        this.setData({ userCardLoading: false, showUserCard: false });
        const code = err && err.statusCode;
        // 越权/不存在（后端 /rank/user 越权返回 404，或无权限 403）：优雅兜底提示，不崩溃
        const msg = (code === 404 || code === 403)
          ? '暂无该用户的排行信息'
          : ((err && err.message) || '用户信息加载失败');
        wx.showToast({ title: msg, icon: 'none' });
      });
  },

  closeUserCard() {
    this.setData({ showUserCard: false });
  },

  noop() {}
});
