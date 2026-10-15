/**
 * 日历详情弹层「点亮节点」行布局回归（断言专用，截图在最后一步单独执行）
 *
 * 背景：点亮节点展示 ⭐ 长文本时，text-gold 盒子整体掉到下一行，
 *       与 detail-label 不在同一行（text 组件行内原子盒被挤压换行）。
 * 修复：.detail-value 显式 display:block + word-break，.detail-label flex-shrink:0。
 *
 * 做法：直接 setData 注入 selected（长/短两种点亮文本），用 createSelectorQuery
 *       取 detail-label / detail-value 的 boundingClientRect，断言二者 top 一致。
 *       长连接易退化，每个用例独立建连并以主动导航唤醒桥（见测试协议 3b/3d）。
 *
 *   node calendar-detail-layout.cjs
 *
 * 前置：开发者工具自动化端口 9420 可用（cli auto --project ... --auto-port 9420）。
 */
const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const RESULTS_FILE = path.join(__dirname, 'results-calendar-layout.json');
const SHOT_FILE = path.join(__dirname, '..', 'images', 'calendar-detail-stars.png');

const LONG_NODES = ['突破乌江', '遵义会议', '四渡赤水', '巧渡金沙江', '强渡大渡河', '飞夺泸定桥'];

const results = [];
let mini = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('命令超时(' + ms + 'ms): ' + label)), ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t));
}

async function cmd(fn, desc, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await withTimeout(fn(), 20000, desc); } catch (e) {
      if (i === retries) throw e;
      console.log('retry[' + (i + 1) + '] ' + desc + ': ' + (e && e.message));
      await sleep(1500);
    }
  }
}

function record(id, name, pass, detail) {
  results.push({ id, name, pass: !!pass, detail: String(detail == null ? '' : detail).slice(0, 400) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + (detail ? ' | ' + detail : ''));
}

async function waitPath(prefix, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = await withTimeout(mini.currentPage().catch(() => null), 8000, 'currentPage').catch(() => null);
    if (p && p.path && p.path.indexOf(prefix) === 0) return p;
    await sleep(400);
  }
  throw new Error('等待页面超时: ' + prefix);
}

async function waitFor(fn, timeout = 30000, interval = 500, desc = 'condition') {
  const start = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { /* retry */ }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('等待超时: ' + desc);
    await sleep(interval);
  }
}

async function disconnectQuiet() {
  if (!mini) return;
  try { await mini.disconnect(); } catch (e) { /* ignore */ }
  mini = null;
}

/** 独立建连 + 主动导航打开日历页并等加载完成（唤醒退化桥） */
async function openCalendarFresh() {
  await disconnectQuiet();
  mini = await automator.connect({ wsEndpoint: WS });
  await cmd(() => mini.evaluate(() => wx.reLaunch({ url: '/pages/calendar/calendar' })), 'reLaunch calendar');
  const page = await waitPath('pages/calendar/calendar');
  await waitFor(async () => {
    const d = await page.data().catch(() => null);
    return d && d.loading === false ? true : null;
  }, 25000, 500, '日历加载完成');
  return page;
}

async function ensureLogin() {
  mini = await automator.connect({ wsEndpoint: WS });
  const logged = await cmd(() => mini.evaluate(() => {
    const app = getApp();
    return !!(app && app.globalData && app.globalData.loggedIn);
  }), 'check loggedIn', 1).catch(() => false);
  if (logged) return;
  await cmd(() => mini.evaluate(() => wx.reLaunch({ url: '/pages/launch/launch' })), 'reLaunch launch');
  await waitFor(async () => {
    const ok = await cmd(() => mini.evaluate(() => {
      const app = getApp();
      return !!(app && app.globalData && app.globalData.loggedIn);
    }), 'poll loggedIn', 0).catch(() => false);
    return ok ? true : null;
  }, 40000, 800, '登录态就绪');
}

function selectedData(litNodes) {
  return {
    date: '2026-10-14',
    stepsText: '12,345',
    level: 3,
    goalCompleted: true,
    quizDone: true,
    quizScore: 100,
    litNodes: litNodes,
    litNodesText: litNodes.join('、'),
    isToday: false
  };
}

/** 注入当日详情并返回「点亮节点」行 label/value 的矩形 */
async function measureDetailRow(litNodes) {
  const page = await openCalendarFresh();
  await cmd(() => page.setData({ selected: selectedData(litNodes) }), 'setData selected');
  await sleep(700); // 等 anim-pop 动画与渲染落定
  const rects = await cmd(() => mini.evaluate(() => new Promise((resolve) => {
    wx.createSelectorQuery()
      .selectAll('.detail-row .detail-label, .detail-row .detail-value')
      .boundingClientRect((rs) => resolve(rs || []))
      .exec();
  })), 'query detail-row rects');
  // 文档顺序：行1 label、行1 value、行2 label、行2 value
  return rects && rects.length >= 4 ? { label: rects[2], value: rects[3] } : null;
}

function checkSameRow(id, name, pair) {
  if (!pair || !pair.label || !pair.value) {
    record(id, name, false, '未取到矩形: ' + JSON.stringify(pair));
    return;
  }
  const topDiff = Math.abs(pair.label.top - pair.value.top);
  const sameRow = topDiff <= 3;
  const leftOrder = pair.value.left > pair.label.left;
  record(id, name, sameRow && leftOrder,
    'label.top=' + pair.label.top.toFixed(1) + ' value.top=' + pair.value.top.toFixed(1) +
    ' topDiff=' + topDiff.toFixed(1) + ' label.left=' + pair.label.left.toFixed(1) +
    ' value.left=' + pair.value.left.toFixed(1) + ' value.h=' + pair.value.height.toFixed(1));
}

(async () => {
  try {
    await ensureLogin();
    console.log('登录态就绪');

    // 用例1：长点亮文本（修复前整盒掉行场景）
    const longPair = await measureDetailRow(LONG_NODES);
    checkSameRow('C1', '点亮节点长文本与标签同一行', longPair);

    // 用例2：无点亮（原「无」分支不回归）
    const nonePair = await measureDetailRow([]);
    checkSameRow('C2', '无点亮时「无」与标签同一行', nonePair);

    // 证据截图放最后（截图会让自动化桥退化）：独立建连重开弹层后只截一次
    if (longPair) {
      try {
        const page = await openCalendarFresh();
        await cmd(() => page.setData({ selected: selectedData(LONG_NODES) }), 'setData selected(shot)');
        await sleep(700);
        await cmd(() => mini.screenshot({ path: SHOT_FILE }), 'screenshot', 0);
        console.log('截图 → ' + SHOT_FILE);
      } catch (e) {
        console.log('截图失败(忽略): ' + e.message);
      }
    }
  } catch (e) {
    record('C0', '套件执行', false, e && e.message);
  } finally {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    const passed = results.filter((r) => r.pass).length;
    console.log('---- 结果: ' + passed + '/' + results.length + ' 通过 → ' + RESULTS_FILE);
    await disconnectQuiet();
    process.exit(results.every((r) => r.pass) && results.length > 0 ? 0 : 1);
  }
})();
