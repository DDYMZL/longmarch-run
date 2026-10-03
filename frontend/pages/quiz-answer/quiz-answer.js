/**
 * 答题页
 * 交互：选择答案（即时判题反馈 🔥 连续答对，需求 §15）-> 下一题 -> 第5题 -> 提交答卷 -> 计算成绩 -> 结果页
 * 单选/判断题共用单选交互（第一阶段不支持多选）
 */
const app = getApp();
const quiz = require('../../services/quiz');

Page({
  data: {
    questions: [],
    currentIndex: 0,
    total: 5,
    answers: {}, // { questionId: [label] }
    current: null,
    selected: '',
    submitting: false,
    // 连续答对（§15.2）：streak 连胜计数；lastCheck 本题判题结果 correct/wrong；checkedLabel 已判定选项
    streak: 0,
    lastCheck: '',
    checkedLabel: ''
  },

  onLoad() {
    quiz
      .getDaily()
      .then((daily) => {
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
      })
      .catch(() => {
        wx.showToast({ title: '题目加载失败，请重试', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
      });
  },

  /**
   * 选择答案：记录后立即单题判题（§15 连续答对反馈）。
   * 响应乱序防护：仅当判定仍对应当前题当前选项时应用结果。
   */
  handleSelect(e) {
    const label = e.currentTarget.dataset.label;
    const qid = this.data.current.id;
    const answers = this.data.answers;
    answers[qid] = [label]; // 单选/判断：直接覆盖
    this.setData({ answers, selected: label, lastCheck: '', checkedLabel: '' });

    quiz
      .checkAnswer(qid, [label])
      .then((res) => {
        if (!this.data.current || this.data.current.id !== qid || this.data.selected !== label) return;
        const correct = !!res.correct;
        this.setData({
          lastCheck: correct ? 'correct' : 'wrong',
          checkedLabel: label,
          streak: correct ? this.data.streak + 1 : 0
        });
      })
      .catch(() => { /* 判题失败不影响作答，最终以后端提交判分为准 */ });
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
        lastCheck: '',
        checkedLabel: '',
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
      .submit(payload)
      .then(() => {
        // 后端提交后自动判分、发积分并刷新勋章，直接进结果页
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
