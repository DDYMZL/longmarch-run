/**
 * 排行榜服务：全员工总积分榜（与管理端「排名洞察」同一口径，数据来自后端）。
 */
const requestService = require('./request');

/**
 * 总积分榜：top 为第 1~10 名；list 为第 11 名起的第 page 页；me 为当前用户（未上榜为 null）。
 * 排序：总积分降序，同分按累计步数、再按用户 ID。
 * @param {number} page 第 11 名起的分页页码（从 1 开始）
 * @param {number} pageSize 每页条数（后端上限 50）
 * @returns {Promise<{top:Array, list:Array, me:object|null, page:number, pageSize:number, hasMore:boolean, total:number}>}
 * 榜单项：{rank, userId, nickname, avatar, orgName, steps, points, walkPoints, quizPoints, isMe}
 */
function getPointsRank(page, pageSize) {
  return requestService.request({
    url: '/rank/points?page=' + (page || 1) + '&page_size=' + (pageSize || 20)
  });
}

module.exports = {
  getPointsRank
};
