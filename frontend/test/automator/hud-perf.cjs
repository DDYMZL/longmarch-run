/**
 * 星空长征帧率自适应降级（S5）验收（断言专用，不截图 —— 截图由 hud-perf-shots.cjs 分离补拍）
 *
 * 覆盖：
 *   PD-01 常态采样：真实 rAF 跑满窗口后 lowPerf=false，均值落在预算内
 *   PD-02 降级触发：滚动 30 帧间隔均值 >33ms 时置 lowPerf
 *   PD-03 不自动恢复：降级后即使帧间隔回到 8ms 仍保持降级，且停止采样
 *   PD-04 样本净化：首帧不产生样本；暂停/切后台造成的 >1s 时间跳变被丢弃
 *   PD-05 满窗才判定：29 帧超预算不降级，第 30 帧才降级
 *   PD-06 L4 水平扫描带被关闭（fillRect 每帧恰少 2 次）
 *   PD-07 叙事/数据层不受影响（stroke 与 fillText 每帧次数不变）
 *   PD-08 点亮粒子扩散被关闭（arc 每帧减少量 = 可见粒子数）
 *   PD-09 每帧预算：常态与降级两轮 120 帧均值均 <16ms
 *   PD-10 dispose 复位与实例重建：往返实景模式后新内核从 0 重新测量
 *   PD-11 真实 rAF 链路复测：重建后满窗采样仍不误降级
 *   PD-12 全程无新增运行时异常
 *
 * 断言对象：降级状态与采样器全部在渲染内核 page.hud（utils/hudMap）上——
 * lowPerf / _perfBuf / _perfN / _perfI / _perfSum / _perfLast / _perfAvg。
 *
 * 说明：draw(t) 的 t 由页面 rAF 传入（单位秒），采样器只看相邻 t 的差值，故可用合成时间戳
 * 确定性地驱动降级判定；测量前必须先 p.stopAnim() 停掉页面真实 rAF，否则两路 t 互相污染。
 * mini.evaluate 只接受真实函数（内部走 fn.toString()），全部入参经 args 传递，不闭包外部变量。
 *
 *   cd frontend/test/automator && node hud-perf.cjs
 * 前置：开发者工具自动化端口 9420 可用、模拟器已有有效登录态、后端 8010 在跑（config.js DEV_TARGET=local）。
 */
const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const RESULTS_FILE = path.join(__dirname, 'results-hud-perf.json');

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

/** 打开星空模式并等待几何就绪，把页面句柄挂到 getApp().__pdMarch */
async function openStarry() {
  await mini.switchTab('/pages/march/march');
  const page = await waitPath('pages/march/march');
  await page.callMethod('skipIntro').catch(() => {});
  await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } });
  await waitFor(() => mini.evaluate(() => {
    const p = getCurrentPages().pop();
    const h = p && p.hud;
    if (!(h && p.routeData && h.nodePts && h.nodePts.length && h.path)) return false;
    getApp().__pdMarch = p;
    return true;
  }), 20000, 'canvas ready');
  return page;
}

/**
 * 用合成时间戳驱动 n 帧（每帧 stepMs 间隔），返回采样器状态。
 * @param {Object} o
 * @param {number} o.t0        起始时间戳（秒）
 * @param {number} o.n         驱动帧数
 * @param {number} o.stepMs    每帧间隔（ms）
 * @param {boolean} o.resetLowPerf 驱动前是否把 lowPerf 复位为 false
 * @param {number} [o.gapSec]  首帧后插入的时间跳变（秒），用于验证暂停样本被丢弃
 * @param {number} [o.probeAt] 在第几帧后额外快照一次采样器状态
 */
function driveFrames(o) {
  return mini.evaluate((cfg) => {
    const h = getApp().__pdMarch.hud;
    if (cfg.resetLowPerf) h.lowPerf = false;
    h._perfN = 0; h._perfI = 0; h._perfSum = 0; h._perfLast = 0; h._perfAvg = 0;
    const t0 = cfg.t0;
    h.draw(t0);
    const afterFirst = h._perfN;
    let base = t0;
    if (cfg.gapSec) {
      h.draw(t0 + cfg.gapSec);
      base = t0 + cfg.gapSec;
    }
    const afterGap = { n: h._perfN, avg: h._perfAvg, last: h._perfLast };
    let probe = null;
    for (let i = 1; i <= cfg.n; i++) {
      h.draw(base + (i * cfg.stepMs) / 1000);
      if (cfg.probeAt === i) probe = { lowPerf: h.lowPerf, n: h._perfN, avg: h._perfAvg };
    }
    return {
      afterFirst: afterFirst,
      afterGap: afterGap,
      probe: probe,
      lowPerf: h.lowPerf,
      n: h._perfN,
      i: h._perfI,
      avg: h._perfAvg,
      sum: h._perfSum,
      bufLen: (h._perfBuf || []).length
    };
  }, o);
}

/**
 * 对 ctx 的指定方法打点计数，跑 n 帧后返回每帧均值；lowPerf 传布尔值时强制设定，传 null 则不改动。
 * 无论是否改 lowPerf 都必须清空采样窗口：上一轮遗留的高间隔样本会让 samplePerf 在下一帧
 * 立刻把 lowPerf 重新置真（这正是「不自动恢复」的语义），测量就只覆盖到第一帧。
 */
function countCalls(keys, n, lowPerf) {
  return mini.evaluate((o) => {
    const h = getApp().__pdMarch.hud;
    const c = h.ctx;
    if (typeof o.lowPerf === 'boolean') h.lowPerf = o.lowPerf;
    h._perfN = 0; h._perfI = 0; h._perfSum = 0; h._perfLast = 0; h._perfAvg = 0;
    const counts = {};
    const orig = {};
    let patchable = true;
    o.keys.forEach((k) => {
      counts[k] = 0;
      orig[k] = c[k];
      try {
        c[k] = function () { counts[k]++; return orig[k].apply(c, arguments); };
      } catch (e) { patchable = false; }
    });
    const t0 = 5000;
    for (let i = 0; i < o.n; i++) h.draw(t0 + i / 60);
    o.keys.forEach((k) => { try { c[k] = orig[k]; } catch (e) { /* 原生对象不可写时忽略 */ } });
    const out = { patchable: patchable };
    o.keys.forEach((k) => { out[k] = counts[k] / o.n; });
    return out;
  }, { keys: keys, n: n, lowPerf: lowPerf });
}

/** 跑 n 帧测真实耗时均值（ms/帧）；同样清空采样窗口，避免上一轮样本让本轮中途降级 */
function benchFrames(n, lowPerf) {
  return mini.evaluate((o) => {
    const h = getApp().__pdMarch.hud;
    h.lowPerf = o.lowPerf;
    h._perfN = 0; h._perfI = 0; h._perfSum = 0; h._perfLast = 0; h._perfAvg = 0;
    h.arriveFx = null;
    const t0 = Date.now();
    for (let i = 0; i < o.n; i++) h.draw(t0 / 1000 + i / 60);
    return (Date.now() - t0) / o.n;
  }, { n: n, lowPerf: lowPerf });
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

  await openStarry();

  /* PD-01 常态采样：真实 rAF 跑满窗口，不降级 */
  try {
    await mini.evaluate(() => { const p = getApp().__pdMarch; p.stopAnim(); p.startAnim(); return true; });
    await sleep(1800); // > 30 帧 @60fps
    const s = await mini.evaluate(() => {
      const h = getApp().__pdMarch.hud;
      return { lowPerf: h.lowPerf, n: h._perfN, avg: +h._perfAvg.toFixed(3), bufLen: (h._perfBuf || []).length };
    });
    const ok = s.lowPerf === false && s.n === 30 && s.bufLen === 30 && s.avg > 0 && s.avg <= 33;
    record('PD-01', '常态：真实 rAF 满窗采样且不降级', ok, JSON.stringify(s));
  } catch (e) { record('PD-01', '常态采样', false, e.message); }

  // 以下断言全部用合成时间戳驱动，先停掉页面真实 rAF
  await mini.evaluate(() => { getApp().__pdMarch.stopAnim(); return true; });

  /* PD-02 降级触发：30 帧 × 40ms（> 33ms 预算） */
  let d2 = null;
  try {
    d2 = await driveFrames({ t0: 1000, n: 30, stepMs: 40, resetLowPerf: true });
    const ok = d2.lowPerf === true && d2.n === 30 && Math.abs(d2.avg - 40) < 0.01;
    record('PD-02', '降级触发：滚动 30 帧均值 40ms > 33ms 预算', ok,
      'lowPerf=' + d2.lowPerf + ' n=' + d2.n + ' avg=' + d2.avg.toFixed(3) + ' bufLen=' + d2.bufLen);
  } catch (e) { record('PD-02', '降级触发', false, e.message); }

  /* PD-03 不自动恢复：降级后喂 30 帧 × 8ms（远优于预算），采样应已停止 */
  try {
    const after = await mini.evaluate(() => {
      const h = getApp().__pdMarch.hud;
      const t0 = 9000;
      h.draw(t0);
      for (let i = 1; i <= 30; i++) h.draw(t0 + i * 0.008);
      return { lowPerf: h.lowPerf, n: h._perfN, avg: h._perfAvg, sum: h._perfSum, last: +h._perfLast.toFixed(3) };
    });
    const ok = !!d2 && after.lowPerf === true && after.n === d2.n
      && after.avg === d2.avg && after.sum === d2.sum;
    record('PD-03', '不自动恢复：帧间隔回到 8ms 仍降级，且采样已停止', ok,
      '降级时 n=' + (d2 && d2.n) + ' avg=' + (d2 && d2.avg.toFixed(3))
      + ' → 30 帧 8ms 后 n=' + after.n + ' avg=' + after.avg.toFixed(3) + ' sum=' + after.sum.toFixed(3));
  } catch (e) { record('PD-03', '不自动恢复', false, e.message); }

  /* PD-04 样本净化：首帧无样本 + >1s 时间跳变丢弃 */
  try {
    const r = await driveFrames({ t0: 20000, n: 30, stepMs: 40, resetLowPerf: true, gapSec: 5 });
    const ok = r.afterFirst === 0 && r.afterGap.n === 0 && r.afterGap.avg === 0
      && r.lowPerf === true && r.n === 30 && Math.abs(r.avg - 40) < 0.01;
    record('PD-04', '样本净化：首帧不计数、>1s 时间跳变被丢弃且不污染均值', ok,
      '首帧后 n=' + r.afterFirst + ' | 5s 跳变后 n=' + r.afterGap.n + ' avg=' + r.afterGap.avg
      + ' | 随后 30 帧 40ms → lowPerf=' + r.lowPerf + ' avg=' + r.avg.toFixed(3));
  } catch (e) { record('PD-04', '样本净化', false, e.message); }

  /* PD-05 满窗才判定：29 帧超预算不降级，第 30 帧才降级 */
  try {
    const r = await driveFrames({ t0: 30000, n: 30, stepMs: 100, resetLowPerf: true, probeAt: 29 });
    const p29 = r.probe || {};
    const ok = p29.lowPerf === false && p29.n === 29 && p29.avg === 0
      && r.lowPerf === true && r.n === 30 && Math.abs(r.avg - 100) < 0.01;
    record('PD-05', '满窗才判定：29 帧超预算不降级，第 30 帧降级', ok,
      '第 29 帧 ' + JSON.stringify(p29) + ' → 第 30 帧 lowPerf=' + r.lowPerf + ' avg=' + r.avg.toFixed(3));
  } catch (e) { record('PD-05', '满窗判定', false, e.message); }

  /* PD-06 / PD-07 L4 扫描带关闭、叙事与数据层保留 */
  try {
    const keys = ['fillRect', 'stroke', 'fillText', 'drawImage'];
    const normal = await countCalls(keys, 60, false);
    const degraded = await countCalls(keys, 60, true);
    const dRect = +(normal.fillRect - degraded.fillRect).toFixed(3);
    record('PD-06', 'L4 水平扫描带被关闭：fillRect 每帧恰少 2 次', normal.patchable && dRect === 2,
      'fillRect 常态=' + normal.fillRect.toFixed(2) + ' 降级=' + degraded.fillRect.toFixed(2) + ' Δ=' + dRect);
    const ok7 = normal.stroke === degraded.stroke && normal.fillText === degraded.fillText;
    record('PD-07', '叙事/数据层不受影响：stroke 与 fillText 每帧次数不变（L5 流光、六边环、L7 面板全保留）', ok7,
      'stroke ' + normal.stroke.toFixed(2) + '→' + degraded.stroke.toFixed(2)
      + ' | fillText ' + normal.fillText.toFixed(2) + '→' + degraded.fillText.toFixed(2)
      + ' | drawImage ' + normal.drawImage.toFixed(2) + '→' + degraded.drawImage.toFixed(2));
  } catch (e) {
    record('PD-06', 'L4 扫描带关闭', false, e.message);
    record('PD-07', '叙事描边保留', false, e.message);
  }

  /* PD-08 点亮粒子扩散被关闭 */
  try {
    const nid = await mini.evaluate(() => getApp().__pdMarch.routeData.nodes[0].id);
    const measure = async () => {
      await mini.evaluate((id) => { getApp().__pdMarch.hud.playArrive([id]); return true; }, nid);
      await sleep(450); // 粒子 delay 0.2~0.4s，此时全部可见；fx 总时长 2.4s
      return countCalls(['arc'], 5, null);
    };
    await mini.evaluate(() => { getApp().__pdMarch.hud.lowPerf = false; return true; });
    const a = await measure();
    await mini.evaluate(() => { getApp().__pdMarch.hud.lowPerf = true; return true; });
    const b = await measure();
    const parts = await mini.evaluate(() => {
      const h = getApp().__pdMarch.hud;
      return h.arriveFx && h.arriveFx.particles ? h.arriveFx.particles.length : -1;
    });
    const delta = +(a.arc - b.arc).toFixed(3);
    const ok = delta > 0 && Math.abs(delta - parts) < 0.01;
    await mini.evaluate(() => { getApp().__pdMarch.hud.arriveFx = null; return true; });
    record('PD-08', '点亮粒子扩散被关闭：arc 每帧减少量 = 粒子数', ok,
      'arc 常态=' + a.arc.toFixed(2) + ' 降级=' + b.arc.toFixed(2) + ' Δ=' + delta + ' 粒子数=' + parts);
  } catch (e) { record('PD-08', '点亮粒子关闭', false, e.message); }

  /* PD-09 每帧预算：常态与降级两轮 120 帧均值均 <16ms */
  try {
    const normal = await benchFrames(120, false);
    const degraded = await benchFrames(120, true);
    record('PD-09', '每帧预算：常态与降级两轮 120 帧均值均 <16ms', normal < 16 && degraded < 16,
      '常态=' + normal.toFixed(3) + 'ms 降级=' + degraded.toFixed(3) + 'ms Δ=' + (normal - degraded).toFixed(3) + 'ms');
  } catch (e) { record('PD-09', '每帧预算', false, e.message); }

  /* PD-10 dispose 复位与实例重建（往返实景模式）
   * 释放是异步的：switchMode 先同步 stopAnim，再在 setData 回调里 dispose + 置空 this.hud
   * （实测 data.mode 约 400ms 翻转、hud 约 800ms 才置空），故必须轮询而非固定 sleep。
   * 重建后页面 rAF 立刻起转，_perfN 无法观测到 0，故「新实例」用标记物证：
   * 切换前给旧内核打 __pdTag，重建后标记必须消失；「降级不跨实例继承」用 lowPerf=false 证。 */
  try {
    await mini.evaluate(() => {
      const h = getApp().__pdMarch.hud;
      h.lowPerf = true;
      h.__pdTag = 'OLD';
      return true;
    });
    const page = await waitPath('pages/march/march');
    const t0 = Date.now();
    await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'real' } } });
    await waitFor(() => mini.evaluate(() => !getApp().__pdMarch.hud), 10000, 'hud disposed');
    const disposeMs = Date.now() - t0;
    await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } });
    await waitFor(() => mini.evaluate(() => {
      const p = getCurrentPages().pop();
      if (!(p && p.hud && p.hud.nodePts && p.hud.nodePts.length)) return false;
      getApp().__pdMarch = p;
      return true;
    }), 20000, 'rebuild');
    const fresh = await mini.evaluate(() => {
      const h = getApp().__pdMarch.hud;
      return {
        tag: h.__pdTag === undefined ? null : h.__pdTag,
        lowPerf: h.lowPerf, n: h._perfN, sum: h._perfSum,
        avg: h._perfAvg, bufLen: (h._perfBuf || []).length
      };
    });
    const ok = fresh.tag === null && fresh.lowPerf === false && fresh.bufLen === 30 && fresh.n <= 30;
    record('PD-10', 'dispose 复位与实例重建：往返实景后换新内核且不继承降级标记', ok,
      '释放耗时 ' + disposeMs + 'ms（hud 置空）| 重建后 ' + JSON.stringify(fresh));
  } catch (e) { record('PD-10', 'dispose 复位与重建', false, e.message); }

  /* PD-11 重建后再跑真实 rAF，确认降级判定在真实链路上不误触发 */
  try {
    await mini.evaluate(() => { const p = getApp().__pdMarch; p.stopAnim(); p.startAnim(); return true; });
    await sleep(1800);
    const s = await mini.evaluate(() => {
      const h = getApp().__pdMarch.hud;
      return { lowPerf: h.lowPerf, n: h._perfN, avg: +h._perfAvg.toFixed(3) };
    });
    const ok = s.n === 30 && s.lowPerf === false && s.avg > 0 && s.avg <= 33;
    record('PD-11', '真实 rAF 链路复测：重建后满窗采样仍不误降级', ok, JSON.stringify(s));
  } catch (e) { record('PD-11', '真实链路复测', false, e.message); }

  await sleep(800);
  record('PD-12', '全程无新增运行时异常', errors.length === 0, errors.slice(0, 5).join(' | '));

  await mini.evaluate(() => { delete getApp().__pdMarch; return true; }).catch(() => {});
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log('\n' + results.filter((r) => r.pass).length + '/' + results.length + ' PASS');
  mini.disconnect();
  process.exit(0);
})().catch((e) => {
  console.log('FATAL', e.message);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  process.exit(1);
});
