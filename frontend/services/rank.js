/**
 * 排名服务（Mock）：全员工「累计步数」总榜（跨所有组织）
 *
 * 无后端时，用 mock/data.js 的 MOCK_MEMBERS 作为模拟对手，
 * 并把真实登录用户以其本人实际累计步数插入榜单，一起排序。
 * 正式接入后端后对应 GET /api/rank/steps，返回结构一致，页面调用方无需改动。
 */
const store = require('./store');
const org = require('./org');
const auth = require('./auth');
const mockData = require('../mock/data');

/** 计算某用户累计步数（每日步数求和） */
function _totalSteps(userId) {
  const data = store.getUserData(userId);
  return Object.keys(data.dailySport).reduce((sum, d) => sum + (data.dailySport[d] || 0), 0);
}

/**
 * 获取全员工步数排行榜
 * @param {string} userId 当前登录用户 id
 * @returns {{list:Array, myRank:number|null, mySteps:number, total:number}}
 */
function getStepsRank(userId) {
  const user = auth.getLocalUser() || {};
  const entries = [];

  // 真实登录用户（本人实际累计步数）
  entries.push({
    userId: userId,
    nickname: user.nickname || '我',
    avatar: user.avatar || '',
    orgName: user.orgId ? org.getFullName(user.orgId) : '',
    steps: _totalSteps(userId),
    isMe: true
  });

  // 模拟对手
  mockData.MOCK_MEMBERS.forEach((m) => {
    entries.push({
      userId: m.id,
      nickname: m.nickname,
      avatar: '',
      orgName: org.getFullName(m.orgId),
      steps: m.steps,
      isMe: false
    });
  });

  // 步数降序
  entries.sort((a, b) => b.steps - a.steps);

  let myRank = null;
  let mySteps = 0;
  entries.forEach((e, i) => {
    e.rank = i + 1;
    if (e.isMe) {
      myRank = e.rank;
      mySteps = e.steps;
    }
  });

  return { list: entries, myRank: myRank, mySteps: mySteps, total: entries.length };
}

module.exports = {
  getStepsRank
};
