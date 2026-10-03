/**
 * 一次性补拍：34-ticket.png（瑞金纪念票）。
 * 上一状态截图后自动化桥退化，需独立连接 + 主动导航起手（见测试协议 3b/3c）。
 *   node shot-ticket.cjs
 */
const path = require('path');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const SHOT_TICKET = path.join(__dirname, '..', 'images', '34-ticket.png');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('命令超时(' + ms + 'ms): ' + label)), ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t));
}

(async () => {
  const mini = await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect');
  await withTimeout(mini.reLaunch('/pages/ticket/ticket?id=1'), 20000, 'reLaunch ticket');
  const start = Date.now();
  let page = null;
  while (Date.now() - start < 25000) {
    page = await withTimeout(mini.currentPage().catch(() => null), 8000, 'currentPage').catch(() => null);
    if (page && page.path && page.path.indexOf('pages/ticket/ticket') === 0) break;
    await sleep(400);
  }
  if (!page) throw new Error('等待页面超时: pages/ticket/ticket');
  const readyStart = Date.now();
  for (;;) {
    const dd = await withTimeout(page.data().catch(() => null), 8000, 'ticket data').catch(() => null);
    if (dd && dd.ready) break;
    if (Date.now() - readyStart > 15000) throw new Error('等待票面就绪超时');
    await sleep(400);
  }
  await sleep(1200);
  await withTimeout(mini.screenshot({ path: SHOT_TICKET }), 25000, 'screenshot ticket');
  console.log('SHOT 34-ticket.png');
  process.exit(0);
})().catch((e) => {
  console.log('FATAL: ' + (e && e.message));
  process.exit(1);
});
