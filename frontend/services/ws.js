/**
 * WebSocket 实时推送客户端（/api/ws/updates，需求 §8.4）。
 * 单连接全局复用、断线指数退避自动重连（1s 起封顶 15s）；
 * 页面经 subscribe 订阅消息（msg.type：activity / data_changed 等），退订即清理。
 */
const { API_BASE_URL } = require('./config');
const requestService = require('./request');

let socket = null;
let connected = false;
let connecting = false;
let retry = 0;
let retryTimer = null;
const listeners = [];

function scheduleReconnect() {
  if (retryTimer) return;
  retry += 1;
  const delay = Math.min(15000, 1000 * Math.pow(2, retry - 1));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (connected || connecting) return;
  const token = requestService.getToken();
  if (!token) return; // 未登录不建立连接
  connecting = true;
  const url = API_BASE_URL.replace(/^http/, 'ws') + '/ws/updates?token=' + encodeURIComponent(token);
  socket = wx.connectSocket({ url });
  socket.onOpen(() => {
    connected = true;
    connecting = false;
    retry = 0;
  });
  socket.onMessage((res) => {
    let msg = null;
    try { msg = JSON.parse(res.data); } catch (e) { return; }
    listeners.slice().forEach((fn) => {
      try { fn(msg); } catch (e) { /* 单个监听异常不影响其他订阅者 */ }
    });
  });
  const onDead = () => {
    connected = false;
    connecting = false;
    socket = null;
    scheduleReconnect();
  };
  socket.onClose(onDead);
  socket.onError(onDead);
}

/**
 * 订阅推送消息。
 * @param {(msg:object)=>void} fn
 * @returns {() => void} 退订函数
 */
function subscribe(fn) {
  listeners.push(fn);
  connect();
  return function unsubscribe() {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

module.exports = { subscribe };
