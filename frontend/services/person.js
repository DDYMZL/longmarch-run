/**
 * 长征人物志服务（需求 §14）：人物详情（含相关历史事件节点）。
 */
const requestService = require('./request');

/**
 * 人物志详情：头像/名称/简介 + 相关历史事件（路线节点）与历史时间。
 * @param {number} id 人物 id
 * @returns {Promise<{id:number, name:string, avatar:string, brief:string, nodes:Array}>}
 */
function getPerson(id) {
  return requestService.request({ url: '/persons/' + id });
}

module.exports = {
  getPerson
};
