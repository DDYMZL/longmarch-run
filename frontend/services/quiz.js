/**
 * 每日答题服务（Mock）
 *
 * 业务规则（需求文档 十四 / 规则4 / 规则5）：
 *   - 每日随机 5 题，每题 20 分，满分 100
 *   - 同一用户、同一天只能完成一次正式答题（userId + date 唯一）
 *   - 答题结果由"后端"计算：提交答案后按正确答案统计得分与积分
 *   - Mock 阶段题目携带 answer/analysis，正式环境不返回给前端
 */
const store = require('./store');
const util = require('../utils/util');
const { QUESTION_BANK } = require('../mock/data');
const points = require('./points');

const DAILY_COUNT = 5;

/**
 * 获取今日题目
 * 同一天内多次调用返回同一套题（保证提交时答案对应）
 * @param {string} userId
 * @returns {{date:string, completed:boolean, questions:Array|null, record:object|null}}
 */
function getDaily(userId) {
  const data = store.getUserData(userId);
  const date = util.formatDate();
  const record = data.quizRecords[date] || null;

  if (record) {
    return { date, completed: true, questions: null, record };
  }

  // 按日期随机抽取固定题组：今天还没有记录时生成并缓存
  const rawKey = 'quiz_daily_' + userId + '_' + date;
  let questions = null;
  try {
    questions = wx.getStorageSync(rawKey) || null;
  } catch (e) {
    questions = null;
  }
  if (!questions || !questions.length) {
    const picked = util.shuffle(QUESTION_BANK).slice(0, DAILY_COUNT);
    questions = picked.map((q) => ({
      id: q.id,
      type: q.type,
      question: q.question,
      options: q.options,
      analysis: q.analysis,
      score: q.score
      // Mock 阶段判分直接读取 QUESTION_BANK，正式环境由后端保存答案
    }));
    wx.setStorageSync(rawKey, questions);
  }

  return { date, completed: false, questions, record: null };
}

/**
 * 提交答卷（每日仅一次）
 * @param {string} userId
 * @param {Array<{questionId:number, answer:Array<string>}>} answers
 * @returns {Promise<{score:number, correctCount:number, totalCount:number, points:number, wrongList:Array}>}
 */
function submit(userId, answers) {
  return new Promise((resolve, reject) => {
    const data = store.getUserData(userId);
    const date = util.formatDate();

    // 规则4：每日只能完成一次
    if (data.quizRecords[date]) {
      reject(new Error('今日答题已完成'));
      return;
    }

    const answerMap = {};
    const analysisMap = {};
    QUESTION_BANK.forEach((q) => {
      answerMap[q.id] = q.answer;
      analysisMap[q.id] = q.analysis;
    });

    let correctCount = 0;
    const totalCount = answers.length;
    const wrongList = [];

    answers.forEach((a, idx) => {
      const right = answerMap[a.questionId] || [];
      const userAnswer = (a.answer || []).slice().sort();
      const rightSorted = right.slice().sort();
      const correct =
        userAnswer.length === rightSorted.length &&
        userAnswer.every((v, i) => v === rightSorted[i]);

      if (correct) {
        correctCount++;
      } else {
        const q = QUESTION_BANK.find((item) => item.id === a.questionId);
        wrongList.push({
          index: idx + 1,
          question: q ? q.question : '',
          correctAnswer: right.join(''),
          analysis: analysisMap[a.questionId] || ''
        });
      }
    });

    const score = correctCount * 20; // 每题 20 分
    const earnedPoints = score === 100 ? 15 : 5; // 每日答题 +5，满分另 +10
    const record = {
      date,
      totalCount,
      correctCount,
      score,
      points: earnedPoints,
      wrongList,
      answerAt: new Date().getTime()
    };

    // 保存记录（userId + date 唯一，防止重复提交）
    data.quizRecords[date] = record;
    store.saveUserData(userId, data);

    // 积分：每日答题 +5；满分额外 +10
    points.grant(userId, '每日答题', 5);
    if (score === 100) {
      points.grant(userId, '答题满分', 10);
    }

    resolve(record);
  });
}

/**
 * 获取答题记录列表（从新到旧）
 */
function getRecords(userId) {
  const data = store.getUserData(userId);
  return Object.keys(data.quizRecords)
    .map((date) => data.quizRecords[date])
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * 重置今日答题（开发调试用）
 * 删除今日答题记录与题目缓存，并撤销今日答题相关积分，
 * 使当天可以重新抽取题目并再次获得答题积分。
 */
function resetToday(userId) {
  const data = store.getUserData(userId);
  const date = util.formatDate();

  // 删除今日答题记录（userId + date 唯一）
  delete data.quizRecords[date];

  // 撤销今日答题相关积分（每日答题 +5 / 答题满分 +10）
  data.pointsLog = data.pointsLog.filter(
    (item) => !(item.date === date && (item.reason === '每日答题' || item.reason === '答题满分'))
  );
  store.saveUserData(userId, data);

  // 清除今日题目缓存，重新随机抽题
  try {
    wx.removeStorageSync('quiz_daily_' + userId + '_' + date);
  } catch (e) {
    // 缓存不存在时忽略
  }
}

module.exports = {
  DAILY_COUNT,
  getDaily,
  submit,
  getRecords,
  resetToday
};
