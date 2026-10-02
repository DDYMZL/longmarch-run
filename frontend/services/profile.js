/**
 * 个人档案服务：档案聚合（summary）与长征足迹时间轴（timeline）。
 */
const requestService = require('./request');

/**
 * 档案页聚合数据。
 * @returns {Promise<{user:object, stats:object, quiz:object, medals:object, points:object}>}
 */
function getSummary() {
  return requestService.request({ url: '/profile/summary' });
}

/**
 * 我的长征足迹（事件倒序，文案由后端生成）。
 * @param {number} limit
 * @returns {Promise<Array<{eventType:string, eventTime:string, text:string, data:object}>>}
 */
function getTimeline(limit) {
  return requestService
    .request({ url: '/profile/timeline?limit=' + (limit || 50) })
    .then((result) => result.items || []);
}

module.exports = {
  getSummary,
  getTimeline
};
