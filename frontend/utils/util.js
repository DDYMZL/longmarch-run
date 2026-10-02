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

/**
 * 格式化后端时间为本地 YYYY-MM-DD HH:mm。
 * 后端时间列为 UTC 存储的 naive ISO（无时区后缀），按 UTC 解析再转本地显示。
 * @param {string} iso 如 2026-10-01T16:10:35.619914
 */
function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(String(iso) + 'Z');
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

module.exports = {
  pad,
  formatDate,
  formatNumber,
  formatTime
};
