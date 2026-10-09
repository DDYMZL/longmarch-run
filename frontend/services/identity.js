/**
 * 身份关联服务：扫码确认（PC 登录 / 身份绑定）、身份列表与解绑。
 * 场景凭证格式：L{token} 登录确认 / B{token} 绑定确认（仅后端可生成）。
 */
const request = require('./request');

/**
 * 查询扫码场景详情（登录场景会置 scanned）。
 * @param {string} scene 扫码场景凭证
 * @returns {Promise<{type:string, status:string, target?:object, expiresAt?:string, failReason?:string}>}
 */
function qrInfo(scene) {
  return request.request({
    url: '/auth/qr/info',
    method: 'POST',
    data: { scene: scene }
  });
}

/**
 * 确认或取消扫码请求。
 * @param {string} scene 扫码场景凭证
 * @param {'confirm'|'cancel'} action
 */
function qrConfirm(scene, action) {
  return request.request({
    url: '/auth/qr/confirm',
    method: 'POST',
    data: { scene: scene, action: action }
  });
}

/** 当前用户已绑定身份列表。 */
function listIdentities() {
  return request.request({ url: '/auth/identities' });
}

/** 解绑指定身份（wx_mini 登录凭证不可解绑，后端校验）。 */
function unbind(identityId) {
  return request.request({
    url: '/auth/identities/' + identityId,
    method: 'DELETE'
  });
}

module.exports = {
  qrInfo,
  qrConfirm,
  listIdentities,
  unbind
};
