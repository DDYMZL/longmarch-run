/**
 * 活动状态服务：活动名称 / 状态 / 起止时间 / 准入（allowParticipate、allowView）/ 结束文案。
 * 状态由后端按服务器时间实时计算；业务接口同样在后端拦截，前端仅用于展示与引导。
 */
const requestService = require('./request');

/**
 * 获取活动状态，并缓存到 app.globalData.activity 供各页读取。
 * @returns {Promise<{name:string, status:string, statusText:string, startAt:string|null, endAt:string|null,
 *   allowParticipate:boolean, allowView:boolean, restrictEnabled:boolean, endTitle:string, message:string, serverTime:string}>}
 */
function getStatus() {
  return requestService.request({ url: '/activity/status', skipActivityRedirect: true }).then((status) => {
    getApp().globalData.activity = status;
    return status;
  });
}

/** ISO 时间（带 +08:00）转 YYYY-MM-DD HH:mm 展示文本。 */
function formatRange(status) {
  const fmt = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '');
  const start = fmt(status && status.startAt);
  const end = fmt(status && status.endAt);
  return start && end ? start + ' 至 ' + end : '';
}

module.exports = {
  getStatus,
  formatRange
};
