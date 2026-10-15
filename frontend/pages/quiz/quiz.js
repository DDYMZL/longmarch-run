/**
 * 情报 Tab（今日长征情报）
 * 状态：未开始（开始破译）/ 作答中（继续破译，逐题进度点）/ 已完成（答对数、正确率、答题积分、超时数）/ 无题目
 * 附加：知识画像（按题目分类聚合历史正确率）
 */
const app = getApp();
const quiz = require('../../services/quiz');
const util = require('../../utils/util');

Page({
  data: {
    completed: false,
    started: false,
    // 答题交互模式：instant 即时判定（情报1） | review 交卷看解析（情报2）
    mode: 'instant',
    record: null,
    stars: [],
    dots: [],
    issueNo: 1,
    timeLimit: 90,
    dailyCount: 5,
    shortageMessage: '',
    loading: true,
    errorMsg: '',
    knowledge: null
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    this.refresh();
  },

  refresh() {
    Promise.all([quiz.getDaily(), quiz.getKnowledge().catch(() => null)])
      .then((results) => {
        const daily = results[0];
        const record = daily.record;
        this.setData({
          completed: daily.completed,
          started: daily.progress.some((p) => p.status !== 'pending'),
          record,
          stars: record
            ? Array.from({ length: record.totalCount }, (_, i) => ({ id: i, on: i < record.correctCount }))
            : [],
          dots: util.quizDots(daily.progress, this.data.mode !== 'review'),
          issueNo: daily.issueNo,
          timeLimit: daily.timeLimit,
          dailyCount: daily.totalCount,
          shortageMessage: daily.shortageMessage,
          knowledge: results[1],
          loading: false,
          errorMsg: !daily.completed && daily.totalCount === 0 ? '本期情报正在准备中，请稍后再来。' : ''
        });
      })
      .catch((err) => {
        this.setData({ loading: false, errorMsg: (err && err.message) || '网络连接异常，请检查网络后重试。' });
      });
  },

  /**
   * 切换答题交互模式：即时判定（情报1）/ 交卷看解析（情报2）。
   * 切换后按新模式重刷进度点着色（交卷模式不显示对错）。
   */
  handleModeChange(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    this.setData({ mode });
    this.refresh();
  },

  /**
   * 开始答题（交卷模式带 mode=review 参数进入）
   */
  handleStart() {
    const suffix = this.data.mode === 'review' ? '?mode=review' : '';
    wx.navigateTo({ url: '/pages/quiz-answer/quiz-answer' + suffix });
  },

  /** 已完成：查看本期逐题结果 */
  handleViewResult() {
    wx.navigateTo({ url: '/pages/quiz-result/quiz-result' });
  },

  /** 加载失败重试 */
  handleRetry() {
    this.setData({ loading: true, errorMsg: '' });
    this.refresh();
  },

  /**
   * 已完成状态：明天再来
   */
  handleTomorrow() {
    wx.showToast({ title: '每天只能完成一次情报破译哦', icon: 'none' });
  },

  /**
   * 开发调试：重置今日答题
   */
  handleResetToday() {
    wx.showModal({
      title: '开发调试',
      content: '确定重置本期情报吗？将清除本期答题记录、题目缓存与相关积分，可重新破译。',
      confirmColor: '#C8102E',
      success: (res) => {
        if (res.confirm) {
          quiz
            .resetToday()
            .then(() => {
              this.refresh();
              wx.showToast({ title: '已重置本期情报', icon: 'success' });
            })
            .catch((err) => {
              wx.showToast({ title: (err && err.message) || '重置失败', icon: 'none' });
            });
        }
      }
    });
  }
});
