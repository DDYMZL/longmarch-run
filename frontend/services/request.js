const { API_BASE_URL } = require('./config');

const TOKEN_KEY = 'lm_auth_token';
const USER_KEY = 'lm_login_user';

/** 获取本地 JWT。 */
function getToken() {
  try {
    return wx.getStorageSync(TOKEN_KEY) || '';
  } catch (e) {
    return '';
  }
}

/** 清理过期登录态并回到登录页。 */
function clearSession() {
  try {
    wx.removeStorageSync(TOKEN_KEY);
    wx.removeStorageSync(USER_KEY);
    require('./store').clearCache();
  } catch (e) {
    // Storage 清理失败时仍重置当前会话
  }
  try {
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.user = null;
      app.globalData.loggedIn = false;
    }
    wx.reLaunch({ url: '/pages/login/login' });
  } catch (e) {
    // App 尚未初始化时仅清理持久化登录态
  }
}

/** 提取 FastAPI 错误信息。 */
function errorMessage(data, fallback) {
  if (data && typeof data.detail === 'string') return data.detail;
  if (data && Array.isArray(data.detail) && data.detail.length) {
    return data.detail.map((item) => item.msg || '').filter(Boolean).join('；') || fallback;
  }
  return fallback;
}

/**
 * 发起后端请求并统一附加 JWT。
 * @param {{url:string, method?:string, data?:object, header?:object, timeout?:number}} options
 * @returns {Promise<any>}
 */
function request(options) {
  const opts = options || {};
  const token = getToken();
  const header = Object.assign({ 'Content-Type': 'application/json' }, opts.header || {});
  if (token) header.Authorization = 'Bearer ' + token;

  return new Promise((resolve, reject) => {
    wx.request({
      url: API_BASE_URL + opts.url,
      method: opts.method || 'GET',
      data: opts.data,
      header: header,
      timeout: opts.timeout || 10000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
          return;
        }
        if (res.statusCode === 401) clearSession();
        reject(new Error(errorMessage(res.data, res.statusCode === 401 ? '登录已过期，请重新登录' : '请求失败')));
      },
      fail: (err) => reject(new Error((err && err.errMsg) || '网络连接失败'))
    });
  });
}

module.exports = {
  TOKEN_KEY,
  getToken,
  request
};
