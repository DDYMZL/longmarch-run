/**
 * 星空长征 L7 实时数据叠加层 + L8 WS 飞线 验收（断言专用，不截图 —— 截图由 hud-overlay-shots.cjs 分离补拍）
 *
 * 覆盖：
 *   OV-01 L7 数据注入：真实两接口合并后 hud.stats 就绪，节点抵达统计覆盖全部路线节点
 *   OV-02 数据缺失降级：setStats(null) 后面板画 -- 且不抛异常，last-good 可复原
 *   OV-03 进度仪表环：百分比文案与 routeProgress 同口径，整数未变时不重建字符串
 *   OV-04 L8 飞线生命周期：playFlyLine 定位正确、播完自动清除、未知节点静默忽略
 *   OV-05 人数徽标：缩放 <1.5 不并入标签，≥1.5 时已点亮/当前节点标签尾部带人数
 *   OV-06 每帧预算：120 帧均值 <16ms，fillText ≤22、drawImage ≤30
 *   OV-07 WS 订阅随页面生命周期：onShow 订阅、切走 tab 退订、切回重新订阅
 *   OV-08 data_changed 5s 节流；activity 只画飞线不发请求
 *   OV-09 实景模式不产生叠加层请求
 *   OV-10 全程无新增运行时异常
 *
 * 断言对象：绘制状态与方法全部在渲染内核 page.hud（utils/hudMap）上；
 * 页面侧断言 _overlayStats / _statsAt / _wsUnsub。
 *
 *   cd frontend/test/automator && node hud-overlay.cjs
 * 前置：开发者工具自动化端口 9420 可用、模拟器已有有效登录态、后端 8010 在跑（config.js DEV_TARGET=local）。
 */
const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const RESULTS_FILE = path.join(__dirname, 'results-hud-overlay.json');

const results = [];
const errors = [];
let mini = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(id, name, pass, detail) {
  results.push({ id, name, pass: !!pass, detail: String(detail == null ? '' : detail).slice(0, 600) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + (detail ? ' | ' + detail : ''));
}

async function waitPath(prefix, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = await mini.currentPage().catch(() => null);
    if (p && p.path && p.path.indexOf(prefix) === 0) return p;
    await sleep(400);
  }
  throw new Error('等待页面超时: ' + prefix);
}

async function waitFor(fn, timeout = 15000, desc = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('等待超时: ' + desc);
    await sleep(400);
  }
}

/** 打开星空模式并等待几何就绪，同时等待 L7 数据注入（最多 12s，超时则按未注入继续） */
async function openStarry() {
  await mini.switchTab('/pages/march/march');
  const page = await waitPath('pages/march/march');
  await page.callMethod('skipIntro').catch(() => {});
  await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } });
  await waitFor(() => mini.evaluate(() => {
    const p = getCurrentPages().pop();
    const h = p && p.hud;
    if (!(h && p.routeData && h.nodePts && h.nodePts.length && h.path)) return false;
    getApp().__ovMarch = p;
    return true;
  }), 20000, 'canvas ready');
  await waitFor(() => mini.evaluate(() => !!getApp().__ovMarch.hud.stats), 12000, 'L7 stats').catch(() => null);
  return page;
}

(async () => {
  mini = await automator.connect({ wsEndpoint: WS });
  mini.on('exception', (e) => errors.push('exception: ' + e.message));
  mini.on('console', (m) => { if (m.type === 'error') errors.push('console.error: ' + JSON.stringify(m.args).slice(0, 200)); });

  const loggedIn = await mini.evaluate(() => !!getApp().globalData.loggedIn);
  if (!loggedIn) {
    await mini.reLaunch('/pages/launch/launch');
    await waitPath('pages/home/home', 30000);
  }

  let page = null;

  /* OV-01 L7 数据注入（真实接口） */
  try {
    page = await openStarry();
    const s = await mini.evaluate(() => {
      const p = getApp().__ovMarch;
      const h = p.hud;
      const o = p._overlayStats;
      return {
        hasStats: !!h.stats,
        lines: h.stats ? h.stats.lines : null,
        badgeKeys: h.stats ? Object.keys(h.stats.badges).length : 0,
        badgeSample: h.stats ? Object.keys(h.stats.badges).slice(0, 3).map((k) => k + '=' + h.stats.badges[k]) : [],
        litMap: o ? Object.keys(o.litMap).length : 0,
        raw: o ? [o.todayUsers, o.todayLit, o.todaySteps] : null,
        nodes: h.route.nodes.length,
        sampleRate: o && o.litMap[1] ? o.litMap[1].completionRate : null
      };
    });
    const ok = s.hasStats && Array.isArray(s.lines) && s.lines.length === 3
      && s.lines.every((x) => x !== '--') && s.litMap === s.nodes && s.badgeKeys === s.nodes;
    record('OV-01', 'L7 数据注入：两接口合并后 stats 就绪、抵达统计覆盖全部节点', ok, JSON.stringify(s));
  } catch (e) { record('OV-01', 'L7 数据注入', false, e.message); }

  /* OV-02 数据缺失降级为 -- */
  try {
    const s = await mini.evaluate(() => {
      const p = getApp().__ovMarch;
      const h = p.hud;
      const before = h.stats ? h.stats.lines.slice() : null;
      h.setStats(null);
      const nulled = h.stats === null;
      let drew = true;
      try { h.drawOverlay(); } catch (e) { drew = 'throw: ' + e.message; }
      h.setStats(p._overlayStats); // last-good 复原
      return { before, nulled, drew, after: h.stats ? h.stats.lines.slice() : null };
    });
    const ok = s.nulled && s.drew === true && JSON.stringify(s.before) === JSON.stringify(s.after);
    record('OV-02', '数据缺失时面板画 -- 不抛异常，last-good 可复原', ok, JSON.stringify(s));
  } catch (e) { record('OV-02', '降级显示', false, e.message); }

  /* OV-03 进度仪表环 */
  try {
    const s = await mini.evaluate(() => {
      const h = getApp().__ovMarch.hud;
      h.draw(Date.now() / 1000);
      const once = { text: h._ringText, pct: h._ringPct, ratio: h.currentRatio() };
      h.draw(Date.now() / 1000);
      return {
        text: once.text, pct: once.pct,
        expect: Math.round(once.ratio * 100),
        routeProgress: h.route.routeProgress,
        stable: h._ringText === once.text && h._ringPct === once.pct
      };
    });
    const ok = s.text === s.expect + '%' && s.pct === s.expect && s.stable
      && Math.abs(s.routeProgress * 100 - s.expect) <= 1;
    record('OV-03', '进度仪表环百分比与 routeProgress 同口径且缓存稳定', ok, JSON.stringify(s));
  } catch (e) { record('OV-03', '进度仪表环', false, e.message); }

  /* OV-04 L8 飞线生命周期 */
  try {
    const id = await mini.evaluate(() => getApp().__ovMarch.hud.route.nodes[3].id);
    const start = await mini.evaluate((nid) => {
      const h = getApp().__ovMarch.hud;
      h.flyLine = null;
      h.playFlyLine(nid);
      const started = !!h.flyLine && h.flyLine.idx === h.nodeIndex[nid];
      let drew = true;
      try { h.drawFlyLine(); } catch (e) { drew = 'throw: ' + e.message; }
      h.playFlyLine(999999); // 未知节点：不得覆盖当前飞线
      return { started, idx: h.flyLine ? h.flyLine.idx : null, expect: h.nodeIndex[nid], drew, stillSame: !!h.flyLine };
    }, id);
    await sleep(1900);
    const cleared = await mini.evaluate(() => {
      const h = getApp().__ovMarch.hud;
      h.draw(Date.now() / 1000);
      return h.flyLine === null;
    });
    const ok = start.started && start.idx === start.expect && start.drew === true && start.stillSame && cleared;
    record('OV-04', 'L8 飞线：定位正确、未知节点忽略、播完自动清除', ok,
      JSON.stringify(start) + ' cleared=' + cleared);
  } catch (e) { record('OV-04', '飞线生命周期', false, e.message); }

  /* OV-05 人数徽标随缩放并入标签 */
  try {
    const s = await mini.evaluate(() => {
      const h = getApp().__ovMarch.hud;
      const names = h.route.nodes.map((n) => n.name);
      h._labelW = {};
      h.view.scale = 1; h.clampView(); h.draw(Date.now() / 1000);
      const low = Object.keys(h._labelW);
      h.view.scale = 2; h.clampView(); h.draw(Date.now() / 1000);
      const hi = Object.keys(h._labelW);
      h.resetView();
      return { low, hi, names, litStates: h.route.nodes.map((n) => n.status) };
    });
    const badgeRe = /\s[\d.,]+(万|亿)?$/;
    const lowPlain = s.low.length === s.names.length && s.low.every((k) => s.names.indexOf(k) >= 0);
    const badges = s.hi.filter((k) => badgeRe.test(k));
    const litCount = s.litStates.filter((x) => x === 'completed' || x === 'current').length;
    const ok = lowPlain && badges.length === litCount && litCount > 0;
    record('OV-05', '人数徽标：缩放 1 不并入、缩放 2 仅已点亮/当前节点并入', ok,
      'low=' + JSON.stringify(s.low) + ' badges=' + JSON.stringify(badges) + ' lit=' + litCount);
  } catch (e) { record('OV-05', '人数徽标', false, e.message); }

  /* OV-06 每帧预算与耗时 */
  try {
    const perf = await mini.evaluate(() => {
      const h = getApp().__ovMarch.hud;
      const c = h.ctx;
      const keys = ['fillText', 'drawImage', 'stroke'];
      const counts = { fillText: 0, drawImage: 0, stroke: 0 };
      const orig = {};
      let patchable = true;
      keys.forEach((k) => {
        orig[k] = c[k];
        try {
          c[k] = function () { counts[k]++; return orig[k].apply(c, arguments); };
        } catch (e) { patchable = false; }
      });
      const N = 120;
      const t0 = Date.now();
      for (let i = 0; i < N; i++) h.draw(t0 / 1000 + i / 60);
      const frameMs = (Date.now() - t0) / N;
      keys.forEach((k) => { try { c[k] = orig[k]; } catch (e) { /* 原生对象不可写时忽略 */ } });
      return { frameMs, patchable, fillText: counts.fillText / N, drawImage: counts.drawImage / N, stroke: counts.stroke / N };
    });
    const ok = perf.frameMs < 16 && (!perf.patchable || (perf.fillText <= 22 && perf.drawImage <= 30));
    record('OV-06', '每帧预算：耗时 <16ms，fillText ≤22、drawImage ≤30', ok,
      'frame=' + perf.frameMs.toFixed(2) + 'ms fillText=' + perf.fillText.toFixed(1)
      + ' drawImage=' + perf.drawImage.toFixed(1) + ' stroke=' + perf.stroke.toFixed(1)
      + ' patchable=' + perf.patchable);
  } catch (e) { record('OV-06', '每帧预算', false, e.message); }

  /* OV-07 WS 订阅随生命周期 */
  try {
    const on = await mini.evaluate(() => typeof getApp().__ovMarch._wsUnsub === 'function');
    await mini.switchTab('/pages/home/home');
    await waitPath('pages/home/home');
    await sleep(500);
    const off = await mini.evaluate(() => getApp().__ovMarch._wsUnsub === null);
    await mini.switchTab('/pages/march/march');
    await waitPath('pages/march/march');
    await sleep(600);
    const back = await mini.evaluate(() => typeof getApp().__ovMarch._wsUnsub === 'function');
    record('OV-07', 'WS 订阅：onShow 订阅 / 切走退订 / 切回重新订阅', on && off && back,
      'on=' + on + ' off=' + off + ' back=' + back);
  } catch (e) { record('OV-07', 'WS 订阅生命周期', false, e.message); }

  /* OV-08 data_changed 节流 + activity 不发请求 */
  try {
    await openStarry();
    const s = await mini.evaluate(() => {
      const p = getApp().__ovMarch;
      const h = p.hud;
      p._statsAt = 0;
      p.handleWsMessage({ type: 'data_changed' });
      const first = p._statsAt;
      p.handleWsMessage({ type: 'data_changed' });
      const second = p._statsAt;
      h.flyLine = null;
      const nid = h.route.nodes[5].id;
      p.handleWsMessage({ type: 'activity', nodeId: nid, nickname: '测试', text: '抵达' });
      const afterActivity = p._statsAt;
      return {
        first, second,
        flyIdx: h.flyLine ? h.flyLine.idx : null,
        expectIdx: h.nodeIndex[nid],
        activityNoRequest: afterActivity === second
      };
    });
    const ok = s.first > 0 && s.second === s.first && s.flyIdx === s.expectIdx && s.activityNoRequest;
    record('OV-08', 'data_changed 5s 节流；activity 只画飞线不发请求', ok, JSON.stringify(s));
  } catch (e) { record('OV-08', 'WS 消息处理', false, e.message); }

  /* OV-09 实景模式不发叠加层请求 */
  try {
    page = await waitPath('pages/march/march');
    await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'real' } } });
    await sleep(700);
    const s = await mini.evaluate(() => {
      const p = getApp().__ovMarch;
      p._statsAt = 0;
      p.loadOverlay();
      return { mode: p.data.mode, statsAt: p._statsAt, hud: !!p.hud, lastGood: !!p._overlayStats };
    });
    const ok = s.mode === 'real' && s.statsAt === 0 && !s.hud && s.lastGood;
    record('OV-09', '实景模式：不发叠加层请求，last-good 数据保留', ok, JSON.stringify(s));
    await openStarry(); // 复位到星空模式，便于分离截图脚本接手
  } catch (e) { record('OV-09', '实景模式跳过请求', false, e.message); }

  await sleep(1000);
  record('OV-10', '全程无新增运行时异常', errors.length === 0, errors.slice(0, 5).join(' | '));

  await mini.evaluate(() => { delete getApp().__ovMarch; return true; }).catch(() => {});
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log('\n' + results.filter((r) => r.pass).length + '/' + results.length + ' PASS');
  mini.disconnect();
  process.exit(0);
})().catch((e) => {
  console.log('FATAL', e.message);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  process.exit(1);
});
