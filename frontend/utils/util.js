/**
 * 通用工具：日期处理、数字格式化、随机数
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

/**
 * 获取最近 n 天的日期数组（含今天，从旧到新）
 * @param {number} n
 */
function recentDates(n) {
  const list = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    list.push(formatDate(d));
  }
  return list;
}

/** 千分位格式化数字，如 25000 -> 25,000 */
function formatNumber(num) {
  return String(num || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 生成 [min, max] 范围内的随机整数 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 洗牌算法，返回新数组
 */
function shuffle(arr) {
  const result = arr.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}

/**
 * 基于日期字符串生成稳定的伪随机数（同一天结果一致，用于 Mock 步数）
 */
function seededSteps(dateStr, userId) {
  let seed = 0;
  const key = dateStr + '|' + userId;
  for (let i = 0; i < key.length; i++) {
    seed = (seed * 31 + key.charCodeAt(i)) % 100000;
  }
  return 4000 + (seed % 9000); // 4000 ~ 12999 步
}

module.exports = {
  pad,
  formatDate,
  recentDates,
  formatNumber,
  randomInt,
  shuffle,
  seededSteps
};
