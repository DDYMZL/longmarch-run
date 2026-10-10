const { API_BASE_URL } = require('./config');

const TOKEN_KEY = 'lm_auth_token';
const USER_KEY = 'lm_login_user';
const LAUNCH_PAGE = '/pages/launch/launch';

// 401 静默重登处理器，由 auth 模块注册（避免 request ↔ auth 循环依赖）
let reauthHandler = null;

/** 获取本地 JWT。 */
function getToken() {
  try {
    return wx.getStorageSync(TOKEN_KEY) || '';
  } catch (e) {
    return '';
  }
}

/** 注册 401 时的重新登录函数（返回 Promise，成功即已写入新 Token）。 */
function setReauthHandler(fn) {
  reauthHandler = fn;
}

/** 清理失效登录态并回到启动页（由启动页重新自动登录或提示重试）。 */
function clearSession() {
  try {
    wx.removeStorageSync(TOKEN_KEY);
    wx.removeStorageSync(USER_KEY);
  } catch (e) {
    // Storage 清理失败时仍重置当前会话
  }
  try {
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.user = null;
      app.globalData.loggedIn = false;
    }
    wx.reLaunch({ url: LAUNCH_PAGE });
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

/** 构造带分类信息的错误：statusCode 为 HTTP 状态码，network 表示请求未到达后端。 */
function buildError(message, extra) {
  return Object.assign(new Error(message), extra);
}

/** 单次发送请求，不做 401 处理。 */
function send(opts) {
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
        const fallback = res.statusCode === 401 ? '登录已过期，请重新登录' : '请求失败';
        reject(buildError(errorMessage(res.data, fallback), { statusCode: res.statusCode }));
      },
      fail: (err) => {
        const raw = (err && err.errMsg) || '';
        const msg = /url not in domain list/i.test(raw)
          ? '请求域名未通过校验：真机调试请在手机调试面板开启「不校验合法域名」'
          : '网络连接失败：真机调试请确认手机与电脑同一局域网，且 config.js 中 LAN_IP 为电脑局域网 IP';
        reject(buildError(msg, { network: true }));
      }
    });
  });
}

/**
 * 发起后端请求并统一附加 JWT。
 * 401 时静默重新登录并重试一次；重登或重试仍失败则清登录态回启动页。
 * skipAuthRetry：登录相关请求自行处理 401，不触发重登与跳转。
 * @param {{url:string, method?:string, data?:object, header?:object, timeout?:number, skipAuthRetry?:boolean}} options
 * @returns {Promise<any>}
 */
function request(options) {
  const opts = options || {};
  return send(opts).catch((err) => {
    if (err.statusCode !== 401 || opts.skipAuthRetry) throw err;
    if (!reauthHandler) {
      clearSession();
      throw err;
    }
    return reauthHandler().then(
      () =>
        send(opts).catch((retryErr) => {
          if (retryErr.statusCode === 401) clearSession();
          throw retryErr;
        }),
      (loginErr) => {
        // 网络异常保留现场由页面提示重试；其余重登失败回启动页
        if (!loginErr.network) clearSession();
        throw loginErr;
      }
    );
  });
}

module.exports = {
  TOKEN_KEY,
  getToken,
  setReauthHandler,
  request
};
