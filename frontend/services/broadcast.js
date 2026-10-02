/**
 * 今日播报服务：全局播报 + 个人进度 + 长征记忆彩蛋。
 */
const requestService = require('./request');

/**
 * 今日播报聚合。
 * @returns {Promise<{global:object, personal:object, memory:object|null}>}
 */
function getToday() {
  return requestService.request({ url: '/broadcast/today' });
}

module.exports = {
  getToday
};
