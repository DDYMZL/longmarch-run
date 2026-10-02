/**
 * 我的长征（个人档案页）
 * 头部（头像/昵称/组织/参与第 N 天/阶段称号）→ 核心数据 5 格 → 长征进度条
 * → 历史数据区 → 长征足迹时间轴；入口：行军日历。
 */
const app = getApp();
const profile = require('../../services/profile');
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
    timeline: []
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.refresh();
  },

  refresh() {
    Promise.all([profile.getSummary(), profile.getTimeline(50)])
      .then((results) => {
        const summary = results[0];
        const timeline = results[1].map((item) => ({
          eventType: item.eventType,
          text: item.text,
          icon: eventIcon(item.eventType),
          timeText: util.formatTime(item.eventTime)
        }));
        this.setData({
          loading: false,
          errorMsg: '',
          summary,
          stage: stageTitle(summary.stats.progress),
          totalStepsText: util.formatNumber(summary.stats.totalSteps),
          distanceText: summary.stats.totalDistance.toFixed(1),
          timeline
        });
      })
      .catch(() => {
        this.setData({ loading: false, errorMsg: '档案加载失败，请稍后重试' });
      });
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
