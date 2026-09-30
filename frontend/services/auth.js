/**
 * 微信登录服务（Mock）
 *
 * 正式流程：
 *   wx.login() -> code -> 后端 -> 微信服务端 -> openid/session_key -> 后端生成 Token
 *
 * 当前无后端，使用 wx.login 拿到 code 后在本地模拟创建用户，
 * 保证登录流程与页面交互和正式版一致，后续仅需替换为真实接口。
 */
const USER_KEY = 'lm_login_user';

/**
 * 生成模拟 openid
 */
function mockOpenid() {
  return 'mock_openid_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

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
 * 微信登录，返回 Promise<user>
 * @param {{nickname?:string, avatar?:string}} [profile] 头像昵称填写能力采集的资料
 * @returns {Promise<{id:string, openid:string, nickname:string, avatar:string}>}
 */
function wxLogin(profile) {
  const p = profile || {};
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (!res.code) {
          reject(new Error('微信登录失败'));
          return;
        }
        // Mock：直接用 code 换本地用户
        // 注意：openid 只生成一次，id 与 openid 必须一致（后续以 id 作为数据主键）
        const openid = mockOpenid();
        // 头像为临时路径，先持久化再写入用户信息
        persistAvatar(p.avatar || '').then((avatar) => {
          const user = {
            id: openid,
            openid: openid,
            nickname: p.nickname || '长征小战士',
            avatar: avatar,
            loginAt: new Date().getTime()
          };
          wx.setStorageSync(USER_KEY, user);
          resolve(user);
        });
      },
      fail: () => reject(new Error('微信登录失败，请重试'))
    });
  });
}

/**
 * 获取本地已登录用户，未登录返回 null
 */
function getLocalUser() {
  try {
    return wx.getStorageSync(USER_KEY) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 清除登录态
 */
function clearLocalUser() {
  wx.removeStorageSync(USER_KEY);
}

module.exports = {
  wxLogin,
  getLocalUser,
  clearLocalUser
};
