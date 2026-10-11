/**
 * WebSocket 实时推送客户端（/api/ws/updates，需求 §8.4）。
 * 单连接全局复用、断线指数退避自动重连（1s 起封顶 15s）；
 * 页面经 subscribe 订阅消息（msg.type：activity / data_changed 等），退订即清理。
 * 无订阅者时延迟关闭连接且不再重连，避免后台空连接持续接收广播。
 */
const { API_BASE_URL } = require('./config');
const requestService = require('./request');

const IDLE_CLOSE_MS = 30000; // 退订后宽限期：短时间内切回首页复用原连接

let socket = null;
let connected = false;
let connecting = false;
let retry = 0;
let retryTimer = null;
let idleTimer = null;
const listeners = [];

function scheduleReconnect() {
  if (retryTimer || listeners.length === 0) return;
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
  const s = wx.connectSocket({ url });
  socket = s;
  // 回调只对当前连接生效：旧连接迟到的 close/error 不得重置新连接状态
  s.onOpen(() => {
    if (socket !== s) return;
    connected = true;
    connecting = false;
    retry = 0;
  });
  s.onMessage((res) => {
    if (socket !== s) return;
    let msg = null;
    try { msg = JSON.parse(res.data); } catch (e) { return; }
    listeners.slice().forEach((fn) => {
      try { fn(msg); } catch (e) { /* 单个监听异常不影响其他订阅者 */ }
    });
  });
  const onDead = () => {
    if (socket !== s) return;
    connected = false;
    connecting = false;
    socket = null;
    scheduleReconnect();
  };
  s.onClose(onDead);
  s.onError(onDead);
}

function closeIdle() {
  idleTimer = null;
  if (listeners.length > 0) return;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  retry = 0;
  const s = socket;
  socket = null;
  connected = false;
  connecting = false;
  if (s) s.close({});
}

/**
 * 订阅推送消息。
 * @param {(msg:object)=>void} fn
 * @returns {() => void} 退订函数
 */
function subscribe(fn) {
  listeners.push(fn);
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  connect();
  return function unsubscribe() {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
    if (listeners.length === 0 && !idleTimer) idleTimer = setTimeout(closeIdle, IDLE_CLOSE_MS);
  };
}

module.exports = { subscribe };
