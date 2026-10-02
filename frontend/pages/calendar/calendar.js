/**
 * 行军日历页
 * 月历四档色阶（0 无 / 1: 1-4999 / 2: 5000-9999 达标 / 3: 10000+）
 * 月统计条 + 点击日期查看当日详情（步数/答题/点亮节点）
 */
const app = getApp();
const sport = require('../../services/sport');
const util = require('../../utils/util');

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** YYYY-MM */
function monthStr(y, m) {
  return y + '-' + util.pad(m);
}

Page({
  data: {
    loading: true,
    errorMsg: '',
    year: 2026,
    month: 10,
    monthTitle: '',
    isCurrentMonth: true,
    weekdays: WEEKDAYS,
    cells: [],
    stats: null,
    selected: null
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    const now = new Date();
    this.setData({ year: now.getFullYear(), month: now.getMonth() + 1 });
    this.loadMonth();
  },

  loadMonth() {
    const { year, month } = this.data;
    const now = new Date();
    this.setData({
      loading: true,
      errorMsg: '',
      monthTitle: year + ' 年 ' + month + ' 月',
      isCurrentMonth: year === now.getFullYear() && month === now.getMonth() + 1
    });

    sport
      .getCalendar(monthStr(year, month))
      .then((res) => {
        this.setData({
          loading: false,
          cells: this.buildCells(year, month, res.days),
          stats: res.stats,
          selected: null
        });
      })
      .catch(() => {
        this.setData({ loading: false, errorMsg: '日历加载失败，请稍后重试' });
      });
  },

  /**
   * 构建月历格子：前导空格 + 当月每日（合并后端返回的步数/标记）
   */
  buildCells(year, month, days) {
    const dayMap = {};
    (days || []).forEach((d) => {
      dayMap[d.date] = d;
    });

    const todayStr = util.formatDate(new Date());
    const firstWeekday = new Date(year, month - 1, 1).getDay();
    const dayCount = new Date(year, month, 0).getDate();

    const cells = [];
    for (let i = 0; i < firstWeekday; i++) {
      cells.push({ key: 'blank-' + i, blank: true });
    }
    for (let d = 1; d <= dayCount; d++) {
      const dateStr = monthStr(year, month) + '-' + util.pad(d);
      const info = dayMap[dateStr] || { date: dateStr, steps: 0, level: 0 };
      cells.push({
        key: dateStr,
        blank: false,
        day: d,
        date: dateStr,
        steps: info.steps,
        level: info.level,
        goalCompleted: !!info.goalCompleted,
        quizDone: !!info.quizDone,
        quizScore: info.quizScore || 0,
        litNodes: info.litNodes || [],
        isToday: dateStr === todayStr
      });
    }
    return cells;
  },

  prevMonth() {
    let { year, month } = this.data;
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
    this.setData({ year, month });
    this.loadMonth();
  },

  nextMonth() {
    if (this.data.isCurrentMonth) return;
    let { year, month } = this.data;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    this.setData({ year, month });
    this.loadMonth();
  },

  /**
   * 点击日期：展示当日详情卡
   */
  handleDayTap(e) {
    const cell = e.currentTarget.dataset.cell;
    if (!cell || cell.blank) return;
    this.setData({
      selected: {
        date: cell.date,
        stepsText: util.formatNumber(cell.steps),
        level: cell.level,
        goalCompleted: cell.goalCompleted,
        quizDone: cell.quizDone,
        quizScore: cell.quizScore,
        litNodes: cell.litNodes,
        isToday: cell.isToday
      }
    });
  },

  closeDetail() {
    this.setData({ selected: null });
  },

  noop() {}
});
