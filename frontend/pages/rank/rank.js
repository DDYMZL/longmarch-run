/**
 * 积分排行榜（V2.0）：全员工总积分榜（与管理端排名同口径）
 * 布局：前 3 名金银铜领奖台 / 第 4~10 名荣誉卡 / 第 11 名起分页列表（触底加载）；
 * 本人在任一区域高亮，名次在 10 名以外时底部常驻「我的名次」条。
 */
const app = getApp();
const rank = require('../../services/rank');

const PAGE_SIZE = 20;
// 领奖台展示顺序：亚军 - 冠军 - 季军
const PODIUM_ORDER = [1, 0, 2];
const MEDALS = ['gold', 'silver', 'bronze'];

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

Page({
  data: {
    loading: true,
    errorMsg: '',
    podium: [],
    elite: [],
    list: [],
    me: null,
    total: 0,
    hasMore: false,
    loadingMore: false
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    this.refresh();
  },

  /** 重新拉取第 1 页（前 10 名 + 第 11 名起首页 + 本人） */
  refresh() {
    const requestId = (this._requestId || 0) + 1;
    this._requestId = requestId;
    return rank
      .getPointsRank(1, PAGE_SIZE)
      .then((r) => {
        if (requestId !== this._requestId) return;
        const top = r.top.map(toView);
        this._page = 1;
        this.setData({
          loading: false,
          errorMsg: '',
          podium: PODIUM_ORDER.filter((i) => top[i]).map((i) => Object.assign({ medal: MEDALS[i] }, top[i])),
          elite: top.slice(3),
          list: r.list.map(toView),
          me: r.me ? toView(r.me) : null,
          total: r.total,
          hasMore: r.hasMore
        });
      })
      .catch((err) => {
        if (requestId !== this._requestId) return;
        // 已有榜单时保留旧数据只提示；首屏失败展示错误态
        if (this.data.podium.length || this.data.list.length) {
          wx.showToast({ title: '排行榜刷新失败，请稍后重试', icon: 'none' });
          this.setData({ loading: false });
        } else {
          this.setData({ loading: false, errorMsg: (err && err.message) || '排行榜加载失败' });
        }
      });
  },

  /** 触底加载第 11 名起的下一页（追加写入，避免整表 setData） */
  onReachBottom() {
    const { hasMore, loadingMore, loading } = this.data;
    if (!hasMore || loadingMore || loading) return;
    const nextPage = this._page + 1;
    const requestId = this._requestId;
    this.setData({ loadingMore: true });
    rank
      .getPointsRank(nextPage, PAGE_SIZE)
      .then((r) => {
        if (requestId !== this._requestId) return;
        this._page = nextPage;
        const start = this.data.list.length;
        const patch = { hasMore: r.hasMore, loadingMore: false };
        r.list.forEach((item, i) => {
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
  }
});
