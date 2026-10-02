/**
 * 我的长征（个人档案页）
 * 头部（头像/昵称/组织/参与第 N 天/阶段称号）→ 核心数据 5 格 → 成就总览（§18 六格直达详情）
 * → 数据画像雷达（§17 五维评分，仅展示数据不做评价）→ 长征进度条
 * → 足迹地图（§7 时间+路线结合，点击节点看抵达详情）→ 历史数据区 → 长征足迹时间轴；
 * 入口：行军日历。
 */
const app = getApp();
const profile = require('../../services/profile');
const march = require('../../services/march');
const util = require('../../utils/util');

/** 阶段称号：按点亮进度划分 */
function stageTitle(progress) {
  if (progress >= 100) return '长征先锋';
  if (progress >= 60) return '铁血战士';
  if (progress >= 30) return '行军骨干';
  return '红军新兵';
}

/** 数据画像五维（§17.2）：雷达图轴序（自顶部顺时针） */
const PORTRAIT_DIMS = [
  { key: 'march', label: '行军' },
  { key: 'persistence', label: '坚持' },
  { key: 'knowledge', label: '知识' },
  { key: 'route', label: '路线' },
  { key: 'achievement', label: '成就' }
];

/** 事件图标（时间轴按类型区分） */
const EVENT_ICONS = {
  FIRST_STEP: '🏃',
  DAILY_GOAL: '🎯',
  NODE_UNLOCK: '⭐',
  BADGE_UNLOCK: '🏅',
  QUIZ_COMPLETE: '📝',
  QUIZ_FULL_SCORE: '💯',
  STEP_10000: '👟',
  TOTAL_STEPS_100000: '🎖️',
  TOTAL_STEPS_500000: '💪',
  COMPLETE_ROUTE: '🏆'
};

function eventIcon(eventType) {
  if (EVENT_ICONS[eventType]) return EVENT_ICONS[eventType];
  if (eventType && eventType.indexOf('STREAK_') === 0) return '🔥';
  return '📌';
}

Page({
  data: {
    loading: true,
    errorMsg: '',
    summary: null,
    stage: '',
    totalStepsText: '0',
    distanceText: '0',
    timeline: [],
    // 足迹地图（P1-6，需求 §7）：已点亮节点链 + 展开详情
    footprints: [],
    fpSelected: 0,
    // 成就总览（P1-7，需求 §18）：六格数据直达详情页
    achievements: []
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.refresh();
  },

  refresh() {
    Promise.all([
      profile.getSummary(),
      profile.getTimeline(50),
      march.getFootprints().catch(() => null) // 足迹地图失败不阻塞档案主数据
    ])
      .then((results) => {
        const summary = results[0];
        const timeline = results[1].map((item) => ({
          eventType: item.eventType,
          text: item.text,
          icon: eventIcon(item.eventType),
          timeText: util.formatTime(item.eventTime)
        }));
        const fpData = results[2];
        // 足迹地图（§7.2/§7.3）：视图模型预格式化，累计快照为 0（历史回填）时展示 —
        const footprints = fpData === null ? [] : (fpData.nodes || []).map((n, i, arr) => ({
          id: n.id,
          name: n.name,
          icon: n.icon,
          litDate: n.litDate,
          dayStepsText: util.formatNumber(n.daySteps),
          cumStepsText: n.cumSteps > 0 ? util.formatNumber(n.cumSteps) : '—',
          isLast: i === arr.length - 1
        }));
        // 成就总览（§18.2）：六格汇总，点击进入对应详情（§18.3）
        const achievements = [
          { key: 'march', icon: '🏃', label: '行军', value: util.formatNumber(summary.stats.totalSteps) + ' 步' },
          { key: 'route', icon: '🗺️', label: '路线', value: summary.stats.litCount + ' / ' + summary.stats.totalCount },
          { key: 'quiz', icon: '📚', label: '情报', value: summary.quiz.totalCount + ' 次' },
          { key: 'streak', icon: '🔥', label: '连续', value: summary.stats.currentStreak + ' 天' },
          { key: 'medal', icon: '🏅', label: '勋章', value: summary.medals.ownedCount + ' / ' + summary.medals.totalCount },
          { key: 'points', icon: '⭐', label: '积分', value: util.formatNumber(summary.points.total) }
        ];
        this.setData({
          loading: false,
          errorMsg: '',
          summary,
          stage: stageTitle(summary.stats.progress),
          totalStepsText: util.formatNumber(summary.stats.totalSteps),
          distanceText: summary.stats.totalDistance.toFixed(1),
          timeline,
          footprints,
          achievements
        }, () => this.drawPortrait());
      })
      .catch(() => {
        this.setData({ loading: false, errorMsg: '档案加载失败，请稍后重试' });
      });
  },

  /** 足迹地图：点击节点展开/收起抵达详情（§7.3） */
  toggleFootprint(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ fpSelected: this.data.fpSelected === id ? 0 : id });
  },

  /** 成就总览：按格跳转对应详情页（§18.3；积分无独立详情页不跳转） */
  goAchievement(e) {
    const key = e.currentTarget.dataset.key;
    const nav = {
      march: () => wx.navigateTo({ url: '/pages/calendar/calendar' }),
      route: () => wx.switchTab({ url: '/pages/march/march' }),
      quiz: () => wx.navigateTo({ url: '/pages/quiz-records/quiz-records' }),
      streak: () => wx.navigateTo({ url: '/pages/sport-records/sport-records' }),
      medal: () => wx.navigateTo({ url: '/pages/medals/medals' })
    };
    if (nav[key]) nav[key]();
  },

  /** 数据画像雷达图（§17）：三层五边形网格 + 五维数值多边形，仅呈现数据（§17.4） */
  drawPortrait() {
    const summary = this.data.summary;
    if (!summary || !summary.portrait) return;
    const portrait = summary.portrait;
    wx.createSelectorQuery()
      .in(this)
      .select('#portraitCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const { node, width, height } = res[0];
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;
        node.width = width * dpr;
        node.height = height * dpr;
        const ctx = node.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);

        const n = PORTRAIT_DIMS.length;
        const cx = width / 2;
        const cy = height / 2 + 6;
        const radius = Math.min(width, height) / 2 - 52;
        const angleAt = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
        const pointAt = (i, r) => [cx + r * Math.cos(angleAt(i)), cy + r * Math.sin(angleAt(i))];
        const valueAt = (i) => Math.max(0, Math.min(100, portrait[PORTRAIT_DIMS[i].key] || 0));

        for (let ring = 1; ring <= 3; ring += 1) {
          ctx.beginPath();
          for (let i = 0; i <= n; i += 1) {
            const p = pointAt(i % n, (radius * ring) / 3);
            if (i === 0) ctx.moveTo(p[0], p[1]);
            else ctx.lineTo(p[0], p[1]);
          }
          ctx.strokeStyle = ring === 3 ? '#D8C9A8' : '#EBE0C9';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        for (let i = 0; i < n; i += 1) {
          const p = pointAt(i, radius);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(p[0], p[1]);
          ctx.strokeStyle = '#EBE0C9';
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        ctx.beginPath();
        for (let i = 0; i <= n; i += 1) {
          const p = pointAt(i % n, (radius * valueAt(i % n)) / 100);
          if (i === 0) ctx.moveTo(p[0], p[1]);
          else ctx.lineTo(p[0], p[1]);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(200, 16, 46, 0.16)';
        ctx.fill();
        ctx.strokeStyle = '#C8102E';
        ctx.lineWidth = 2;
        ctx.stroke();

        for (let i = 0; i < n; i += 1) {
          const p = pointAt(i, (radius * valueAt(i)) / 100);
          ctx.beginPath();
          ctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
          ctx.fillStyle = '#E8B84B';
          ctx.fill();
        }

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < n; i += 1) {
          const p = pointAt(i, radius + 28);
          ctx.fillStyle = '#4A3B2A';
          ctx.font = '12px sans-serif';
          ctx.fillText(PORTRAIT_DIMS[i].label, p[0], p[1] - 8);
          ctx.fillStyle = '#A00D26';
          ctx.font = 'bold 12px sans-serif';
          ctx.fillText(String(valueAt(i)), p[0], p[1] + 8);
        }
      });
  },

  goCalendar() {
    wx.navigateTo({ url: '/pages/calendar/calendar' });
  },

  goNodeDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/node-detail/node-detail?id=' + id });
  }
});
