/**
 * 答题页
 * 交互：选择答案 -> 下一题 -> 第5题 -> 提交答卷 -> 计算成绩 -> 结果页
 * 单选/判断题共用单选交互（第一阶段不支持多选）
 */
const app = getApp();
const quiz = require('../../services/quiz');
const medal = require('../../services/medal');

Page({
  data: {
    questions: [],
    currentIndex: 0,
    total: 5,
    answers: {}, // { questionId: [label] }
    current: null,
    selected: '',
    submitting: false
  },

  onLoad() {
    const daily = quiz.getDaily(app.globalData.user.id);

    // 今日已完成 -> 直接去结果页
    if (daily.completed) {
      wx.redirectTo({ url: '/pages/quiz-result/quiz-result' });
      return;
    }
    if (!daily.questions || daily.questions.length === 0) {
      wx.showToast({ title: '今日题目正在准备中', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }

    const answers = {};
    daily.questions.forEach((q) => (answers[q.id] = []));

    this.setData({
      questions: daily.questions,
      total: daily.questions.length,
      answers,
      current: daily.questions[0],
      selected: '',
      questionAnim: 'q-slide-in'
    });
  },

  /**
   * 选择答案
   */
  handleSelect(e) {
    const label = e.currentTarget.dataset.label;
    const qid = this.data.current.id;
    const answers = this.data.answers;
    answers[qid] = [label]; // 单选/判断：直接覆盖
    this.setData({ answers, selected: label });
  },

  /**
   * 下一题 / 提交
   */
  handleNext() {
    const { currentIndex, total, current, answers, selected } = this.data;
    if (!selected) {
      wx.showToast({ title: '请先选择答案', icon: 'none' });
      return;
    }

    if (currentIndex < total - 1) {
      const nextIndex = currentIndex + 1;
      this.setData({
        currentIndex: nextIndex,
        current: this.data.questions[nextIndex],
        selected: this.data.answers[this.data.questions[nextIndex].id][0] || '',
        questionAnim: ''
      });
      // 重置类名以重新触发题目切换动画
      setTimeout(() => {
        this.setData({ questionAnim: 'q-slide-in' });
      }, 30);
      return;
    }

    // 最后一题：提交答卷
    this.handleSubmit();
  },

  /**
   * 提交答卷（结果由后端计算，Mock 阶段本地计算）
   */
  handleSubmit() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    const payload = Object.keys(this.data.answers).map((qid) => ({
      questionId: parseInt(qid, 10),
      answer: this.data.answers[qid]
    }));

    quiz
      .submit(app.globalData.user.id, payload)
      .then(() => {
        medal.checkAndGrant(app.globalData.user.id);
        wx.redirectTo({ url: '/pages/quiz-result/quiz-result' });
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.message) || '提交失败，请重试', icon: 'none' });
      })
      .finally(() => {
        this.setData({ submitting: false });
      });
  }
});
