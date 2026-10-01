/**
 * 组织架构服务：逐级浏览与选定所属组织（数据来自后端）。
 */
const requestService = require('./request');

/**
 * 获取某层级的组织列表；parentId 为空返回顶级。
 * @param {number|null} parentId
 * @returns {Promise<Array<{id:number, name:string, parentId:number|null, level:number, hasChildren:boolean, childCount:number}>>}
 */
function getChildren(parentId) {
  const url = parentId ? '/org/children?parentId=' + parentId : '/org/children';
  return requestService.request({ url }).then((result) => result.nodes || []);
}

/**
 * 选定/修改所属组织，返回选定后的组织信息。
 * @param {number} orgId
 * @returns {Promise<{orgId:number, orgName:string, fullName:string, path:Array}>}
 */
function select(orgId) {
  return requestService.request({ url: '/org/select', method: 'POST', data: { orgId } });
}

module.exports = {
  getChildren,
  select
};
