/**
 * 首页
 * 核心体验：头像昵称 + 今日步数 + 长征进度 + 今日答题入口
 * 状态处理（需求文档 三十）：未登录 / 未授权运动 / 同步中 / 同步成功 / 同步失败
 *                           / 路线加载中 / 加载成功 / 加载失败 / 答题未完成 / 已完成
 */
const app = getApp();
const sport = require('../../services/sport');
const march = require('../../services/march');
const quiz = require('../../services/quiz');
const medal = require('../../services/medal');

Page({
  data: {
    user: null,
    // 今日运动
    todaySteps: 0,
    dailyTarget: 10000,
    stepPercent: 0,
    totalSteps: 0,
    syncing: false,
    syncError: '',
    // 长征路线
    routeLoading: true,
    routeError: '',
    litCount: 0,
    totalCount: 10,
    nextNode: null,
    finished: false,
    // 今日答题
    quizCompleted: false,
    quizScore: 0,
    quizRemain: 5,
    // 点亮节点庆祝弹层
    litPopup: null
  },

  onShow() {
    // 未登录 -> 登录页
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    // 已登录但未选组织 -> 强制先完成组织选择
    if (!app.globalData.user.orgId) {
      wx.redirectTo({ url: '/pages/org-select/org-select?from=login' });
      return;
    }
    this.setData({ user: app.globalData.user });
    this.refreshAll();
  },

  onHide() {
    if (this.stepsTimer) clearInterval(this.stepsTimer);
    if (this.popupTimer) clearTimeout(this.popupTimer);
  },

  onUnload() {
    if (this.stepsTimer) clearInterval(this.stepsTimer);
    if (this.popupTimer) clearTimeout(this.popupTimer);
  },

  /**
   * 刷新首页全部数据
   */
  refreshAll() {
    // 1. 步数 + 2. 路线状态 + 3. 答题状态（并行请求后端）
    Promise.all([sport.getToday(), march.getRoute(), quiz.getDaily()])
      .then((results) => {
        const today = results[0];
        const route = results[1];
        const daily = results[2];
        const percent = today.target > 0 ? Math.min(100, Math.round((today.steps / today.target) * 100)) : 0;

        this.setData({
          dailyTarget: today.target,
          stepPercent: percent,
          totalSteps: today.totalSteps,
          routeLoading: false,
          litCount: route.litCount,
          totalCount: route.totalCount,
          nextNode: route.nextNode,
          finished: route.finished,
          // 迷你路线图（预览前 6 个节点）
          routeNodesPreview: route.nodes.slice(0, 6),
          quizCompleted: daily.completed,
          quizScore: daily.record ? daily.record.score : 0,
          quizRemain: quiz.DAILY_COUNT
        });

        // 步数滚动动画
        this.animateSteps(today.steps);
      })
      .catch(() => {
        this.setData({ routeLoading: false, routeError: '数据加载失败，请下拉重试' });
      });
  },

  /**
   * 步数数字滚动动画（缓动 + 30fps 节流）
   */
  animateSteps(target) {
    if (this.stepsTimer) clearInterval(this.stepsTimer);
    const duration = 900;
    const start = Date.now();
    const from = this.data.todaySteps || 0;
    const step = () => {
      const p = Math.min(1, (Date.now() - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      this.setData({ todaySteps: Math.round(from + (target - from) * eased) });
      if (p >= 1) clearInterval(this.stepsTimer);
    };
    this.stepsTimer = setInterval(step, 30);
  },

  /**
   * 同步微信运动步数
   */
  handleSyncSteps() {
    if (this.data.syncing) return;
    this.setData({ syncing: true, syncError: '' });

    sport
      .syncToday()
      .then((result) => {
        // 步数同步后：点亮节点 -> 刷新勋章（后端联动）
        return Promise.all([march.lightUpNodes(), medal.checkAndGrant()]).then((r) => ({
          result: result,
          newlyLit: r[0],
          newMedals: r[1]
        }));
      })
      .then((res) => {
        if (res.newlyLit.length > 0) {
          // 逐个播放点亮庆祝弹层
          this.playLitPopup(res.newlyLit.map((n) => n.name));
        } else if (res.newMedals.length > 0) {
          wx.showToast({ title: '获得新勋章！', icon: 'none' });
        } else if (res.result.synced) {
          wx.showToast({ title: '步数同步成功', icon: 'success' });
        } else {
          wx.showToast({ title: '今日已同步', icon: 'none' });
        }
        this.refreshAll();
      })
      .catch((err) => {
        this.setData({ syncError: (err && err.message) || '暂时无法获取微信运动数据，请稍后重试。' });
      })
      .finally(() => {
        this.setData({ syncing: false });
      });
  },

  /**
   * 点亮节点庆祝弹层（金色星星 + 粒子，逐个播放）
   */
  playLitPopup(names) {
    let i = 0;
    const showNext = () => {
      if (i >= names.length) {
        this.setData({ litPopup: null });
        return;
      }
      this.setData({ litPopup: { name: names[i], key: Date.now() } });
      i++;
      if (this.popupTimer) clearTimeout(this.popupTimer);
      this.popupTimer = setTimeout(showNext, 1600);
    };
    showNext();
  },

  /**
   * 演示用：手动补步数（无真机环境模拟微信运动数据变化）
   */
  handleAddSteps() {
    sport
      .addSteps(2000)
      .then(() => Promise.all([march.lightUpNodes(), medal.checkAndGrant()]))
      .then((r) => {
        this.refreshAll();

        if (r[0].length > 0) {
          this.playLitPopup(r[0].map((n) => n.name));
        } else if (r[1].length > 0) {
          wx.showToast({ title: '获得新勋章！', icon: 'none' });
        } else {
          wx.showToast({ title: '模拟 +2000 步', icon: 'none' });
        }
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' });
      });
  },

  /**
   * 跳转长征路线
   */
  goMarch() {
    wx.switchTab({ url: '/pages/march/march' });
  },

  /**
   * 开始答题
   */
  goQuiz() {
    wx.switchTab({ url: '/pages/quiz/quiz' });
  }
});
