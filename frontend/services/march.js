/**
 * 长征路线服务
 *
 * 节点状态规则（需求文档 十一 / 规则2 / 规则3）：
 *   - unlocked    未解锁：累计步数未达到上一个节点（仍可查看详情）
 *   - current     进行中：达到上一个节点但未达到当前节点（可查看详情，高亮）
 *   - completed   已点亮：累计步数达到目标
 *   - 节点一旦点亮永久保留，即使后续步数下降也不取消
 */
const store = require('./store');
const { ROUTE_NODES: BUILTIN_ROUTE_NODES } = require('../mock/data');
const points = require('./points');
const requestService = require('./request');

const ROUTE_CACHE_KEY = 'lm_route_nodes';

/**
 * 规范化并校验路线节点配置。
 * @param {Array} nodes
 * @returns {Array}
 */
function normalizeRouteNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((node) =>
      node &&
      Number.isFinite(Number(node.id)) &&
      String(node.name || '').trim() &&
      Number.isFinite(Number(node.targetSteps)) &&
      Number.isFinite(Number(node.latitude)) &&
      Number.isFinite(Number(node.longitude)) &&
      node.isEnabled !== false
    )
    .map((node) => ({
      id: Number(node.id),
      name: String(node.name).trim(),
      icon: String(node.icon || ''),
      targetSteps: Number(node.targetSteps),
      historicalTime: String(node.historicalTime || ''),
      description: String(node.description || ''),
      latitude: Number(node.latitude),
      longitude: Number(node.longitude),
      sortOrder: Number(node.sortOrder) || 0,
      isEnabled: true
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

/**
 * 按“最近有效缓存 -> 内置节点”读取初始配置。
 * @returns {Array}
 */
function loadRouteNodes() {
  try {
    const cached = normalizeRouteNodes(wx.getStorageSync(ROUTE_CACHE_KEY));
    if (cached.length) return cached;
  } catch (e) {
    // Storage 不可用时使用内置节点
  }
  return normalizeRouteNodes(BUILTIN_ROUTE_NODES);
}

let routeNodes = loadRouteNodes();
let refreshVersion = 0;

/**
 * 从后端刷新启用节点，失败时保留当前缓存。
 * @returns {Promise<Array>}
 */
function refreshRouteNodes() {
  const version = ++refreshVersion;
  return requestService.request({ url: '/march/route-nodes' }).then((result) => {
    const nodes = normalizeRouteNodes(result && result.nodes);
    if (!nodes.length) throw new Error('路线配置为空');
    if (version !== refreshVersion) return routeNodes;
    routeNodes = nodes;
    try {
      wx.setStorageSync(ROUTE_CACHE_KEY, nodes);
    } catch (e) {
      // 缓存失败不影响本次展示
    }
    return routeNodes;
  });
}

/**
 * 返回当前生效的路线节点。
 * @returns {Array}
 */
function getRouteNodes() {
  return routeNodes;
}

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
  routeNodes.forEach((node) => {
    if (currentSteps >= node.targetSteps) litSet[node.id] = true;
  });

  const nodes = routeNodes.map((node, index) => {
    let status = 'unlocked';
    if (litSet[node.id]) {
      status = 'completed';
    } else {
      const prev = routeNodes[index - 1];
      if (!prev || currentSteps >= prev.targetSteps) status = 'current';
    }
    return Object.assign({}, node, {
      status,
      remain: Math.max(node.targetSteps - currentSteps, 0)
    });
  });

  const litCount = nodes.filter((n) => n.status === 'completed').length;
  const finished = litCount >= routeNodes.length;

  // 下一站 = 第一个未点亮节点
  const nextNode = nodes.find((n) => n.status !== 'completed') || null;

  return {
    nodes,
    currentSteps,
    totalSteps: routeNodes[routeNodes.length - 1].targetSteps,
    litCount,
    totalCount: routeNodes.length,
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
  const node = routeNodes.find((item) => item.id === nodeId);
  if (!node) return null;
  const state = route.nodes.find((item) => item.id === nodeId);
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

  routeNodes.forEach((node) => {
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

    // 只按当前启用路线判断完成，停用节点的历史点亮记录继续保留。
    if (routeNodes.every((node) => data.litNodes.indexOf(node.id) >= 0)) {
      points.grant(userId, '完成长征路线', 100);
    }
  }
  return newlyLit;
}

module.exports = {
  getRouteNodes,
  refreshRouteNodes,
  getRoute,
  getNodeDetail,
  lightUpNodes
};
