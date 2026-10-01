/**
 * 勋章服务（Mock）
 * 勋章由"后端"根据用户行为自动发放（需求文档 二十一）。
 * 每次业务数据变化后调用 checkAndGrant 刷新勋章。
 */
const store = require('./store');
const { MEDALS } = require('../mock/data');
const march = require('./march');

/**
 * 检查并发放勋章
 * @param {string} userId
 * @returns {Array<string>} 本次新获得的勋章 id
 */
function checkAndGrant(userId) {
  const data = store.getUserData(userId);

  // 1. 初次出发：完成第一次运动同步
  // 2. 红色学习者：完成 10 次答题
  // 3. 知识达人：累计答题积分达到 500（Mock 下按积分流水总额判定）
  // 4. 飞夺泸定桥 / 翻越雪山：点亮对应节点
  // 5. 长征胜利：点亮当前全部启用节点
  const routeNodes = march.getRouteNodes();
  const totalSteps = Object.keys(data.dailySport).reduce(
    (sum, d) => sum + (data.dailySport[d] || 0),
    0
  );
  const quizCount = Object.keys(data.quizRecords).length;
  const totalPoints = data.pointsLog.reduce((sum, item) => sum + item.delta, 0);

  const nodeByName = {
    '飞夺泸定桥': 6,
    '翻越雪山': 7
  };
  const litNodeIds = {};
  data.litNodes.forEach((id) => (litNodeIds[id] = true));

  // 未点亮但步数已达标的启用节点视为已点亮（与 march 服务口径一致）
  routeNodes.forEach((node) => {
    if (totalSteps >= node.targetSteps) litNodeIds[node.id] = true;
  });

  const candidates = [];
  if (data.firstSyncAt) candidates.push('first-step');
  if (quizCount >= 10) candidates.push('learner');
  if (totalPoints >= 500) candidates.push('master');
  if (litNodeIds[nodeByName['飞夺泸定桥']]) candidates.push('luding');
  if (litNodeIds[nodeByName['翻越雪山']]) candidates.push('snow');
  if (routeNodes.every((node) => litNodeIds[node.id])) candidates.push('victory');

  const newly = [];
  candidates.forEach((id) => {
    if (data.medals.indexOf(id) < 0) {
      data.medals.push(id);
      newly.push(id);
    }
  });
  if (newly.length > 0) {
    store.saveUserData(userId, data);
  }
  return newly;
}

/**
 * 获取勋章列表（含未获得状态）
 * @returns {Array<{id,name,icon,desc,owned:boolean}>}
 */
function getMedalList(userId) {
  const data = store.getUserData(userId);
  const ownedSet = {};
  data.medals.forEach((id) => (ownedSet[id] = true));
  return MEDALS.map((m) => ({
    id: m.id,
    name: m.name,
    icon: m.icon,
    desc: m.desc,
    owned: !!ownedSet[m.id]
  }));
}

/**
 * 已获得勋章数量
 */
function getOwnedCount(userId) {
  const data = store.getUserData(userId);
  return data.medals.length;
}

module.exports = {
  checkAndGrant,
  getMedalList,
  getOwnedCount
};
