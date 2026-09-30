/**
 * 本地数据仓库（Mock 后端）
 * 以 userId 为维度，在 Storage 中维护用户的业务数据。
 * 正式接入后端后，本模块对应后端接口返回值，页面调用方无需改动。
 *
 * 数据结构：
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

/**
 * 内存缓存（按 userId）
 * wx.getStorageSync 为同步读取且伴随反序列化开销，当用户数据（多天运动记录、
 * 大量积分流水）变大时，一次页面刷新内多个服务重复读取会明显拖慢交互。
 * 此处在会话级缓存已解析的数据对象，写入时同步更新缓存与 Storage，
 * 保证跨页面、跨服务读取到一致的最新数据。
 */
const _cache = Object.create(null);

/** 初始化空数据 */
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
 * 读取用户数据（优先命中内存缓存），不存在则返回空数据
 */
function getUserData(userId) {
  if (_cache[userId]) return _cache[userId];

  let data;
  try {
    const raw = wx.getStorageSync(KEY_PREFIX + userId);
    data = raw && typeof raw === 'object' ? Object.assign(emptyData(), raw) : emptyData();
  } catch (e) {
    // 数据损坏时降级为空数据
    data = emptyData();
  }
  _cache[userId] = data;
  return data;
}

/**
 * 保存用户数据（同步更新缓存与 Storage）
 */
function saveUserData(userId, data) {
  _cache[userId] = data;
  wx.setStorageSync(KEY_PREFIX + userId, data);
}

/**
 * 清除内存缓存（登出或切换用户时调用，避免脏数据与内存泄漏）
 * @param {string} [userId] 不传则清空全部
 */
function clearCache(userId) {
  if (userId === undefined) {
    Object.keys(_cache).forEach((k) => delete _cache[k]);
  } else {
    delete _cache[userId];
  }
}

module.exports = {
  KEY_PREFIX,
  emptyData,
  getUserData,
  saveUserData,
  clearCache
};
