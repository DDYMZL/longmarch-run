/**
 * 答题服务（V2.0 逐题限时）：今日状态、开题、逐题提交、记录、知识画像、重置。
 *
 * 规则（以后端为准）：每日 5 题逐题开题，每题 timeLimit（90）秒，计时只认服务器时间；
 * 每题仅可提交一次，超时不得分；答对 1 题 +2 积分，单日答题积分上限 10。
 */
const requestService = require('./request');

/**
 * 今日答题状态（不开题）：未开题时 current 为空；已完成时 record 含逐题结果。
 * @returns {Promise<{date:string, issueNo:number, completed:boolean, totalCount:number, timeLimit:number,
 *   serverTime:number, progress:Array<{seq:number, status:string, correct:boolean}>,
 *   current:{seq:number, question:object, startedAt:number, deadlineAt:number, remainingMs:number}|null,
 *   correctCount:number, points:number, record:object|null}>}
 */
function getDaily() {
  return requestService.request({ url: '/quiz/daily' });
}

/**
 * 开始或继续当前题（幂等）：作答中返回同一题与服务器剩余毫秒；当前题已截止则判超时并开下一题。
 * @returns {Promise<object>} 结构同 getDaily
 */
function start() {
  return requestService.request({ url: '/quiz/start', method: 'POST' });
}

/**
 * 提交当前题答案（每题一次，即时判定）。
 * @param {number} questionId
 * @param {string} label 选项标签
 * @returns {Promise<{seq:number, status:string, correct:boolean, userAnswer:Array<string>, correctAnswer:Array<string>,
 *   analysis:string, points:number, correctCount:number, todayPoints:number, totalCount:number, finished:boolean, record:object|null}>}
 */
function answer(questionId, label) {
  return requestService.request({
    url: '/quiz/answer',
    method: 'POST',
    data: { questionId, answer: [label] }
  });
}

/**
 * 知识画像：按题目分类（历史事件/长征路线/历史人物）聚合历史正确率。
 * @returns {Promise<{categories:Array<{key:string, name:string, rate:number, asked:number, wrong:number}>, overallRate:number}>}
 */
function getKnowledge() {
  return requestService.request({ url: '/quiz/knowledge' });
}

/**
 * 分页答题记录（对接后端 A7：GET /quiz/records，新到旧），
 * 每条含正确率 accuracy 与超时题数 timeoutCount。
 * 响应除分页字段外，含后端全局汇总 totalCorrect（全量答对题数）/ avgScore（全量平均整数），
 * request 直接透传整个响应对象，页面可直接消费（无需在此裁剪）。
 * @param {number} page     页码，从 1 开始
 * @param {number} pageSize 每页条数
 * @returns {Promise<{items:Array, total:number, page:number, pageSize:number, hasMore:boolean,
 *   totalCorrect:number, avgScore:number}>}
 */
function getRecords(page, pageSize) {
  const query = 'page=' + (page || 1) + '&pageSize=' + (pageSize || 20);
  return requestService.request({ url: '/quiz/records?' + query });
}

/**
 * 重置今日答题（开发调试用）。
 * @returns {Promise<{message:string}>}
 */
function resetToday() {
  return requestService.request({ url: '/quiz/reset', method: 'POST' });
}

module.exports = {
  getDaily,
  start,
  answer,
  getKnowledge,
  getRecords,
  resetToday
};
