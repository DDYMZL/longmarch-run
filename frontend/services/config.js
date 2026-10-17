// 后端接口地址配置：按小程序运行环境自动判定，发布前无需改动本文件。
// 环境来源 wx.getAccountInfoSync().miniProgram.envVersion：
//   develop —— 开发者工具与真机调试；trial —— 体验版；release —— 正式版
// 体验版/正式版恒连已部署后端（HTTPS，域名须与公众平台「服务器域名 → request 合法域名」
// 完全一致，否则真机报「网络异常」；「不校验合法域名」仅对开发者工具与开发版生效）。
// DEV_TARGET 只在 develop 下生效，用于本地联调切换：
//   'remote'（默认）—— 直连已部署后端，本地无需起后端（automator 回归也走这条）
//   'local'  —— 本机后端：开发者工具用 127.0.0.1，真机调试自动改用电脑局域网 IP（LAN_IP）
// 切到 'local' 时若电脑 IP 变化需同步更新 LAN_IP；手机须与电脑连同一局域网（Wi-Fi），
// 并在开发者工具「详情 → 本地设置」勾选「不校验合法域名」（http + 非标端口只有开发版放行）。
const DEV_TARGET = 'remote';

const REMOTE_ORIGIN = 'https://swkjdj.sz-watech.com';

const LAN_IP = '192.168.10.115';
const LOCAL_PORT = 8010;

/** 是否为开发版（开发者工具/真机调试）；取不到环境时按非开发版处理，保证异常场景仍连远程。 */
function isDevelop() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion === 'develop';
  } catch (e) {
    return false;
  }
}

/** 按当前环境解析接口根地址（含 /api 前缀）。 */
function resolveBaseUrl() {
  if (!isDevelop() || DEV_TARGET !== 'local') {
    return REMOTE_ORIGIN + '/api';
  }
  let host = '127.0.0.1';
  try {
    // 真机无法访问电脑回环地址，改用电脑局域网 IP
    if (wx.getSystemInfoSync().platform !== 'devtools') host = LAN_IP;
  } catch (e) {
    // 取不到平台信息时按开发者工具默认地址处理
  }
  return 'http://' + host + ':' + LOCAL_PORT + '/api';
}

module.exports = {
  API_BASE_URL: resolveBaseUrl()
};
