/**
 * 微信登录服务
 * wx.login() -> 后端换取 openid -> JWT。
 * 启动 / Token 失效时静默登录（ensureLogin、401 重登）；用户主动退出后仅允许登录页手动登录。
 */
const requestService = require('./request');
const store = require('./store');

const USER_KEY = 'lm_login_user';
const LOGGED_OUT_KEY = 'lm_logged_out';

let reloginPending = null;
let ensurePending = null;

/**
 * 持久化头像：chooseAvatar 返回的是临时路径（重启后失效），
 * 用 FileSystemManager.saveFile 转存到用户目录，得到可长期引用的本地路径。
 * 网络头像（http/https）与已转存路径直接返回。
 * @param {string} tempPath
 * @returns {Promise<string>}
 */
function persistAvatar(tempPath) {
  return new Promise((resolve) => {
    if (!tempPath) {
      resolve('');
      return;
    }
    const userDir = (wx.env && wx.env.USER_DATA_PATH) || '';
    // 已是持久化本地路径，直接返回
    if (userDir && tempPath.indexOf(userDir) === 0) {
      resolve(tempPath);
      return;
    }
    // 真实网络头像（https://）直接返回
    if (/^https:\/\//.test(tempPath)) {
      resolve(tempPath);
      return;
    }
    // chooseAvatar 临时路径（工具 http://tmp/、真机 wxfile://tmp_）转存为持久路径
    try {
      wx.getFileSystemManager().saveFile({
        tempFilePath: tempPath,
        success: (res) => resolve(res.savedFilePath),
        // 转存失败退回临时路径（当次会话仍可用）
        fail: () => resolve(tempPath)
      });
    } catch (e) {
      resolve(tempPath);
    }
  });
}

/** 读取本地缓存用户（仅作展示与合并依据，不代表已登录）。 */
function readLocalUser() {
  try {
    return wx.getStorageSync(USER_KEY) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 微信登录，返回后端用户。
 * @param {{nickname?:string, avatar?:string}} [profile]
 * @returns {Promise<{id:number, nickname:string, avatar:string, orgId:number|null}>}
 */
function wxLogin(profile) {
  const p = profile || {};
  const previousUser = readLocalUser();

  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (!res.code) {
          reject(new Error('微信登录失败'));
          return;
        }
        persistAvatar(p.avatar || '')
          .then((avatar) =>
            requestService.request({
              url: '/auth/login',
              method: 'POST',
              skipAuthRetry: true,
              data: {
                code: res.code,
                nickname: p.nickname || '',
                avatar: avatar
              }
            })
          )
          .then((result) => {
            wx.setStorageSync(requestService.TOKEN_KEY, result.token);
            if (previousUser && previousUser.id !== undefined) {
              store.migrateUserData(previousUser.id, result.user.id);
            }
            const user = saveServerUser(result.user, previousUser);
            wx.removeStorageSync(LOGGED_OUT_KEY);
            resolve(user);
          })
          .catch(reject);
      },
      fail: () => reject(new Error('微信登录失败，请重试'))
    });
  });
}

/**
 * 以后端用户为准写入本地缓存并同步全局登录态。
 * 组织显示名（orgName/orgFullName）后端 /auth 接口不返回，同一用户且组织未变时沿用本地缓存。
 */
function saveServerUser(serverUser, previousUser) {
  const prev = previousUser || {};
  const keep = prev.id === serverUser.id && prev.orgId === serverUser.orgId
    ? { orgName: prev.orgName, orgFullName: prev.orgFullName }
    : {};
  const user = Object.assign(keep, serverUser);
  wx.setStorageSync(USER_KEY, user);
  syncApp(user);
  return user;
}

/** 同步全局登录态（App 未就绪时跳过）。 */
function syncApp(user) {
  try {
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.user = user;
      app.globalData.loggedIn = !!user;
    }
  } catch (e) {
    // App 尚未初始化
  }
}

function isLoggedOut() {
  try {
    return !!wx.getStorageSync(LOGGED_OUT_KEY);
  } catch (e) {
    return false;
  }
}

/** 静默重新登录（并发调用合并为一次 wx.login）；用户主动退出后拒绝。 */
function relogin() {
  if (isLoggedOut()) return Promise.reject(Object.assign(new Error('已退出登录'), { loggedOut: true }));
  if (!reloginPending) {
    reloginPending = wxLogin().finally(() => {
      reloginPending = null;
    });
  }
  return reloginPending;
}

/**
 * 确保已登录：本地 Token 必须经后端 /auth/me 校验才视为有效；
 * 无 Token 或 Token 失效（401）则静默 wx.login 重登，复用同一用户并签发新 Token。
 * 网络异常时保留本地 Token 并抛出（err.network），由调用方提示重试。
 * @returns {Promise<object>} 当前用户
 */
function ensureLogin() {
  if (ensurePending) return ensurePending;
  let task;
  if (isLoggedOut() || !requestService.getToken()) {
    task = relogin();
  } else {
    task = requestService
      .request({ url: '/auth/me', skipAuthRetry: true })
      .then((me) => saveServerUser(me, readLocalUser()))
      .catch((err) => {
        if (err.statusCode !== 401) throw err;
        wx.removeStorageSync(requestService.TOKEN_KEY);
        return relogin();
      });
  }
  ensurePending = task.finally(() => {
    ensurePending = null;
  });
  return ensurePending;
}

requestService.setReauthHandler(relogin);

/**
 * 修改昵称（每个用户仅允许一次，后端校验）。
 * 成功后把后端返回的最新用户信息合并进本地缓存。
 * @param {string} nickname
 * @returns {Promise<object>} 更新后的用户
 */
function updateNickname(nickname) {
  return requestService
    .request({
      url: '/auth/nickname',
      method: 'PUT',
      data: { nickname: nickname }
    })
    .then((user) => updateLocalUser(user));
}

/**
 * 首次引导设置昵称（组织选择页采集微信名），不消耗「每人仅一次」改名机会。
 * @param {string} nickname
 * @returns {Promise<object>} 更新后的用户
 */
function setInitialNickname(nickname) {
  return requestService
    .request({
      url: '/auth/nickname/initial',
      method: 'PUT',
      data: { nickname: nickname }
    })
    .then((user) => updateLocalUser(user));
}

/**
 * 更新本地用户缓存并返回新用户（如组织选择结果）。
 * @param {object} patch
 * @returns {object|null}
 */
function updateLocalUser(patch) {
  try {
    const user = Object.assign({}, readLocalUser() || {}, patch);
    wx.setStorageSync(USER_KEY, user);
    return user;
  } catch (e) {
    return null;
  }
}

/**
 * 主动退出登录：清除登录态并标记已退出，此后不再静默登录，需在登录页手动登录。
 */
function clearLocalUser() {
  wx.removeStorageSync(USER_KEY);
  wx.removeStorageSync(requestService.TOKEN_KEY);
  wx.setStorageSync(LOGGED_OUT_KEY, 1);
}

module.exports = {
  wxLogin,
  ensureLogin,
  updateNickname,
  setInitialNickname,
  updateLocalUser,
  clearLocalUser
};
