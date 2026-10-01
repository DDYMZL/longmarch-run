/**
 * 运动数据服务（数据来自后端）。
 *
 * 业务规则（需求文档 8.3 / 规则1）：
 *   按「用户 + 日期」保存每日步数；同一天多次同步时，
 *   以当天最新数据覆盖，绝不执行 累计 += 当前步数。
 *
 * 正式版步数来源：wx.getWeRunData 返回加密数据，需后端解密；
 * 当前后端同步接口未接入真实数据时按日期模拟。
 */
const requestService = require('./request');

const DAILY_TARGET = 10000; // 今日目标步数（展示用）

/**
 * 发起微信运动授权
 * @returns {Promise<boolean>} 是否授权成功
 */
function authorizeWeRun() {
  return new Promise((resolve) => {
    wx.authorize({
      scope: 'scope.werun',
      success: () => resolve(true),
      fail: () => resolve(false)
    });
  });
}

/**
 * 同步今日步数（后端返回同步结果并刷新勋章）。
 * @returns {Promise<{date:string, steps:number, totalSteps:number, synced:boolean}>}
 */
function syncToday() {
  return authorizeWeRun().then(() =>
    requestService.request({ url: '/sport/sync', method: 'POST' })
  );
}

/**
 * 获取今日步数概况。
 * @returns {Promise<{date:string, steps:number, target:number, totalSteps:number}>}
 */
function getToday() {
  return requestService.request({ url: '/sport/today' });
}

/**
 * 获取最近 n 天运动记录（从旧到新）。
 * @param {number} n
 * @returns {Promise<Array<{date:string, steps:number, text:string}>>}
 */
function getRecent(n) {
  return requestService.request({ url: '/sport/recent?n=' + (n || 7) });
}

/**
 * 手动补充步数（开发/演示用，模拟用户当天多走了一些）。
 * 实际产品中步数由微信运动返回，此方法用于无真机环境演示。
 * @param {number} delta
 * @returns {Promise<{date:string, steps:number, target:number, totalSteps:number}>}
 */
function addSteps(delta) {
  return requestService.request({ url: '/sport/add', method: 'POST', data: { delta } });
}

module.exports = {
  DAILY_TARGET,
  authorizeWeRun,
  syncToday,
  getToday,
  getRecent,
  addSteps
};
