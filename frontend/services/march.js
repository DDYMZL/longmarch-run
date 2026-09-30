/**
 * 长征路线服务
 *
 * 节点状态规则（需求文档 十一 / 规则2 / 规则3）：
 *   - unlocked    未解锁：累计步数未达到上一个节点（不可查看详情）
 *   - current     进行中：达到上一个节点但未达到当前节点（可查看详情，高亮）
 *   - completed   已点亮：累计步数达到目标
 *   - 节点一旦点亮永久保留，即使后续步数下降也不取消
 */
const store = require('./store');
const { ROUTE_NODES } = require('../mock/data');
const points = require('./points');

/**
 * 计算节点状态列表 + 路线整体进度
 * @param {string} userId
 * @returns {{nodes:Array, currentSteps:number, totalSteps:number, litCount:number, nextNode:object|null, finished:boolean}}
 */
function getRoute(userId) {
  const data = store.getUserData(userId);
  const currentSteps = Object.keys(data.dailySport).reduce(
    (sum, d) => sum + (data.dailySport[d] || 0),
    0
  );
  const litSet = {};
  data.litNodes.forEach((id) => (litSet[id] = true));

  // 依据当前累计步数计算应点亮的节点（规则3：点亮后永久保留）
  ROUTE_NODES.forEach((node) => {
    if (currentSteps >= node.targetSteps) litSet[node.id] = true;
  });

  const nodes = ROUTE_NODES.map((node) => {
    let status = 'unlocked';
    if (litSet[node.id]) {
      status = 'completed';
    } else {
      // 达到上一个节点即进入「进行中」状态（第一个节点目标为 0，始终已点亮）
      const idx = ROUTE_NODES.findIndex((n) => n.id === node.id);
      const prev = ROUTE_NODES[idx - 1];
      if (prev && currentSteps >= prev.targetSteps) status = 'current';
    }
    return {
      id: node.id,
      name: node.name,
      icon: node.icon,
      targetSteps: node.targetSteps,
      status,
      // 进行中节点：距离目标还差多少
      remain: Math.max(node.targetSteps - currentSteps, 0)
    };
  });

  const litCount = nodes.filter((n) => n.status === 'completed').length;
  const finished = litCount >= ROUTE_NODES.length;

  // 下一站 = 第一个未点亮节点
  const nextNode = nodes.find((n) => n.status !== 'completed') || null;

  return {
    nodes,
    currentSteps,
    totalSteps: ROUTE_NODES[ROUTE_NODES.length - 1].targetSteps,
    litCount,
    totalCount: ROUTE_NODES.length,
    nextNode,
    finished
  };
}

/**
 * 获取单个节点详情
 * @param {string} userId
 * @param {number} nodeId
 */
function getNodeDetail(userId, nodeId) {
  const route = getRoute(userId);
  const node = ROUTE_NODES.find((n) => n.id === nodeId);
  if (!node) return null;
  const state = route.nodes.find((n) => n.id === nodeId);
  return Object.assign({}, node, {
    status: state.status,
    remain: state.remain,
    currentSteps: route.currentSteps
  });
}

/**
 * 点亮节点（当累计步数达标时调用，发放节点积分与勋章）
 * 返回本次新点亮的节点列表
 * @param {string} userId
 */
function lightUpNodes(userId) {
  const data = store.getUserData(userId);
  const route = getRoute(userId);
  const newlyLit = [];
  const currentSteps = route.currentSteps;

  ROUTE_NODES.forEach((node) => {
    const already = data.litNodes.indexOf(node.id) >= 0;
    if (currentSteps >= node.targetSteps && !already) {
      data.litNodes.push(node.id);
      newlyLit.push(node);
      // 点亮节点积分 +10
      points.grant(userId, '点亮节点：' + node.name, 10);
    }
  });

  if (newlyLit.length > 0) {
    store.saveUserData(userId, data);

    // 全部点亮：完成长征路线 +100
    // （直接用已点亮数量判定，避免重复调用 getRoute 重算节点状态）
    if (data.litNodes.length >= ROUTE_NODES.length) {
      points.grant(userId, '完成长征路线', 100);
    }
  }
  return newlyLit;
}

module.exports = {
  ROUTE_NODES,
  getRoute,
  getNodeDetail,
  lightUpNodes
};
