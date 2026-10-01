/**
 * 积分服务：积分总额与流水（后端统一发放与记账）。
 */
const requestService = require('./request');

/**
 * 获取当前总积分。
 * @returns {Promise<number>}
 */
function getTotal() {
  return requestService.request({ url: '/points' }).then((result) => result.total || 0);
}

module.exports = {
  getTotal
};
