/**
 * 每日寄语服务（需求 §16）：今日寄语（有出处的史料语录，可关联路线节点）。
 */
const requestService = require('./request');

/**
 * 今日寄语：当天优先，无当天则后端回退到最近一条不晚于今天的寄语；没有则返回 null。
 * @returns {Promise<{id:number, date:string, content:string, source:string, node:?{id:number,name:string}}|null>}
 */
function getToday() {
  return requestService.request({ url: '/quotes/today' });
}

module.exports = {
  getToday
};
