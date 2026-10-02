/**
 * 勋章服务：勋章列表与检查发放（后端依据用户行为统一评估）。
 */
const requestService = require('./request');

/**
 * 检查并发放勋章（数据变化后调用），返回本次新获得的勋章 id 列表。
 * @returns {Promise<Array<string>>}
 */
function checkAndGrant() {
  return requestService
    .request({ url: '/medal/check', method: 'POST' })
    .then((result) => result.newly || []);
}

/**
 * 获取勋章列表（后端返回前已自动检查发放）。
 * 元素含 category/hidden/sortOrder/grantedAt/conditionDesc（隐藏且未获得时条件不公开）。
 * @returns {Promise<Array<{id:string, name:string, icon:string, desc:string, owned:boolean,
 *   category:string, hidden:boolean, sortOrder:number, grantedAt:string|null, conditionDesc:string}>>}
 */
function getMedalList() {
  return requestService.request({ url: '/medal/list' }).then((result) => result.medals || []);
}

module.exports = {
  checkAndGrant,
  getMedalList
};
