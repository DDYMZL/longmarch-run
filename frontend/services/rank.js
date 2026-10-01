/**
 * 排行榜服务：全员工累计步数总榜（数据来自后端）。
 */
const requestService = require('./request');

/**
 * 获取步数排行榜。
 * @returns {Promise<{list:Array, myRank:number|null, mySteps:number, total:number}>}
 * list 项：{rank, userId, nickname, avatar, orgName, steps, isMe}
 */
function getStepsRank() {
  return requestService.request({ url: '/rank/steps' });
}

module.exports = {
  getStepsRank
};
