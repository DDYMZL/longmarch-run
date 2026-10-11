/**
 * 每日寄语服务（需求 §16）：今日寄语（有出处的史料语录，可关联路线节点）。
 */
const requestService = require('./request');

/**
 * 今日寄语：后台启用寄语按排序号每天轮换一条（同一天所有用户相同）；无启用寄语返回 null。
 * @returns {Promise<{id:number, date:string, content:string, source:string, node:?{id:number,name:string}}|null>}
 */
function getToday() {
  return requestService.request({ url: '/quotes/today' });
}

module.exports = {
  getToday
};
