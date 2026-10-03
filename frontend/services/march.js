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
 * 按当前累计步数点亮达标节点（后端发放积分、判定章节完成并刷新勋章）。
 * @returns {Promise<{newlyLit:Array, newlyCompletedChapters:Array}>}
 *   newlyLit 本次新点亮节点（含 gainedPoints/nextNode，供抵达事件卡）；
 *   newlyCompletedChapters 本次新完成章节（含 title/intro，供章节完成仪式）。
 */
function lightUpNodes() {
  return requestService
    .request({ url: '/march/light-up', method: 'POST' })
    .then((result) => ({
      newlyLit: result.newlyLit || [],
      newlyCompletedChapters: result.newlyCompletedChapters || []
    }));
}

/**
 * 全员共同长征目标（需求 §11）：全员累计步数 / 2 亿步总目标 / 阶段里程碑。
 * @returns {Promise<{totalSteps:number, targetSteps:number, progressPct:number, milestones:Array<{name:string, steps:number, reached:boolean}>, nextMilestone:object|null}>}
 */
function getGlobalGoal() {
  return requestService.request({ url: '/march/global' });
}

/**
 * 我的长征足迹（需求 §7）：已点亮节点的点亮日期/当日步数/点亮时累计步数。
 * @returns {Promise<{nodes:Array<{id:number, name:string, icon:string, litAt:string, litDate:string, daySteps:number, cumSteps:number}>}>}
 */
function getFootprints() {
  return requestService.request({ url: '/march/footprints' });
}

/**
 * 标记长征完成仪式已观看（需求 §20.4：仅第一次完成路线触发完整动画）。
 * @returns {Promise<{ok:boolean}>}
 */
function markCeremony() {
  return requestService.request({ url: '/march/ceremony', method: 'POST' });
}

module.exports = {
  getRoute,
  getNodeDetail,
  lightUpNodes,
  getGlobalGoal,
  getFootprints,
  markCeremony
};
