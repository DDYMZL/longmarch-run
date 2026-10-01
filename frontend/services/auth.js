/**
 * 微信登录服务
 * wx.login() -> 后端换取 openid -> JWT。
 */
const requestService = require('./request');
const store = require('./store');

const USER_KEY = 'lm_login_user';

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

/**
 * 微信登录，返回后端用户。
 * @param {{nickname?:string, avatar?:string}} [profile]
 * @returns {Promise<{id:number, nickname:string, avatar:string, orgId:number|null}>}
 */
function wxLogin(profile) {
  const p = profile || {};
  let previousUser = null;
  try {
    previousUser = wx.getStorageSync(USER_KEY) || null;
  } catch (e) {
    previousUser = null;
  }

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
              data: {
                code: res.code,
                nickname: p.nickname || '',
                avatar: avatar
              }
            })
          )
          .then((result) => {
            const user = Object.assign({}, result.user, { loginAt: new Date().getTime() });
            wx.setStorageSync(requestService.TOKEN_KEY, result.token);
            if (previousUser && previousUser.id !== undefined) {
              store.migrateUserData(previousUser.id, user.id);
            }
            wx.setStorageSync(USER_KEY, user);
            resolve(user);
          })
          .catch(reject);
      },
      fail: () => reject(new Error('微信登录失败，请重试'))
    });
  });
}

/**
 * 获取本地已登录用户；旧 Mock 登录态没有 Token，需重新授权。
 */
function getLocalUser() {
  try {
    const user = wx.getStorageSync(USER_KEY) || null;
    return user && requestService.getToken() ? user : null;
  } catch (e) {
    return null;
  }
}

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
 * 更新本地用户缓存并返回新用户（如组织选择结果）。
 * @param {object} patch
 * @returns {object|null}
 */
function updateLocalUser(patch) {
  try {
    const user = Object.assign({}, wx.getStorageSync(USER_KEY) || {}, patch);
    wx.setStorageSync(USER_KEY, user);
    return user;
  } catch (e) {
    return null;
  }
}

/**
 * 清除登录态。
 */
function clearLocalUser() {
  wx.removeStorageSync(USER_KEY);
  wx.removeStorageSync(requestService.TOKEN_KEY);
}

module.exports = {
  wxLogin,
  getLocalUser,
  updateNickname,
  updateLocalUser,
  clearLocalUser
};
