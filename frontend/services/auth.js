/**
 * 微信登录与入驻服务
 * - wx.login 以 code 识别微信身份；后端仅为已入驻用户签发 JWT。
 * - 未入驻 / 已停用用户返回 status 由上层决定进入入驻页或准入拦截页。
 * - 启动页与 Token 失效时静默登录（ensureLogin、401 重登）；用户主动退出后不再静默登录。
 */
const requestService = require('./request');
const store = require('./store');

const USER_KEY = 'lm_login_user';
const LOGGED_OUT_KEY = 'lm_logged_out';
const INVITE_KEY = 'lm_pending_invite';

let reloginPending = null;
let ensurePending = null;

/** 持久化头像；chooseAvatar 返回的临时路径重启后失效，网络头像与已持久化路径直接返回。 */
function persistAvatar(tempPath) {
  return new Promise((resolve) => {
    if (!tempPath) return resolve('');
    const userDir = (wx.env && wx.env.USER_DATA_PATH) || '';
    if (userDir && tempPath.indexOf(userDir) === 0) return resolve(tempPath);
    if (/^https:\/\//.test(tempPath)) return resolve(tempPath);
    try {
      wx.getFileSystemManager().saveFile({
        tempFilePath: tempPath,
        success: (res) => resolve(res.savedFilePath),
        fail: () => resolve(tempPath)
      });
    } catch (e) {
      resolve(tempPath);
    }
  });
}

/**
 * 上传头像到服务端（POST /auth/avatar，multipart 字段名 file）。
 * 成功后更新 globalData.user 与本地 lm_login_user，返回新用户。
 * @param {string} tempPath chooseAvatar 返回的临时路径或已持久化的本地路径
 * @param {boolean} [silent] 登录/入驻链路静默模式：失败吞掉返回 null（不阻塞、不提示）；
 *                           用户主动换头像时传 falsy，失败将抛出由页面提示并回滚。
 */
function uploadAvatar(tempPath, silent) {
  if (!tempPath) return Promise.resolve(null);
  return requestService.uploadFile('/auth/avatar', tempPath)
    .then((serverUser) => {
      if (serverUser) return saveServerUser(serverUser, readLocalUser());
      return null;
    })
    .catch((err) => {
      if (silent) return null; // 登录链路：静默失败，不影响登录
      throw err;               // 用户主动：交由页面提示 + 回滚
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

function isLoggedOut() {
  try {
    return !!wx.getStorageSync(LOGGED_OUT_KEY);
  } catch (e) {
    return false;
  }
}

/** 以后端用户为准写入本地缓存并同步全局登录态。 */
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

function admissionError(status, message) {
  return Object.assign(new Error(message), { admission: status });
}

/**
 * 调后端 /auth/login：status=active 则落 Token 并返回用户；其余状态抛出 admission 错误。
 * 头像不再通过登录接口传递，改为登录成功后单独上传（uploadAvatar）。
 */
function callLogin(avatar) {
  const previousUser = readLocalUser();
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (!res.code) return reject(new Error('微信登录失败'));
        requestService.request({
          url: '/auth/login',
          method: 'POST',
          skipAuthRetry: true,
          data: { code: res.code }
        })
          .then((result) => {
            if (result.status === 'active' && result.token && result.user) {
              wx.setStorageSync(requestService.TOKEN_KEY, result.token);
              if (previousUser && previousUser.id !== undefined && previousUser.id !== result.user.id) {
                store.migrateUserData(previousUser.id, result.user.id);
              }
              const user = saveServerUser(result.user, previousUser);
              wx.removeStorageSync(LOGGED_OUT_KEY);
              // 登录成功：清除上一账号遗留的 last-good 缓存，杜绝跨账号脏读
              requestService.clearAllCache();
              // 头像上传不阻塞登录（fire-and-forget）：成功后 uploadAvatar 内部已更新 globalData/本地 user，
              // 页面下次 onShow 读取 globalData 即刷新头像；失败静默忽略。
              if (avatar) uploadAvatar(avatar, true);
              resolve(user);
              return;
            }
            if (result.status === 'disabled') {
              return reject(admissionError('disabled', '账号已停用，请联系活动管理员'));
            }
            // 其余按未入驻处理
            reject(admissionError('unregistered', '尚未入驻'));
          })
          .catch(reject);
      },
      fail: (err) => reject(new Error('微信登录失败：' + ((err && err.errMsg) || '未知原因')))
    });
  });
}

/**
 * 微信登录（兼容旧登录页：仅在已入驻时返回用户）。
 * @param {{avatar?:string}} [profile]
 */
function wxLogin(profile) {
  const p = profile || {};
  return callLogin(p.avatar || '');
}

/** 静默重登（并发合并一次 wx.login）；用户主动退出 / 未入驻 / 已停用均抛错，由调用方处理。 */
function relogin() {
  if (isLoggedOut()) return Promise.reject(Object.assign(new Error('已退出登录'), { loggedOut: true }));
  if (!reloginPending) {
    reloginPending = callLogin('').finally(() => {
      reloginPending = null;
    });
  }
  return reloginPending;
}

/** 确保已登录：/auth/me 校验失败则静默重登；admission/network 错误原样抛出供启动页处理。 */
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

/** 校验邀请码（不核销），返回 {name, orgId, orgName}。 */
function verifyInvite(inviteCode) {
  return requestService.request({
    url: '/auth/invite/verify',
    method: 'POST',
    skipAuthRetry: true,
    data: { inviteCode: inviteCode }
  });
}

/**
 * 持邀请码入驻：先 wx.login 换 code，再 POST /auth/onboard。
 * 头像不再通过入驻接口传递，改为入驻成功后单独上传（uploadAvatar）。
 * 已入驻身份重复提交后端幂等返回同一用户。
 */
function onboard(params) {
  const inviteCode = params.inviteCode;
  const nickname = params.nickname;
  const orgId = params.orgId;
  const avatarRaw = params.avatar || '';
  const previousUser = readLocalUser();
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (!res.code) return reject(new Error('微信登录失败'));
        requestService.request({
          url: '/auth/onboard',
          method: 'POST',
          skipAuthRetry: true,
          data: {
            code: res.code,
            inviteCode: inviteCode,
            nickname: nickname,
            orgId: orgId
          }
        })
          .then((result) => {
            wx.setStorageSync(requestService.TOKEN_KEY, result.token);
            if (previousUser && previousUser.id !== undefined && previousUser.id !== result.user.id) {
              store.migrateUserData(previousUser.id, result.user.id);
            }
            const user = saveServerUser(result.user, previousUser);
            wx.removeStorageSync(LOGGED_OUT_KEY);
            wx.removeStorageSync(INVITE_KEY);
            // 入驻成功：清除上一账号遗留的 last-good 缓存，杜绝跨账号脏读
            requestService.clearAllCache();
            // 头像上传不阻塞入驻（fire-and-forget，静默失败）
            if (avatarRaw) uploadAvatar(avatarRaw, true);
            resolve({ user: user, created: !!result.created });
          })
          .catch(reject);
      },
      fail: (err) => reject(new Error('微信登录失败：' + ((err && err.errMsg) || '未知原因')))
    });
  });
}

/** 修改昵称（每个用户仅一次，后端校验）。 */
function updateNickname(nickname) {
  return requestService
    .request({ url: '/auth/nickname', method: 'PUT', data: { nickname: nickname } })
    .then((user) => updateLocalUser(user));
}

/** 首次引导设置昵称（组织选择页采集微信名，不消耗唯一改名机会）。 */
function setInitialNickname(nickname) {
  return requestService
    .request({ url: '/auth/nickname/initial', method: 'PUT', data: { nickname: nickname } })
    .then((user) => updateLocalUser(user));
}

/** 更新本地用户缓存并同步全局用户（不改变登录态），返回新用户（如组织选择结果）。 */
function updateLocalUser(patch) {
  try {
    const user = Object.assign({}, readLocalUser() || {}, patch);
    wx.setStorageSync(USER_KEY, user);
    const app = getApp();
    if (app && app.globalData) app.globalData.user = user;
    return user;
  } catch (e) {
    return null;
  }
}

/** 主动退出：清除登录态并标记已退出，此后不再静默登录。 */
function clearLocalUser() {
  wx.removeStorageSync(USER_KEY);
  wx.removeStorageSync(requestService.TOKEN_KEY);
  wx.setStorageSync(LOGGED_OUT_KEY, 1);
  // 登出即清除 last-good 缓存，避免下一账号弱网兜底脏读
  requestService.clearAllCache();
}

/** 待入驻的邀请码缓存：扫码后进入入驻页；入驻成功或主动放弃时清除。 */
function savePendingInvite(payload) {
  try {
    wx.setStorageSync(INVITE_KEY, payload || null);
  } catch (e) {
    // 存储失败不影响流程，下一次扫码会重新写入
  }
}

function readPendingInvite() {
  try {
    return wx.getStorageSync(INVITE_KEY) || null;
  } catch (e) {
    return null;
  }
}

function clearPendingInvite() {
  wx.removeStorageSync(INVITE_KEY);
}

module.exports = {
  wxLogin,
  ensureLogin,
  verifyInvite,
  onboard,
  uploadAvatar,
  updateNickname,
  setInitialNickname,
  updateLocalUser,
  clearLocalUser,
  savePendingInvite,
  readPendingInvite,
  clearPendingInvite
};
