/**
 * 一次性截图：章节完成仪式卡（21-march-chapter-ceremony.png）
 * 复用当前开发者工具登录态：进入 march 页待章节数据就绪后，
 * 在当前页直接重放章节仪式卡再截图（弹层行为断言由 p0-chapters.cjs 覆盖，
 * 本脚本只负责视觉记录，避免桥退化下轮询错过瞬时弹层）。
 *   node shot-chapter-ceremony.cjs
 */
const path = require('path');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const SHOT = path.join(__dirname, '..', 'images', '21-march-chapter-ceremony.png');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('命令超时: ' + label)), ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t));
}

(async () => {
  const mini = await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect');
  await withTimeout(mini.reLaunch('/pages/march/march'), 15000, 'reLaunch march');
  const start = Date.now();
  for (;;) {
    const p = await mini.currentPage().catch(() => null);
    if (p && p.path === 'pages/march/march') {
      const d = await p.data().catch(() => null);
      if (d && d.chapters && d.chapters.length === 5) break;
    }
    if (Date.now() - start > 25000) throw new Error('march 就绪超时');
    await sleep(400);
  }
  await withTimeout(mini.evaluate(() => {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    const ch = (page.data.chapters || []).find((c) => c.id === 1) || {};
    page.setData({
      litPopup: { kind: 'chapter', key: Date.now(), title: ch.title || '第一章 · 出发', intro: ch.intro || '' }
    });
    return true;
  }), 10000, 'replay ceremony');
  await sleep(700);
  await withTimeout(mini.screenshot({ path: SHOT }), 25000, 'screenshot');
  console.log('SHOT OK 21-march-chapter-ceremony.png');
  process.exit(0);
})().catch((e) => { console.log('FATAL: ' + (e && e.message)); process.exit(2); });
