/**
 * 运动数据服务（数据来自后端）。
 *
 * 业务规则（需求文档 8.3 / 规则1）：
 *   按「用户 + 日期」保存每日步数；同一天多次同步时，
 *   以当天最新数据覆盖，绝不执行 累计 += 当前步数。
 *
 * 步数来源：wx.getWeRunData 加密数据 → 后端用 session_key 解密取当日真实步数；
 * 仅开发模式（mock 登录用户或未配置微信凭证）由后端按日期模拟，真实用户绝不编造步数。
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
 * wx.login Promise 化：换取 code（后端据此换 session_key 解密运动数据）
 * @returns {Promise<string>}
 */
function wxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => (res.code ? resolve(res.code) : reject(new Error('微信登录失败，请重试'))),
      fail: () => reject(new Error('微信登录失败，请重试'))
    });
  });
}

/**
 * wx.getWeRunData Promise 化：获取加密的微信运动数据
 * @returns {Promise<{encryptedData:string, iv:string}>}
 */
function getWeRunData() {
  return new Promise((resolve, reject) => {
    wx.getWeRunData({
      success: (res) => resolve({ encryptedData: res.encryptedData, iv: res.iv }),
      fail: (e) => {
        // 微信侧明确原因（如未开通微信运动）直接透传，便于用户自助解决
        const errMsg = (e && e.errMsg) || '';
        if (errMsg.indexOf('开通微信运动') > -1) {
          reject(new Error('请先在微信中开通「微信运动」后再同步'));
        } else {
          reject(new Error('获取微信运动数据失败，请稍后重试'));
        }
      }
    });
  });
}

/**
 * 同步今日步数（后端解密微信运动数据落库并刷新勋章）。
 * 授权/登录/取数任一失败即抛错，不向服务端发请求，避免写入非真实步数。
 * @returns {Promise<{date:string, steps:number, totalSteps:number, synced:boolean}>}
 */
function syncToday() {
  return authorizeWeRun()
    .then((granted) => {
      if (!granted) throw new Error('未授权微信运动，无法同步步数');
      return wxLoginCode().then((code) =>
        getWeRunData().then((wd) => ({
          code: code,
          encryptedData: wd.encryptedData,
          iv: wd.iv
        }))
      );
    })
    .then((payload) =>
      requestService.request({ url: '/sport/sync', method: 'POST', data: payload })
    );
}

/**
 * 获取今日步数概况（含连续行军卡片字段）。
 * @returns {Promise<{date:string, steps:number, target:number, totalSteps:number,
 *   currentStreak:number, maxStreak:number, streakGoal:number, todayGoalCompleted:boolean,
 *   nextStreakMilestone:number|null, streakRemain:number}>}
 */
function getToday() {
  return requestService.request({ url: '/sport/today' });
}

/**
 * 行军日历（整月逐日步数档位 + 答题/点亮标记 + 月度统计）。
 * @param {string} month 格式 YYYY-MM
 * @returns {Promise<{month:string, days:Array, stats:object}>}
 */
function getCalendar(month) {
  return requestService.request({ url: '/sport/calendar?month=' + month });
}

/**
 * 获取最近 n 天运动记录（从旧到新）。
 * @param {number} n
 * @returns {Promise<Array<{date:string, steps:number, text:string}>>}
 */
function getRecent(n) {
  return requestService.request({ url: '/sport/recent?n=' + (n || 7) });
}

module.exports = {
  DAILY_TARGET,
  syncToday,
  getToday,
  getCalendar,
  getRecent
};
