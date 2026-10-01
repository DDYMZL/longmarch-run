/**
 * 答题结果页
 * 展示：得分 / 星级 / 对错统计 / 获得积分 / 错题与解析
 * 动画：分数滚动、星星逐个点亮、满分彩带庆贺
 */
const app = getApp();
const quiz = require('../../services/quiz');

// 彩带颜色池
const CONFETTI_COLORS = ['#C8102E', '#D4A017', '#E8C76A', '#FF6B6B', '#4ECDC4', '#F5D9A0'];

Page({
  data: {
    record: null,
    stars: [false, false, false, false, false],
    wrongCount: 0,
    displayScore: 0,
    confetti: []
  },

  onLoad() {
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
          wrongCount: record.totalCount - record.correctCount
        });

        // 1. 分数滚动动画
        this.animateScore(record.score);

        // 2. 星星逐个点亮（间隔 220ms）
        const starCount = Math.round(record.score / 20);
        for (let i = 1; i <= starCount; i++) {
          setTimeout(() => {
            const key = 'stars[' + (i - 1) + ']';
            this.setData({ [key]: true });
          }, 500 + i * 220);
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
        setTimeout(step, 30);
      }
    };
    step();
  },

  /**
   * 返回首页
   */
  handleBackHome() {
    wx.switchTab({ url: '/pages/home/home' });
  }
});
