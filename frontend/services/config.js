// 后端接口地址配置：通过 ENV 一键切换联调环境。
//   'remote' —— 已部署的后端（默认）：开发者工具与真机调试都直连远程，本地无需起后端即可联调
//   'local'  —— 本机后端：开发者工具用 127.0.0.1，真机调试自动改用电脑局域网 IP（LAN_IP）
// 切到 'local' 时若电脑 IP 变化需同步更新 LAN_IP；手机须与电脑连同一局域网（Wi-Fi）。
const ENV = 'remote';

const REMOTE_HOST = 'swkjdj.sz-watech.com';
const REMOTE_PORT = 8010;

const LAN_IP = '10.1.171.137';
const LOCAL_PORT = 8010;

/** 按当前 ENV 解析接口根地址（含 /api 前缀）。 */
function resolveBaseUrl() {
  if (ENV === 'remote') {
    return 'http://' + REMOTE_HOST + ':' + REMOTE_PORT + '/api';
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
