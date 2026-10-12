/**
 * 答题页
 * 交互：选择答案（仅中性选中高亮，作答中不判题）-> 上一题/下一题可回看修改 -> 第5题 -> 提交答卷
 * -> 后端统一判分 -> 结果页展示逐题对错与得分
 * 单选/判断题共用单选交互（第一阶段不支持多选）
 */
const app = getApp();
const quiz = require('../../services/quiz');

Page({
  data: {
    currentIndex: 0,
    total: 0,
    current: null,
    selected: '',
    submitting: false
  },

  onLoad() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    // 题目与作答仅逻辑层使用，不进 data（避免每次选择都整体 setData）
    this._questions = [];
    this._answers = {}; // { questionId: [label] }
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

        this._questions = daily.questions;
        daily.questions.forEach((q) => (this._answers[q.id] = []));

        this.setData({
          total: daily.questions.length,
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

  /** 选择答案：仅记录并中性高亮，提交前可随时修改 */
  handleSelect(e) {
    const label = e.currentTarget.dataset.label;
    this._answers[this.data.current.id] = [label]; // 单选/判断：直接覆盖
    this.setData({ selected: label });
  },

  /** 切换到指定题目（回显已选答案） */
  goTo(index) {
    const q = this._questions[index];
    this.setData({
      currentIndex: index,
      current: q,
      selected: this._answers[q.id][0] || '',
      questionAnim: ''
    });
    // 重置类名以重新触发题目切换动画
    this._animTimer = setTimeout(() => {
      this.setData({ questionAnim: 'q-slide-in' });
    }, 30);
  },

  handlePrev() {
    if (this.data.currentIndex > 0) this.goTo(this.data.currentIndex - 1);
  },

  /** 下一题 / 提交：当前题未作答不可前进 */
  handleNext() {
    const { currentIndex, total, selected } = this.data;
    if (!selected) {
      wx.showToast({ title: '请先选择答案', icon: 'none' });
      return;
    }
    if (currentIndex < total - 1) {
      this.goTo(currentIndex + 1);
      return;
    }
    this.handleSubmit();
  },

  /** 提交答卷（按题目顺序提交，判分与对错均由后端计算） */
  handleSubmit() {
    if (this.data.submitting) return;
    const missing = this._questions.findIndex((q) => !this._answers[q.id].length);
    if (missing >= 0) {
      wx.showToast({ title: `第${missing + 1}题尚未作答`, icon: 'none' });
      this.goTo(missing);
      return;
    }
    this.setData({ submitting: true });

    const payload = this._questions.map((q) => ({ questionId: q.id, answer: this._answers[q.id] }));

    quiz
      .submit(payload)
      .then(() => {
        wx.redirectTo({ url: '/pages/quiz-result/quiz-result' });
      })
      .catch((err) => {
        const msg = (err && err.message) || '提交失败，请重试';
        // 并发/重复提交：后端已有记录，直接去结果页查看
        if (msg === '今日答题已完成') {
          wx.redirectTo({ url: '/pages/quiz-result/quiz-result' });
          return;
        }
        wx.showToast({ title: msg, icon: 'none' });
      })
      .finally(() => {
        this.setData({ submitting: false });
      });
  },

  onUnload() {
    if (this._animTimer) clearTimeout(this._animTimer);
  }
});
