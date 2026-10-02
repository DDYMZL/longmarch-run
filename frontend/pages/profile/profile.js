/**
 * 我的长征（个人档案页）
 * 头部（头像/昵称/组织/参与第 N 天/阶段称号）→ 核心数据 5 格 → 长征进度条
 * → 足迹地图（§7 时间+路线结合，点击节点看抵达详情）→ 历史数据区 → 长征足迹时间轴；
 * 入口：行军日历。
 */
const app = getApp();
const profile = require('../../services/profile');
const march = require('../../services/march');
const util = require('../../utils/util');

/** 阶段称号：按点亮进度划分 */
function stageTitle(progress) {
  if (progress >= 100) return '长征先锋';
  if (progress >= 60) return '铁血战士';
  if (progress >= 30) return '行军骨干';
  return '红军新兵';
}

/** 事件图标（时间轴按类型区分） */
const EVENT_ICONS = {
  FIRST_STEP: '🏃',
  DAILY_GOAL: '🎯',
  NODE_UNLOCK: '⭐',
  BADGE_UNLOCK: '🏅',
  QUIZ_COMPLETE: '📝',
  QUIZ_FULL_SCORE: '💯',
  STEP_10000: '👟',
  TOTAL_STEPS_100000: '🎖️',
  TOTAL_STEPS_500000: '💪',
  COMPLETE_ROUTE: '🏆'
};

function eventIcon(eventType) {
  if (EVENT_ICONS[eventType]) return EVENT_ICONS[eventType];
  if (eventType && eventType.indexOf('STREAK_') === 0) return '🔥';
  return '📌';
}

Page({
  data: {
    loading: true,
    errorMsg: '',
    summary: null,
    stage: '',
    totalStepsText: '0',
    distanceText: '0',
    timeline: [],
    // 足迹地图（P1-6，需求 §7）：已点亮节点链 + 展开详情
    footprints: [],
    fpSelected: 0
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.refresh();
  },

  refresh() {
    Promise.all([
      profile.getSummary(),
      profile.getTimeline(50),
      march.getFootprints().catch(() => null) // 足迹地图失败不阻塞档案主数据
    ])
      .then((results) => {
        const summary = results[0];
        const timeline = results[1].map((item) => ({
          eventType: item.eventType,
          text: item.text,
          icon: eventIcon(item.eventType),
          timeText: util.formatTime(item.eventTime)
        }));
        const fpData = results[2];
        // 足迹地图（§7.2/§7.3）：视图模型预格式化，累计快照为 0（历史回填）时展示 —
        const footprints = fpData === null ? [] : (fpData.nodes || []).map((n, i, arr) => ({
          id: n.id,
          name: n.name,
          icon: n.icon,
          litDate: n.litDate,
          dayStepsText: util.formatNumber(n.daySteps),
          cumStepsText: n.cumSteps > 0 ? util.formatNumber(n.cumSteps) : '—',
          isLast: i === arr.length - 1
        }));
        this.setData({
          loading: false,
          errorMsg: '',
          summary,
          stage: stageTitle(summary.stats.progress),
          totalStepsText: util.formatNumber(summary.stats.totalSteps),
          distanceText: summary.stats.totalDistance.toFixed(1),
          timeline,
          footprints
        });
      })
      .catch(() => {
        this.setData({ loading: false, errorMsg: '档案加载失败，请稍后重试' });
      });
  },

  /** 足迹地图：点击节点展开/收起抵达详情（§7.3） */
  toggleFootprint(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ fpSelected: this.data.fpSelected === id ? 0 : id });
  },

  goCalendar() {
    wx.navigateTo({ url: '/pages/calendar/calendar' });
  },

  goNodeDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/node-detail/node-detail?id=' + id });
  }
});
