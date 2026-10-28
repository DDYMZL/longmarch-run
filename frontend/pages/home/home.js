/**
 * 首页
 * 结构：用户信息 → 今日行军卡（步数/击败比例/距下一站）→ 今日寄语卡 → 迷你长征路线
 *       → 连续行军卡 → 今日长征情报卡（第 N 期）→ 长征记忆卡 → 勋章行
 * 点亮弹层升级为「抵达事件卡」：恭喜抵达 + 历史时间 + 下一站距离。
 */
const app = getApp();
const sport = require('../../services/sport');
const march = require('../../services/march');
const quiz = require('../../services/quiz');
const medal = require('../../services/medal');
const broadcast = require('../../services/broadcast');
const org = require('../../services/org');
const quote = require('../../services/quote');
const activity = require('../../services/activity');
const rank = require('../../services/rank');
const ws = require('../../services/ws');
const util = require('../../utils/util');
const arrivePopup = require('../../utils/arrivePopup');
const { ensureScope } = require('../../utils/authGuide');

// 首页刷新节流：30s 内非强制刷新（如快速切 tab 回到首页）不重复请求，减轻弱网压力
const REFRESH_THROTTLE = 30000;

/**
 * 今日行军状态文案（需求 §6.3/6.4：按真实数据分档，不随机生成）
 *   0 步            -> 未开始
 *   (0, goal)       -> 运动中（goal=连续行军目标，后端下发 5000）
 *   [goal, target)  -> 今日连续行军目标已完成
 *   >= target       -> 今日行军目标已完成（target=20000）
 */
/** 活动未进行中时的首页横幅（进行中或不限制时返回 null） */
function activityBanner(s) {
  if (!s || s.allowParticipate) return null;
  if (s.status === 'ended') return { tag: '已结束', text: s.endTitle + ' · 成绩可查看，不再计分' };
  const range = activity.formatRange(s);
  return { tag: s.statusText, text: s.message + (range ? '（' + range + '）' : '') };
}

function marchStatusText(steps, goal, target) {
  if (steps <= 0) return '今天还没有开始行军';
  if (steps >= target) return '今日行军目标已完成';
  if (steps >= goal) return '今日连续行军目标已完成';
  return '正在向下一站前进';
}

Page({
  data: {
    user: null,
    // 今日行军
    todaySteps: 0,
    dailyTarget: 20000,
    stepPercent: 0,
    marchStatus: '今天还没有开始行军',
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
    quizCorrect: 0,
    quizTotal: 5,
    quizPoints: 0,
    quizRemain: 5,
    quizStarted: false,
    issueNo: 1,
    // 长征记忆
    memory: null,
    // 今日寄语（P2-1，需求 §16）
    quote: null,
    // 勋章行
    medalPreview: [],
    medalOwned: 0,
    medalTotal: 0,
    // 实时行军动态（P1-1，需求 §8）
    activities: [],
    // 组织同行（P1-2，需求 §9）
    orgChecked: false,
    orgName: '',
    orgFullName: '',
    memberCount: 0,
    orgTodayStepsText: '0',
    companions: [],
    // 集体长征（P1-3，需求 §10）
    omProgress: 0,
    omTotalText: '0',
    omCurrent: '',
    omNext: '',
    omFinished: false,
    omNodes: [],
    // 全员同行（P1-4，需求 §11）
    ggTotalText: '0',
    ggProgress: 0,
    ggNextName: '',
    ggRemainText: '0',
    ggAllDone: false,
    ggMilestones: [],
    // 抵达事件卡弹层
    litPopup: null,
    // 活动未进行中横幅
    activityBanner: null,
    // 同行人用户卡抽屉（B7：复用排行榜用户卡逻辑）
    showUserCard: false,
    userCardLoading: false,
    userCard: null
  },

  onShow() {
    // 未登录（后端未校验通过）-> 启动页自动登录
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    this.setData({ user: app.globalData.user });
    if (!this._wsUnsub) {
      this._wsUnsub = ws.subscribe((msg) => this.handleWsMessage(msg));
    }
    // 跨页写操作（答题/点亮/同步）置脏标记：强制刷新绕过 30s 节流，保证返回首页即最新
    if (app.globalData.homeDirty) {
      app.globalData.homeDirty = false;
      this.refreshAll(true);
    } else {
      this.refreshAll();
    }
  },

  onHide() {
    if (this.stepsTimer) clearInterval(this.stepsTimer);
    if (this.popupTimer) clearTimeout(this.popupTimer);
    if (this._wsUnsub) { this._wsUnsub(); this._wsUnsub = null; }
  },

  onUnload() {
    if (this.stepsTimer) clearInterval(this.stepsTimer);
    if (this.popupTimer) clearTimeout(this.popupTimer);
    if (this._wsUnsub) { this._wsUnsub(); this._wsUnsub = null; }
  },

  /** 下拉刷新：强制刷新全部数据（绕过节流） */
  onPullDownRefresh() {
    this.refreshAll(true).then(() => wx.stopPullDownRefresh());
  },

  /**
   * WS 推送：
   * - activity：实时插入动态流顶部（最多保留 6 条，单条小 setData）；
   * - data_changed：后端数据变更（答题/点亮/同步等），绕过 30s 节流强制刷新，避免首页显示旧值。
   */
  handleWsMessage(msg) {
    if (!msg) return;
    if (msg.type === 'data_changed') {
      this.refreshAll(true);
      return;
    }
    if (msg.type !== 'activity') return;
    const item = broadcast.toActivityView(msg);
    this.setData({ activities: [item].concat(this.data.activities).slice(0, 6) });
  },

  /**
   * 刷新首页全部数据。
   * @param {boolean} [force] 强制刷新（同步步数后、下拉刷新时传 true，绕过节流）
   */
  refreshAll(force) {
    // 节流：30s 内的非强制刷新直接跳过（onShow 快速切 tab 回首页时避免重复请求）
    const now = Date.now();
    if (!force && this._lastRefreshTs && now - this._lastRefreshTs < REFRESH_THROTTLE) {
      return Promise.resolve();
    }
    this._lastRefreshTs = now;
    // 请求序号：onShow 与同步后刷新并发时，只采纳最后一次结果
    const requestId = (this._refreshRequestId || 0) + 1;
    this._refreshRequestId = requestId;
    return Promise.all([
      sport.getToday(),
      march.getRoute(),
      quiz.getDaily(),
      broadcast.getToday(),
      medal.getMedalList(),
      broadcast.getActivities(6).catch(() => null), // 动态流失败不阻塞首页主数据
      org.getCompanions(6).catch(() => null), // 组织同行失败同上
      org.getOrgMarch().catch(() => null), // 集体长征失败同上
      march.getGlobalGoal().catch(() => null), // 全员同行失败同上
      quote.getToday().catch(() => null), // 今日寄语失败同上
      activity.getStatus().catch(() => null) // 活动状态失败不展示横幅
    ])
      .then((results) => {
        if (requestId !== this._refreshRequestId) return;
        const today = results[0];
        const route = results[1];
        const daily = results[2];
        const cast = results[3];
        const medals = results[4];
        const activities = results[5];
        const orgData = results[6];
        const orgMarch = results[7];
        const globalGoal = results[8];
        const todayQuote = results[9];
        const activityStatus = results[10];
        const percent = today.target > 0 ? Math.min(100, Math.round((today.steps / today.target) * 100)) : 0;

        // 勋章行：已获得的排前面（按获得时间倒序取最近 6 枚展示）
        const ownedAll = medals.filter((m) => m.owned);
        const owned = ownedAll
          .sort((a, b) => String(b.grantedAt || '').localeCompare(String(a.grantedAt || '')))
          .slice(0, 6);

        // 主数据 + 可选区块合并为一次 setData，减少逻辑层到渲染层的通信次数
        const patch = {
          dailyTarget: today.target,
          stepPercent: percent,
          marchStatus: marchStatusText(today.steps, today.streakGoal, today.target),
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
          finished: route.finished,
          routeNodesPreview: route.nodes.slice(0, 6),
          // 情报
          quizCompleted: daily.completed,
          quizCorrect: daily.correctCount,
          quizTotal: daily.totalCount,
          quizPoints: daily.points,
          quizRemain: daily.progress.filter((p) => p.status === 'pending' || p.status === 'answering').length,
          quizStarted: daily.progress.some((p) => p.status !== 'pending'),
          issueNo: daily.issueNo,
          // 勋章
          medalPreview: owned,
          medalOwned: ownedAll.length,
          medalTotal: medals.length,
          // 今日寄语（需求 §16：无寄语时隐藏卡片）
          quote: todayQuote && todayQuote.content ? todayQuote : null,
          activityBanner: activityBanner(activityStatus)
        };
        // 实时行军动态：REST 为权威快照（WS 期间的事件已落库，快照自含）
        if (activities !== null) {
          patch.activities = activities.slice(0, 6);
        }
        // 组织同行（需求 §9：组织 + 同行人数 + 今日共同前进 + 同行者）
        if (orgData !== null) {
          Object.assign(patch, {
            orgChecked: true,
            orgName: orgData.org ? orgData.org.orgName : '',
            orgFullName: orgData.org ? orgData.org.fullName : '',
            memberCount: orgData.memberCount,
            orgTodayStepsText: util.formatNumber(orgData.todayTotalSteps),
            companions: (orgData.companions || []).map((c, i) => ({
              rowKey: i + '_' + (c.nickname || ''),
              userId: c.userId || null,
              nickname: c.nickname || '战友',
              avatar: c.avatar || '',
              isSelf: !!c.isSelf,
              stepsText: util.formatNumber(c.todaySteps)
            }))
          });
        }
        // 集体长征（需求 §10：组织累计步数映射路线进度，节点 pct 后端下发）
        if (orgMarch !== null) {
          Object.assign(patch, {
            omProgress: orgMarch.progressPct,
            omTotalText: util.formatNumber(orgMarch.totalSteps),
            omCurrent: orgMarch.currentNodeName || '',
            omNext: orgMarch.nextNodeName || '',
            omFinished: !!orgMarch.finished,
            omNodes: (orgMarch.nodes || []).map((n) => ({
              id: n.id,
              name: n.name,
              status: n.status,
              pctLabel: n.status === 'completed' ? '✓' : (n.status === 'current' ? n.pct + '%' : '0%')
            }))
          });
        }
        // 全员同行（需求 §11：全员累计步数对 2 亿步总目标，里程碑状态后端下发）
        if (globalGoal !== null) {
          Object.assign(patch, {
            ggTotalText: util.formatCn(globalGoal.totalSteps),
            ggProgress: globalGoal.progressPct,
            ggNextName: globalGoal.nextMilestone ? globalGoal.nextMilestone.name : '',
            ggRemainText: globalGoal.nextMilestone ? util.formatCn(globalGoal.nextMilestone.remain) : '0',
            ggAllDone: !globalGoal.nextMilestone,
            ggMilestones: (globalGoal.milestones || []).map((m) => ({
              name: m.name,
              reached: !!m.reached,
              mark: m.reached ? '✓' : '○'
            }))
          });
        }
        this.setData(patch);

        // last-good 缓存兜底：核心 GET 网络失败回读缓存时（request.js 附加 _fromCache），提示可能非最新
        if (today._fromCache || route._fromCache) {
          wx.showToast({ title: '网络异常，当前为最近缓存数据', icon: 'none' });
        }

        // 步数滚动动画
        this.animateSteps(today.steps);
      })
      .catch(() => {
        if (requestId !== this._refreshRequestId) return;
        this.setData({ routeLoading: false, routeError: '数据加载失败，请稍后重试' });
      });
  },

  /**
   * 步数数字滚动动画（缓动 + 30fps 节流）
   */
  animateSteps(target) {
    if (this.stepsTimer) clearInterval(this.stepsTimer);
    const from = this.data.todaySteps || 0;
    if (from === target) return;
    const duration = 900;
    const start = Date.now();
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
        // 步数同步后点亮节点（后端同时判定章节并发放勋章）
        return march.lightUpNodes().then((lit) => Object.assign({ result: result }, lit));
      })
      .then((res) => {
        if (res.newlyLit.length > 0 || res.newlyCompletedChapters.length > 0) {
          // 按队列播放「抵达事件卡 → 章节完成仪式」
          arrivePopup.playArriveQueue(this, res.newlyLit, res.newlyCompletedChapters);
        } else if (res.newMedals.length > 0) {
          wx.showToast({ title: '获得新勋章！', icon: 'none' });
        } else if (res.result.failedDates.length > 0) {
          wx.showToast({
            title: '已同步' + res.result.processedDates.length + '天，' + res.result.failedDates.length + '天待重试',
            icon: 'none',
            duration: 2500
          });
        } else {
          wx.showToast({ title: '同步成功', icon: 'success' });
        }
        this.refreshAll(true);
      })
      .catch((err) => {
        this.setData({ syncError: (err && err.message) || '暂时无法获取微信运动数据，请稍后重试。' });
      })
      .finally(() => {
        this.setData({ syncing: false });
      });
  },

  goActivity() {
    wx.navigateTo({ url: '/pages/activity/activity' });
  },

  /** 点击实时动态：点亮节点类事件（含 nodeId）进入节点详情（B7） */
  goFeedNode(e) {
    const nodeId = e.currentTarget.dataset.nodeid;
    if (!nodeId) return;
    wx.navigateTo({ url: '/pages/node-detail/node-detail?id=' + nodeId });
  },

  /** 点击同行人：拉取用户卡并弹出抽屉（复用排行榜用户卡逻辑，B7） */
  goCompanionCard(e) {
    const userId = e.currentTarget.dataset.userid;
    if (!userId) return;
    this.setData({ showUserCard: true, userCardLoading: true, userCard: null });
    rank
      .getUserCard(userId)
      .then((card) => {
        this.setData({
          userCardLoading: false,
          userCard: {
            nickname: card.nickname || '长征小战士',
            avatar: card.avatar || '',
            orgName: card.orgName || '未选择组织',
            points: card.points || 0,
            steps: card.steps || 0,
            litNodes: card.litNodes || 0,
            medalCount: card.medalCount || 0,
            rank: card.rank || 0
          }
        });
      })
      .catch((err) => {
        this.setData({ userCardLoading: false, showUserCard: false });
        const code = err && err.statusCode;
        // 越权/不存在（/rank/user 越权返回 404，或无权限 403）：优雅兜底提示，不崩溃
        const msg = (code === 404 || code === 403)
          ? '暂无该用户的排行信息'
          : ((err && err.message) || '用户信息加载失败');
        wx.showToast({ title: msg, icon: 'none' });
      });
  },

  closeUserCard() {
    this.setData({ showUserCard: false });
  },

  noop() {},

  /** 「去开启」引导：打开设置页让用户重新授权微信运动 */
  handleOpenWeRunSetting() {
    ensureScope('scope.werun', '需要「微信运动」权限才能同步行军步数，请在设置中开启。')
      .then((granted) => {
        if (granted) {
          this.setData({ syncError: '' });
          this.handleSyncSteps();
        }
      });
  },

  /**
   * 跳转长征路线
   */
  goMarch() {
    wx.switchTab({ url: '/pages/march/march' });
  },

  /**
   * 开始答题（答题已非 tab，页内跳转）
   */
  goQuiz() {
    wx.navigateTo({ url: '/pages/quiz/quiz' });
  },

  /**
   * 勋章墙
   */
  goMedals() {
    wx.navigateTo({ url: '/pages/medals/medals' });
  },

  /** 选择所属组织（选填，选定后返回首页） */
  goOrgSelect() {
    wx.navigateTo({ url: '/pages/org-select/org-select?from=home' });
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
  },

  /**
   * 今日寄语卡 -> 关联节点详情（需求 §16.3，无关联节点时不可点）
   */
  goQuoteNode() {
    const q = this.data.quote;
    if (!q || !q.node) return;
    wx.navigateTo({ url: '/pages/node-detail/node-detail?id=' + q.node.id });
  }
});
