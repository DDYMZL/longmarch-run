/**
 * 长征路线服务（数据来自后端）
 *
 * 节点状态规则（需求文档 十一 / 规则2 / 规则3）：
 *   - unlocked    未解锁：累计步数未达到上一个节点（仍可查看详情）
 *   - current     进行中：达到上一个节点但未达到当前节点（可查看详情，高亮）
 *   - completed   已点亮：累计步数达到目标
 *   - 节点一旦点亮永久保留，即使后续步数下降也不取消
 */
const requestService = require('./request');

/**
 * 路线整体进度与节点状态列表。
 * @returns {Promise<{nodes:Array, currentSteps:number, totalSteps:number, litCount:number, totalCount:number, nextNode:object|null, finished:boolean}>}
 */
function getRoute() {
  return requestService.request({ url: '/march/route' });
}

/**
 * 获取单个节点详情（含未解锁节点）。
 * @param {number} nodeId
 * @returns {Promise<object>}
 */
function getNodeDetail(nodeId) {
  return requestService.request({ url: '/march/node/' + nodeId });
}

/**
 * 按当前累计步数点亮达标节点（后端发放积分并刷新勋章）。
 * @returns {Promise<Array>} 本次新点亮的节点
 */
function lightUpNodes() {
  return requestService
    .request({ url: '/march/light-up', method: 'POST' })
    .then((result) => result.newlyLit || []);
}

module.exports = {
  getRoute,
  getNodeDetail,
  lightUpNodes
};
