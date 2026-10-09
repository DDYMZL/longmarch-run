// 后端接口地址配置。
// 开发者工具（模拟器）里手机与后端同机，用 127.0.0.1 即可；
// 真机调试时手机无法访问电脑回环地址，自动改用电脑局域网 IP。
// 注意：电脑 IP 变化时需同步更新 LAN_IP；手机须与电脑连同一局域网（Wi-Fi）。
const LAN_IP = '10.1.171.137';
const API_PORT = 8010;

let API_BASE_URL = 'http://127.0.0.1:' + API_PORT + '/api';
try {
  if (wx.getSystemInfoSync().platform !== 'devtools') {
    API_BASE_URL = 'http://' + LAN_IP + ':' + API_PORT + '/api';
  }
} catch (e) {
  // 取不到平台信息时保持开发者工具默认地址
}

module.exports = {
  API_BASE_URL
};
