/**
 * 积分服务：积分概览与按日明细（全部由后端台账计算，前端只展示）。
 *
 * 规则（以后端 rules 为准）：总积分 = 步行积分 + 答题积分；
 * 步行按日期累计有效步数每满 1000 步计 1 分、每日最多 20000 步参与累计，答题每答对 1 题 +2、单日上限 10。
 */
const requestService = require('./request');

/**
 * 积分概览。
 * @returns {Promise<{total:number, walk:number, quiz:number, todayWalk:number, todayQuiz:number,
 *   todaySteps:number, todayCorrect:number, rank:number|null,
 *   rules:{walkStepsPerPoint:number, walkStepCap:number, walkDailyCap:number, quizPerCorrect:number, quizDailyCap:number}}>}
 */
function getSummary() {
  return requestService.request({ url: '/points' });
}

/**
 * 积分明细（按自然日倒序分页）。
 * @param {number} page 从 1 开始
 * @param {number} pageSize 每页天数（后端上限 100）
 * @returns {Promise<{total:number, items:Array<{date:string, walk:number, quiz:number, total:number, steps:number, correctCount:number, updatedAt:string|null}>}>}
 */
function getDaily(page, pageSize) {
  return requestService.request({
    url: '/points/daily?page=' + (page || 1) + '&page_size=' + (pageSize || 20)
  });
}

module.exports = {
  getSummary,
  getDaily
};
