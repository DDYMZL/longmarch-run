/**
 * 遗留数据迁移工具：Mock 时代 Storage 数据 → 真实后端用户 ID 的一次性复制。
 * 业务数据已全部落库后端，本模块仅保留登录时的旧数据迁移职责。
 *
 * 旧数据结构（Storage 键 lm_data_{userId}）：
 * {
 *   dailySport:  { '2026-09-30': 8236, ... },        // 每日步数（userId+date 唯一）
 *   litNodes:    [1, 2, ...],                        // 已点亮节点 id
 *   quizRecords: { '2026-09-30': {...} },            // 每日答题记录（userId+date 唯一）
 *   pointsLog:   [{ date, reason, delta }],          // 积分流水
 *   medals:      ['first-step', ...],                // 已获得勋章
 *   firstSyncAt: '2026-09-30'                        // 首次同步步数日期
 * }
 */
const KEY_PREFIX = 'lm_data_';

/** 旧 Mock 用户数据的初始结构（迁移时补齐缺失字段） */
function emptyData() {
  return {
    dailySport: {},
    litNodes: [],
    quizRecords: {},
    pointsLog: [],
    medals: [],
    firstSyncAt: ''
  };
}

/**
 * 首次切换到后端用户 ID 时复制旧 Mock 用户数据；目标已有数据则不覆盖。
 * @param {string|number} fromUserId
 * @param {string|number} toUserId
 * @returns {boolean}
 */
function migrateUserData(fromUserId, toUserId) {
  if (!fromUserId || !toUserId || String(fromUserId) === String(toUserId)) return false;
  try {
    const target = wx.getStorageSync(KEY_PREFIX + toUserId);
    if (target && typeof target === 'object') return false;
    const source = wx.getStorageSync(KEY_PREFIX + fromUserId);
    if (!source || typeof source !== 'object') return false;
    wx.setStorageSync(KEY_PREFIX + toUserId, Object.assign(emptyData(), source));
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  migrateUserData
};
