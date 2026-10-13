/**
 * 答题页（V2.0 逐题限时）
 * 流程：进入即 quiz.start 开题（幂等，中途返回继续当前题）-> 90 秒环形倒计时 -> 选择并提交（每题一次，即时判定）
 * -> 反馈（对错/正确答案/解析/得分）-> 下一题再 start；倒计时归零进入超时态，不再允许提交。
 * 计时以服务器为准：本地截止时间 = 收到响应时刻 + 服务器 remainingMs，切后台/锁屏回来按 Date.now 重算，不累计误差。
 */
const app = getApp();
const quiz = require('../../services/quiz');
const util = require('../../utils/util');

const WARN_SECONDS = 10; // 最后 10 秒进入警示色
const TICK_MS = 250;

/** 环形进度（conic-gradient）：剩余比例 -> 样式串 */
function ringStyle(remainSec, limit, warn) {
  const deg = limit > 0 ? Math.round((remainSec / limit) * 360) : 0;
  const color = warn ? '#E0453A' : '#D4A017';
  return 'background: conic-gradient(' + color + ' ' + deg + 'deg, rgba(240, 230, 210, 0.9) 0deg);';
}

/** 选项展示态：提交后标记正确项与我的错误项 */
function buildOptions(options, picked, correctLabels) {
  return (options || []).map((o) => {
    let state = '';
    if (correctLabels) {
      if (correctLabels.indexOf(o.label) >= 0) state = 'right';
      else if (o.label === picked) state = 'wrong';
    } else if (o.label === picked) {
      state = 'selected';
    }
    return { label: o.label, text: o.text, state };
  });
}

/** 答案标签 -> "B. 遵义会议" */
function answerText(labels, options) {
  return (labels || [])
    .map((label) => {
      const opt = (options || []).find((o) => o.label === label);
      return opt ? label + '. ' + opt.text : label;
    })
    .join('；');
}

Page({
  data: {
    // loading / answering / feedback / timeout / error
    phase: 'loading',
    errorMsg: '',
    seq: 0,
    total: 0,
    dots: [],
    question: null,
    options: [],
    selected: '',
    submitting: false,
    remainSec: 0,
    timeLimit: 90,
    warn: false,
    ring: '',
    feedback: null,
    isLast: false,
    questionAnim: ''
  },

  onLoad() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    this.startQuestion();
  },

  onShow() {
    // 切后台回来：按本地截止时间立即重算剩余秒数
    if (this.data.phase === 'answering') this.tick();
  },

  onUnload() {
    this.stopTimer();
    if (this._animTimer) clearTimeout(this._animTimer);
  },

  /** 开始/继续当前题（后端幂等；当前题已截止则后端判超时并开下一题） */
  startQuestion() {
    if (this._starting) return;
    this._starting = true;
    this.setData({ phase: 'loading', errorMsg: '' });
    quiz
      .start()
      .then((state) => this.applyState(state))
      .catch((err) => {
        this.setData({ phase: 'error', errorMsg: (err && err.message) || '题目加载失败，请重试' });
      })
      .finally(() => {
        this._starting = false;
      });
  },

  /** 应用后端答题状态 */
  applyState(state) {
    if (state.completed) {
      wx.redirectTo({ url: '/pages/quiz-result/quiz-result' });
      return;
    }
    const current = state.current;
    if (!current) {
      this.setData({ phase: 'error', errorMsg: '今日题目正在准备中，请稍后再来' });
      return;
    }
    this._question = current.question;
    this._deadline = Date.now() + current.remainingMs;
    this.setData({
      phase: 'answering',
      seq: current.seq,
      total: state.totalCount,
      timeLimit: state.timeLimit,
      isLast: current.seq >= state.totalCount,
      dots: util.quizDots(state.progress),
      question: current.question,
      options: buildOptions(current.question.options, ''),
      selected: '',
      feedback: null,
      questionAnim: ''
    });
    this._animTimer = setTimeout(() => this.setData({ questionAnim: 'q-slide-in' }), 30);
    this.stopTimer();
    this.tick();
    this._timer = setInterval(() => this.tick(), TICK_MS);
  },

  /** 倒计时：只在整秒变化时 setData，归零进入超时态 */
  tick() {
    const remainMs = Math.max(0, this._deadline - Date.now());
    const remainSec = Math.ceil(remainMs / 1000);
    if (remainSec !== this.data.remainSec || !this.data.ring) {
      const warn = remainSec <= WARN_SECONDS;
      this.setData({ remainSec, warn, ring: ringStyle(remainSec, this.data.timeLimit, warn) });
    }
    if (remainMs <= 0 && !this.data.submitting) this.enterTimeout();
  },

  stopTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  },

  enterTimeout() {
    this.stopTimer();
    this.setData({
      phase: 'timeout',
      [`dots[${this.data.seq - 1}].cls`]: 'timeout'
    });
  },

  /** 选择答案（仅作答中可选，提交前可改） */
  handleSelect(e) {
    if (this.data.phase !== 'answering' || this.data.submitting) return;
    const label = e.currentTarget.dataset.label;
    this.setData({ selected: label, options: buildOptions(this._question.options, label) });
  },

  /** 提交当前题（每题一次；提交中禁止重复点击） */
  handleSubmit() {
    const { phase, selected, submitting } = this.data;
    if (phase !== 'answering' || submitting) return;
    if (!selected) {
      wx.showToast({ title: '请先选择答案', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    quiz
      .answer(this._question.id, selected)
      .then((res) => {
        this.stopTimer();
        this.setData({
          phase: 'feedback',
          isLast: res.finished,
          options: buildOptions(this._question.options, selected, res.correctAnswer),
          [`dots[${res.seq - 1}].cls`]: res.correct ? 'right' : 'wrong',
          feedback: {
            correct: res.correct,
            points: res.points,
            correctText: answerText(res.correctAnswer, this._question.options),
            analysis: res.analysis,
            correctCount: res.correctCount,
            todayPoints: res.todayPoints
          }
        });
      })
      .catch((err) => {
        const msg = (err && err.message) || '提交失败，请重试';
        if (msg.indexOf('超时') >= 0) {
          this.enterTimeout();
        } else if (msg.indexOf('重复提交') >= 0) {
          // 已在其他端/并发提交：以后端状态为准继续
          this.startQuestion();
        }
        wx.showToast({ title: msg, icon: 'none' });
      })
      .finally(() => {
        this.setData({ submitting: false });
      });
  },

  /** 反馈/超时后：下一题（后端开题）或查看结果 */
  handleNext() {
    this.startQuestion();
  },

  handleBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/quiz/quiz' }) });
  }
});
