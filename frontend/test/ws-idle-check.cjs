/**
 * services/ws.js 连接复用 / 空闲关闭 / 断线重连状态机校验（Node 直跑，虚拟时钟模拟 wx.connectSocket）。
 * 运行：node test/ws-idle-check.cjs
 */
const path = require('path');

let now = 0;
const timers = [];
global.setTimeout = (f, ms) => {
  const t = { f, at: now + ms };
  timers.push(t);
  return t;
};
global.clearTimeout = (t) => { if (t) t.f = null; };
function advance(ms) {
  const end = now + ms;
  for (;;) {
    const t = timers.filter((x) => x.f && x.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!t) break;
    now = t.at;
    const f = t.f;
    t.f = null;
    f();
  }
  now = end;
}

const sockets = [];
global.getApp = () => ({ globalData: {} });
global.wx = {
  getSystemInfoSync: () => ({ platform: 'devtools' }),
  getStorageSync: () => 'tok',
  connectSocket: () => {
    const s = {
      h: {},
      closed: false,
      onOpen(f) { s.h.open = f; },
      onMessage(f) { s.h.msg = f; },
      onClose(f) { s.h.close = f; },
      onError(f) { s.h.err = f; },
      close() { s.closed = true; setTimeout(() => s.h.close(), 10); }
    };
    sockets.push(s);
    return s;
  }
};

const ws = require(path.join(__dirname, '..', 'services', 'ws.js'));
let pass = 0;
let total = 0;
function ok(cond, name) {
  total += 1;
  if (cond) pass += 1;
  console.log((cond ? 'PASS ' : 'FAIL ') + name);
}

const got = [];
const un1 = ws.subscribe((m) => got.push(m));
sockets[0].h.open();
const un2 = ws.subscribe(() => {});
ok(sockets.length === 1, 'W1 多订阅者复用单连接');

sockets[0].h.msg({ data: '{"type":"activity"}' });
ok(got.length === 1 && got[0].type === 'activity', 'W2 消息分发到订阅者');

un1();
un2();
advance(10000);
const un3 = ws.subscribe(() => {});
ok(sockets.length === 1 && !sockets[0].closed, 'W3 宽限期内重新订阅复用原连接');

un3();
advance(30001);
ok(sockets[0].closed, 'W4 无订阅者 30s 后关闭连接');

advance(60000);
ok(sockets.length === 1, 'W5 主动关闭后迟到的 onClose 不触发重连');

ws.subscribe(() => {});
ok(sockets.length === 2, 'W6 再次订阅重建连接');

sockets[1].h.err();
advance(1000);
ok(sockets.length === 3, 'W7 有订阅者时断线 1s 后退避重连');

sockets[1].h.close();
advance(5000);
ok(sockets.length === 3, 'W8 旧连接迟到回调不影响新连接、不重复重连');

console.log('\n== ws 连接状态机: ' + pass + '/' + total + ' 通过 ==');
process.exit(pass === total ? 0 : 1);
