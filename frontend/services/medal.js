/**
 * 勋章服务：勋章列表（后端在步数/答题/点亮等行为后统一评估发放）。
 */
const requestService = require('./request');

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
  getMedalList
};
