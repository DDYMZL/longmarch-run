/**
 * 运动数据服务（Mock 微信运动）
 *
 * 业务规则（需求文档 8.3 / 规则1）：
 *   按「用户 + 日期」保存每日步数；同一天多次同步时，
 *   以当天最新数据覆盖，绝不执行 累计 += 当前步数。
 *
 * 正式版步数来源：wx.getWeRunData 返回加密数据，需后端解密。
 * 当前无后端，同步时尝试发起微信运动授权，
 * 步数使用基于日期的稳定伪随机数模拟（同一天多次同步数值一致）。
 */
const store = require('./store');
const util = require('../utils/util');
const points = require('./points');

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
 * 同步今日步数（Mock）
 * 同一天重复同步会覆盖当天数据，不影响其他日期，不重复累计。
 * @param {string} userId
 * @returns {Promise<{date:string, steps:number, totalSteps:number, synced:boolean}>}
 */
function syncToday(userId) {
  return authorizeWeRun().then(() => {
    const data = store.getUserData(userId);
    const date = util.formatDate();

    // 当天已有记录则视为已同步（数值保持不变，模拟微信运动当日数据）
    if (data.dailySport[date] !== undefined) {
      return {
        date,
        steps: data.dailySport[date],
        totalSteps: calcTotal(data),
        synced: false
      };
    }

    // 首次同步：生成当天模拟步数
    const steps = util.seededSteps(date, userId);
    data.dailySport[date] = steps;
    if (!data.firstSyncAt) data.firstSyncAt = date;
    store.saveUserData(userId, data);

    // 积分：运动达标奖励（≥10000 得 10，≥5000 得 5，取最高档）
    if (steps >= 10000) {
      points.grant(userId, '每日运动达到10000步', 10);
    } else if (steps >= 5000) {
      points.grant(userId, '每日运动达到5000步', 5);
    }

    return {
      date,
      steps,
      totalSteps: calcTotal(data),
      synced: true
    };
  });
}

/**
 * 计算累计有效步数（每日步数求和）
 */
function calcTotal(data) {
  return Object.keys(data.dailySport).reduce((sum, d) => sum + (data.dailySport[d] || 0), 0);
}

/**
 * 获取今日步数
 * @param {string} userId
 * @returns {{date:string, steps:number, target:number, totalSteps:number}}
 */
function getToday(userId) {
  const data = store.getUserData(userId);
  const date = util.formatDate();
  return {
    date,
    steps: data.dailySport[date] || 0,
    target: DAILY_TARGET,
    totalSteps: calcTotal(data)
  };
}

/**
 * 获取最近 n 天运动记录（从旧到新）
 * @returns {Array<{date:string, steps:number, text:string}>}
 */
function getRecent(userId, n) {
  const data = store.getUserData(userId);
  return util.recentDates(n).map((d) => ({
    date: d,
    steps: data.dailySport[d] || 0,
    text: d.slice(5) // MM-DD
  }));
}

/**
 * 手动补充步数（开发/演示用，模拟用户当天多走了一些）
 * 仅更新当天数据，同样遵循覆盖而非累加规则之外的追加语义：
 * 实际产品中步数由微信运动返回，此方法用于无真机环境演示。
 */
function addSteps(userId, delta) {
  const data = store.getUserData(userId);
  const date = util.formatDate();
  const prev = data.dailySport[date] || 0;
  data.dailySport[date] = prev + delta;
  store.saveUserData(userId, data);

  // 达标奖励只在首次同步时发放，这里仅更新步数
  return {
    date,
    steps: data.dailySport[date],
    totalSteps: calcTotal(data)
  };
}

module.exports = {
  DAILY_TARGET,
  authorizeWeRun,
  syncToday,
  getToday,
  getRecent,
  addSteps,
  calcTotal
};
