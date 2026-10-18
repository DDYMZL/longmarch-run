/**
 * 排行榜服务：员工总积分榜 / 组织（部门）榜 / 用户卡（与管理端「排名洞察」同一口径，数据来自后端）。
 * 契约（camelCase）：
 * - GET /rank/points?orgId=&scope=all|org&page=&pageSize= → {top,list,me,page,pageSize,hasMore,total}
 * - GET /rank/orgs → {items:[{orgId,orgName,memberCount,totalSteps,avgPoints,litNodes}]}
 * - GET /rank/user/{userId} → {nickname,avatar,orgName,points,steps,litNodes,medalCount,rank}
 */
const requestService = require('./request');

/**
 * 总积分榜：top 为第 1~10 名；list 为第 11 名起的第 page 页；me 为当前用户（未上榜为 null）。
 * 排序：总积分降序，同分按累计步数、再按用户 ID。
 * @param {number} page 第 11 名起的分页页码（从 1 开始）
 * @param {number} pageSize 每页条数（后端上限 50）
 * @param {{orgId?:number|string, scope?:'all'|'org'}} [opts] scope=org 时按 orgId 过滤（缺省用本人组织）
 * @returns {Promise<{top:Array, list:Array, me:object|null, page:number, pageSize:number, hasMore:boolean, total:number}>}
 * 榜单项：{rank, userId, nickname, avatar, orgName, steps, points, walkPoints, quizPoints, isMe}
 */
function getPointsRank(page, pageSize, opts) {
  const o = opts || {};
  const query = ['page=' + (page || 1), 'pageSize=' + (pageSize || 20)];
  if (o.scope) query.push('scope=' + o.scope);
  if (o.orgId !== undefined && o.orgId !== null && o.orgId !== '') query.push('orgId=' + o.orgId);
  return requestService.request({ url: '/rank/points?' + query.join('&') });
}

/**
 * 组织（部门）榜：各部门的聚合排名。
 * @returns {Promise<{items:Array<{orgId:number,orgName:string,memberCount:number,totalSteps:number,avgPoints:number,litNodes:number}>}>}
 */
function getOrgRank() {
  return requestService.request({ url: '/rank/orgs' });
}

/**
 * 用户卡：某个用户的排行概要（点击榜单项/领奖台/荣誉卡时展示）。
 * @param {number|string} userId
 * @returns {Promise<{nickname:string,avatar:string,orgName:string,points:number,steps:number,litNodes:number,medalCount:number,rank:number}>}
 */
function getUserCard(userId) {
  return requestService.request({ url: '/rank/user/' + userId });
}

module.exports = {
  getPointsRank,
  getOrgRank,
  getUserCard
};
