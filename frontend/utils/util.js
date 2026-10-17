/**
 * 通用工具：日期处理、数字格式化
 */

/** 补零 */
function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * 格式化日期为 YYYY-MM-DD
 * @param {Date} [d]
 */
function formatDate(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 千分位格式化数字，如 25000 -> 25,000 */
function formatNumber(num) {
  return String(num || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 中文大数格式化：>=1亿 -> 1.63亿，>=1万 -> 5000万，否则千分位 */
function formatCn(num) {
  const v = Number(num) || 0;
  if (v >= 100000000) return String(Number((v / 100000000).toFixed(2))) + '亿';
  if (v >= 10000) return String(Number((v / 10000).toFixed(1))) + '万';
  return formatNumber(v);
}

/**
 * 格式化后端时间为本地 YYYY-MM-DD HH:mm。
 * 后端时间列为 UTC 存储的 naive ISO（无时区后缀），按 UTC 解析再转本地显示。
 * @param {string} iso 如 2026-10-01T16:10:35.619914
 */
function formatTime(iso) {
  const t = parseUtc(iso);
  if (isNaN(t)) return '';
  const d = new Date(t);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 解析后端 UTC naive ISO 时间为时间戳（无效返回 NaN）。 */
function parseUtc(iso) {
  if (!iso) return NaN;
  return new Date(String(iso) + (String(iso).indexOf('Z') >= 0 ? '' : 'Z')).getTime();
}

/**
 * 相对时间（实时动态用）：刚刚 / N分钟前 / N小时前 / 昨天 / M-D。
 * @param {string} iso 后端 UTC naive ISO
 */
function formatRelative(iso) {
  const t = parseUtc(iso);
  if (isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + '小时前';
  if (diff < 48 * 60 * 60 * 1000) return '昨天';
  const d = new Date(t);
  return (d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 用户事件图标（时间轴与实时动态共用；STREAK_* 前缀统一 🔥） */
const EVENT_ICONS = {
  FIRST_STEP: '👣',
  DAILY_GOAL: '🎯',
  NODE_UNLOCK: '🚩',
  CHAPTER_COMPLETE: '⭐',
  BADGE_UNLOCK: '🎖️',
  QUIZ_COMPLETE: '✅',
  QUIZ_FULL_SCORE: '💯',
  STEP_10000: '🏃',
  TOTAL_STEPS_100000: '🏆',
  TOTAL_STEPS_500000: '🏆',
  COMPLETE_ROUTE: '🏆'
};

function eventIcon(eventType) {
  if (EVENT_ICONS[eventType]) return EVENT_ICONS[eventType];
  if (eventType && eventType.indexOf('STREAK_') === 0) return '🔥';
  return '📌';
}

/**
 * 答题逐题进度 -> 进度点展示数据（quiz 页与答题页共用）。
 * @param {Array<{seq:number, status:string, correct:boolean}>} progress 后端 progress
 * @param {boolean} [reveal=true] 是否揭示对错；交卷模式传 false 时已答题统一显示为 done（中性态，不泄露对错）
 * @returns {Array<{seq:number, cls:string}>} cls：right / wrong / done / timeout / answering / pending
 */
function quizDots(progress, reveal) {
  const showResult = reveal !== false;
  return (progress || []).map((p) => ({
    seq: p.seq,
    cls: p.status === 'answered' ? (showResult ? (p.correct ? 'right' : 'wrong') : 'done') : p.status
  }));
}

module.exports = {
  pad,
  formatDate,
  formatNumber,
  formatCn,
  formatTime,
  formatRelative,
  eventIcon,
  quizDots
};
