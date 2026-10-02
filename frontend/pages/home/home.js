/**
 * 首页
 * 结构：用户信息 → 今日行军卡（步数/击败比例/距下一站）→ 迷你长征路线
 *       → 连续行军卡 → 今日长征情报卡（第 N 期）→ 长征记忆卡 → 勋章行
 * 点亮弹层升级为「抵达事件卡」：恭喜抵达 + 历史时间 + 积分 + 下一站距离。
 */
const app = getApp();
const sport = require('../../services/sport');
const march = require('../../services/march');
const quiz = require('../../services/quiz');
const medal = require('../../services/medal');
const broadcast = require('../../services/broadcast');

/**
 * 今日行军状态文案（需求 §6.3/6.4：按真实数据分档，不随机生成）
 *   0 步            -> 未开始
 *   (0, goal)       -> 运动中（goal=当日行军目标，后端下发 5000）
 *   [goal, target)  -> 今日行军目标已完成
 *   >= target       -> 今日完成一次长距离行军（target=10000）
 */
function marchStatusText(steps, goal, target) {
  if (steps <= 0) return '今天还没有开始行军';
  if (steps >= target) return '今日完成一次长距离行军';
  if (steps >= goal) return '今日行军目标已完成';
  return '正在向下一站前进';
}

Page({
  data: {
    user: null,
    // 今日行军
    todaySteps: 0,
    dailyTarget: 10000,
    stepPercent: 0,
    marchStatus: '今天还没有开始行军',
    totalSteps: 0,
    syncing: false,
    syncError: '',
    // 今日播报（个人）
    beatPercent: 0,
    remainToNext: 0,
    nextNodeName: '',
    // 长征路线
    routeLoading: true,
    routeError: '',
    litCount: 0,
    totalCount: 10,
    nextNode: null,
    finished: false,
    routeNodesPreview: [],
    // 连续行军
    currentStreak: 0,
    streakGoal: 5000,
    todayGoalCompleted: false,
    nextStreakMilestone: null,
    streakRemain: 0,
    // 今日长征情报
    quizCompleted: false,
    quizScore: 0,
    quizRemain: 5,
    issueNo: 1,
    // 长征记忆
    memory: null,
    // 勋章行
    medalPreview: [],
    medalOwned: 0,
    medalTotal: 0,
    // 抵达事件卡弹层
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
    Promise.all([sport.getToday(), march.getRoute(), quiz.getDaily(), broadcast.getToday(), medal.getMedalList()])
      .then((results) => {
        const today = results[0];
        const route = results[1];
        const daily = results[2];
        const cast = results[3];
        const medals = results[4];
        const percent = today.target > 0 ? Math.min(100, Math.round((today.steps / today.target) * 100)) : 0;

        // 勋章行：已获得的排前面（按获得时间倒序取最近 6 枚展示）
        const owned = medals
          .filter((m) => m.owned)
          .sort((a, b) => String(b.grantedAt || '').localeCompare(String(a.grantedAt || '')))
          .slice(0, 6);

        this.setData({
          dailyTarget: today.target,
          stepPercent: percent,
          marchStatus: marchStatusText(today.steps, today.streakGoal, today.target),
          totalSteps: today.totalSteps,
          // 连续行军
          currentStreak: today.currentStreak,
          streakGoal: today.streakGoal,
          todayGoalCompleted: today.todayGoalCompleted,
          nextStreakMilestone: today.nextStreakMilestone,
          streakRemain: today.streakRemain,
          // 播报
          beatPercent: cast.personal.beatPercent,
          remainToNext: cast.personal.remainToNext,
          nextNodeName: cast.personal.nextNodeName,
          memory: cast.memory,
          // 路线
          routeLoading: false,
          routeError: '',
          litCount: route.litCount,
          totalCount: route.totalCount,
          nextNode: route.nextNode,
          finished: route.finished,
          routeNodesPreview: route.nodes.slice(0, 6),
          // 情报
          quizCompleted: daily.completed,
          quizScore: daily.record ? daily.record.score : 0,
          quizRemain: quiz.DAILY_COUNT,
          issueNo: daily.issueNo,
          // 勋章
          medalPreview: owned,
          medalOwned: medals.filter((m) => m.owned).length,
          medalTotal: medals.length
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
          // 逐个播放「抵达事件卡」
          this.playLitPopup(res.newlyLit);
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
   * 抵达事件卡（逐个播放）：恭喜抵达 + 历史时间 + 积分 + 下一站距离
   */
  playLitPopup(nodes) {
    let i = 0;
    const showNext = () => {
      if (i >= nodes.length) {
        this.setData({ litPopup: null });
        return;
      }
      const n = nodes[i];
      this.setData({
        litPopup: {
          key: Date.now(),
          name: n.name,
          icon: n.icon || '★',
          historicalTime: n.historicalTime || '',
          gainedPoints: n.gainedPoints || 0,
          nextName: n.nextNode ? n.nextNode.name : '',
          nextRemain: n.nextNode ? n.nextNode.remain : 0
        }
      });
      i++;
      if (this.popupTimer) clearTimeout(this.popupTimer);
      this.popupTimer = setTimeout(showNext, 2400);
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
          this.playLitPopup(r[0]);
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
  },

  /**
   * 勋章墙
   */
  goMedals() {
    wx.navigateTo({ url: '/pages/medals/medals' });
  },

  /**
   * 行军日历
   */
  goCalendar() {
    wx.navigateTo({ url: '/pages/calendar/calendar' });
  },

  /**
   * 长征记忆卡 -> 节点详情
   */
  goMemoryNode() {
    const memory = this.data.memory;
    if (!memory) return;
    wx.navigateTo({ url: '/pages/node-detail/node-detail?id=' + memory.nodeId });
  }
});
