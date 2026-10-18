/**
 * 今日播报服务：全局播报 + 个人进度 + 长征记忆彩蛋 + 实时行军动态。
 */
const requestService = require('./request');
const util = require('../utils/util');

/**
 * 组装实时动态视图模型（REST 条目与 WS activity 消息共用）。
 * WS 消息字段为 {eventType, nickname, text, at(ms)}，REST 条目为 {id, eventType, eventTime, nickname, text}。
 */
function toActivityView(item) {
  const atIso = item.eventTime || (item.at ? new Date(item.at).toISOString() : '');
  return {
    id: item.id || 'ws-' + (item.at || Date.now()) + '-' + (item.eventType || ''),
    icon: util.eventIcon(item.eventType),
    nickname: item.nickname || '战友',
    text: item.text || '',
    timeText: util.formatRelative(atIso),
    // 点亮节点类事件携带 nodeId，点击可进入节点详情（B7）
    nodeId: item.nodeId || null
  };
}

/**
 * 今日播报聚合。
 * @returns {Promise<{global:object, personal:object, memory:object|null}>}
 */
function getToday() {
  return requestService.request({ url: '/broadcast/today' });
}

/**
 * 实时行军动态（全用户成就倒序，需求 §8.3/8.5）。
 * @returns {Promise<Array>} 视图模型列表
 */
function getActivities(limit) {
  return requestService
    .request({ url: '/broadcast/activities?limit=' + (limit || 10) })
    .then((res) => (res.items || []).map(toActivityView));
}

module.exports = {
  getToday,
  getActivities,
  toActivityView
};
