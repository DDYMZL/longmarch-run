/**
 * 答题 Tab
 * 状态：今日未完成（开始答题）/ 已完成（展示得分）/ 无题目（异常场景）
 */
const app = getApp();
const quiz = require('../../services/quiz');

Page({
  data: {
    completed: false,
    record: null,
    loading: true,
    errorMsg: ''
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.refresh();
  },

  refresh() {
    const userId = app.globalData.user.id;
    try {
      const daily = quiz.getDaily(userId);
      this.setData({
        completed: daily.completed,
        record: daily.record,
        loading: false,
        errorMsg: daily.questions === null && !daily.completed ? '今日题目正在准备中，请稍后再来。' : ''
      });
    } catch (e) {
      this.setData({ loading: false, errorMsg: '网络连接异常，请检查网络后重试。' });
    }
  },

  /**
   * 开始答题
   */
  handleStart() {
    wx.navigateTo({ url: '/pages/quiz-answer/quiz-answer' });
  },

  /**
   * 已完成状态：明天再来
   */
  handleTomorrow() {
    wx.showToast({ title: '每天只能完成一次正式答题哦', icon: 'none' });
  },

  /**
   * 开发调试：重置今日答题
   */
  handleResetToday() {
    wx.showModal({
      title: '开发调试',
      content: '确定重置今日答题吗？将清除今日答题记录、题目缓存与相关积分，可重新答题。',
      confirmColor: '#C8102E',
      success: (res) => {
        if (res.confirm) {
          quiz.resetToday(app.globalData.user.id);
          this.refresh();
          wx.showToast({ title: '已重置今日答题', icon: 'success' });
        }
      }
    });
  }
});
