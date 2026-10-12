/**
 * 答题结果页
 * 展示：得分 / 星级 / 对错统计 / 获得积分 / 逐题结果（题干、我的答案、正确答案、对错、得分）
 * 历史记录无 details 时回退展示错题回顾（wrongList）
 * 动画：分数滚动、星星逐个点亮、满分彩带庆贺
 */
const app = getApp();
const quiz = require('../../services/quiz');

// 彩带颜色池
const CONFETTI_COLORS = ['#C8102E', '#D4A017', '#E8C76A', '#FF6B6B', '#4ECDC4', '#F5D9A0'];

/** 选项标签转展示文本，如 ["B"] -> "B. 遵义会议" */
function answerText(labels, options) {
  if (!labels || !labels.length) return '未作答';
  return labels
    .map((label) => {
      const opt = (options || []).find((o) => o.label === label);
      return opt ? label + '. ' + opt.text : label;
    })
    .join('；');
}

/** 逐题结果预处理（WXML 不支持调用方法，展示文本在逻辑层拼好） */
function buildDetails(details) {
  return (details || []).map((d) => ({
    key: d.index + '-' + d.questionId,
    index: d.index,
    typeText: d.type === 'judge' ? '判断题' : '单选题',
    question: d.question,
    correct: d.correct,
    score: d.score,
    userAnswerText: answerText(d.userAnswer, d.options),
    correctAnswerText: answerText(d.correctAnswer, d.options),
    analysis: d.analysis || ''
  }));
}

Page({
  data: {
    record: null,
    details: [],
    stars: [0, 1, 2, 3, 4].map((id) => ({ id, on: false })),
    wrongCount: 0,
    displayScore: 0,
    confetti: [],
    isPerfect: false,
    perfectLine: ''
  },

  onLoad() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    this._timers = [];
    quiz
      .getDaily()
      .then((daily) => {
        const record = daily.record;

        if (!record) {
          wx.showToast({ title: '暂无答题记录', icon: 'none' });
          setTimeout(() => wx.switchTab({ url: '/pages/quiz/quiz' }), 800);
          return;
        }

        this.setData({
          record,
          details: buildDetails(record.details),
          wrongCount: record.totalCount - record.correctCount,
          isPerfect: record.score === 100,
          perfectLine: record.correctCount + ' / ' + record.totalCount + ' · ' + record.score + ' 分'
        });

        // 1. 分数滚动动画
        this.animateScore(record.score);

        // 2. 星星逐个点亮（间隔 220ms）
        const starCount = Math.round(record.score / 20);
        for (let i = 1; i <= starCount; i++) {
          this._timers.push(setTimeout(() => {
            this.setData({ ['stars[' + (i - 1) + '].on']: true });
          }, 500 + i * 220));
        }

        // 3. 满分彩带
        if (record.score === 100) {
          const confetti = [];
          for (let i = 0; i < 14; i++) {
            confetti.push({
              id: i,
              left: Math.round(Math.random() * 92 + 4), // 4% - 96%
              delay: Math.random() * 1.2,
              duration: 2.2 + Math.random() * 1.6,
              color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
              size: 10 + Math.round(Math.random() * 14)
            });
          }
          this.setData({ confetti });
        }
      })
      .catch(() => {
        wx.showToast({ title: '答题记录加载失败', icon: 'none' });
        setTimeout(() => wx.switchTab({ url: '/pages/quiz/quiz' }), 800);
      });
  },

  /**
   * 分数数字滚动动画
   */
  animateScore(target) {
    const duration = 1100;
    const start = Date.now();
    const step = () => {
      const p = Math.min(1, (Date.now() - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      this.setData({ displayScore: Math.round(target * eased) });
      if (p < 1) {
        this._scoreTimer = setTimeout(step, 30);
      }
    };
    step();
  },

  onUnload() {
    (this._timers || []).forEach(clearTimeout);
    if (this._scoreTimer) clearTimeout(this._scoreTimer);
  },

  /**
   * 返回首页
   */
  handleBackHome() {
    wx.switchTab({ url: '/pages/home/home' });
  }
});
