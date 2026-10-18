/**
 * 授权失败引导工具：检测权限状态，已拒绝时弹窗引导用户前往设置页开启。
 *
 * 使用场景：
 *   - 微信运动（scope.werun）授权被拒后引导重新开启
 *   - 相册写入（scope.writePhotosAlbum）被拒后引导重新开启
 *
 * 调用方式：
 *   ensureScope('scope.werun', '需要微信运动权限才能同步步数')
 *     .then(granted => { ... })
 */

/**
 * 确保指定权限已授权。
 * 已授权 → resolve(true)；从未请求过 → resolve(false)（由调用方自行 wx.authorize）；
 * 已拒绝 → 弹窗引导 → openSetting → 复检 → resolve(最终状态)。
 *
 * @param {string} scope   权限标识，如 'scope.werun'、'scope.writePhotosAlbum'
 * @param {string} tipText 弹窗提示文案（告知用户为何需要该权限）
 * @returns {Promise<boolean>} 最终是否已授权
 */
function ensureScope(scope, tipText) {
  return new Promise((resolve) => {
    wx.getSetting({
      success: (res) => {
        const authSetting = res.authSetting || {};
        if (authSetting[scope] === true) {
          // 已授权
          resolve(true);
          return;
        }
        if (authSetting[scope] === false) {
          // 已明确拒绝：弹窗引导前往设置页
          wx.showModal({
            title: '权限未开启',
            content: tipText || '该功能需要相关权限，请在设置中开启后重试。',
            confirmText: '去开启',
            cancelText: '暂不',
            confirmColor: '#C8102E',
            success: (modalRes) => {
              if (!modalRes.confirm) {
                resolve(false);
                return;
              }
              wx.openSetting({
                success: (settingRes) => {
                  resolve(!!(settingRes.authSetting && settingRes.authSetting[scope]));
                },
                fail: () => resolve(false)
              });
            },
            fail: () => resolve(false)
          });
          return;
        }
        // 从未请求过（undefined）：由调用方自行触发 wx.authorize
        resolve(false);
      },
      fail: () => resolve(false)
    });
  });
}

module.exports = { ensureScope };
