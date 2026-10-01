/**
 * 答题服务：今日题目、提交答卷、答题记录、重置（数据全部来自后端）。
 */
const requestService = require('./request');

const DAILY_COUNT = 5; // 每日题量（后端从题库随机抽取）

/**
 * 今日答题状态；未完成时携带题目（不含答案），已完成时携带记录。
 * @returns {Promise<{date:string, completed:boolean, questions:Array|null, record:object|null}>}
 */
function getDaily() {
  return requestService.request({ url: '/quiz/daily' });
}

/**
 * 提交答卷（后端判分并发放积分）。
 * @param {Array<{questionId:number, answer:Array<string>}>} answers
 * @returns {Promise<object>} 答题记录
 */
function submit(answers) {
  return requestService.request({ url: '/quiz/submit', method: 'POST', data: { answers } });
}

/**
 * 答题记录（新到旧）。
 * @returns {Promise<Array>}
 */
function getRecords() {
  return requestService.request({ url: '/quiz/records' });
}

/**
 * 重置今日答题（开发调试用）。
 * @returns {Promise<{message:string}>}
 */
function resetToday() {
  return requestService.request({ url: '/quiz/reset', method: 'POST' });
}

module.exports = {
  DAILY_COUNT,
  getDaily,
  submit,
  getRecords,
  resetToday
};
