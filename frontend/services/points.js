/**
 * 积分服务（Mock）
 *
 * 积分来源（需求文档 20.1，规则由后台配置）：
 *   每日登录 +1（每天一次）
 *   每日运动达到 5000 步 +5 / 达到 10000 步 +10（取最高档，由 sport 服务调用）
 *   每日答题 +5，答题满分额外 +10（由 quiz 服务调用）
 *   点亮历史节点 +10（由 march 服务调用）
 *   完成长征路线 +100（由 march 服务调用）
 */
const store = require('./store');
const util = require('../utils/util');

/**
 * 发放积分（同一原因每天最多一次，防止重复发放）
 * @param {string} userId
 * @param {string} reason 积分原因
 * @param {number} delta 积分值
 * @returns {boolean} 是否真正发放
 */
function grant(userId, reason, delta) {
  const data = store.getUserData(userId);
  const date = util.formatDate();

  const existed = data.pointsLog.some((item) => item.date === date && item.reason === reason);
  if (existed) return false;

  data.pointsLog.push({ date, reason, delta });
  store.saveUserData(userId, data);
  return true;
}

/**
 * 每日登录积分（app.onLaunch 时调用）
 */
function grantDailyLogin(userId) {
  grant(userId, '每日登录', 1);
}

/**
 * 获取积分总额
 */
function getTotal(userId) {
  const data = store.getUserData(userId);
  return data.pointsLog.reduce((sum, item) => sum + item.delta, 0);
}

module.exports = {
  grant,
  grantDailyLogin,
  getTotal
};
