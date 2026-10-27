/**
 * 星空红线终点与节点点亮位置对齐验收
 * （缺陷复现：累计 46000 步、「过草地」已点亮，但红色已完成路径仍停在过草地之前）
 *   cd frontend/test/automator && node starmap-progress-align.cjs
 * 输出：frontend/test/images/starmap-progress-46000.png、results-starmap-progress.json
 *
 * 前置：微信开发者工具已开、自动化端口 9420 已武装
 *       （cli.bat auto --project D:/project/longmarch-run --auto-port 9420）。
 * 说明：后端可达且已登录时先用真实路线做一次断言（SP-01）；主断言走「渲染数据注入」——
 *       只向模拟器内的渲染内核注入报障态路线（节点几何/阈值取 backend seed.py 真实配置），
 *       不改业务数据、不动登录链路。截图会使自动化桥退化，故断言在前、截图在后。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const automator = require('miniprogram-automator');

const IMG = path.join(__dirname, '..', 'images');
const CLI = 'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const RESULTS = path.join(__dirname, 'results-starmap-progress.json');
const TOTAL = 65000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 报障态路线：累计 46000 步，过草地（45000）已点亮，正在前往吴起镇（55000） */
const FAKE_ROUTE = (() => {
  const seed = [
    [1, '瑞金', 0, 25.885, 116.027],
    [2, '遵义', 5000, 27.72, 106.93],
    [3, '四渡赤水', 10000, 28.3, 106.42],
    [4, '巧渡金沙江', 15000, 26.28, 102.47],
    [5, '强渡大渡河', 20000, 29.25, 102.3],
    [6, '飞夺泸定桥', 25000, 29.92, 102.23],
    [7, '翻越雪山', 35000, 35.62, 103.62],
    [8, '过草地', 45000, 33.58, 102.96],
    [9, '吴起镇', 55000, 36.93, 107.99],
    [10, '延安', 65000, 36.59, 109.49]
  ];
  const steps = 46000;
  const nodes = seed.map((x, i) => {
    const prev = i === 0 ? 0 : seed[i - 1][2];
    return {
      id: x[0],
      name: x[1],
      icon: '🚩',
      targetSteps: x[2],
      latitude: x[3],
      longitude: x[4],
      remain: Math.max(x[2] - steps, 0),
      status: steps >= x[2] ? 'completed' : steps >= prev ? 'current' : 'unlocked'
    };
  });
  return {
    nodes: nodes,
    chapters: [],
    currentSteps: steps,
    totalSteps: TOTAL,
    routeProgress: steps / TOTAL,
    litCount: nodes.filter((n) => n.status === 'completed').length,
    totalCount: nodes.length,
    currentChapterId: null,
    finished: false
  };
})();

const results = [];
function record(id, name, pass, detail) {
  results.push({ id, name, pass: !!pass, detail: String(detail) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + ' | ' + detail);
}

/** 一次 cli auto 武装只够一条连接：连接失败时重新武装后自愈重试 */
async function connect() {
  try {
    return await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  } catch (e) {
    console.log('  重新武装自动化端口…');
    spawnSync(CLI, ['auto', '--project', 'D:/project/longmarch-run', '--auto-port', '9420'], { stdio: 'ignore' });
    await sleep(30000);
    return automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  }
}

/** 进 march → 切星空模式 → 等渲染内核与画布就绪（不注入数据时用于读真实路线） */
async function enterCanvas(mini) {
  await mini.reLaunch('/pages/launch/launch');
  await sleep(800);
  await mini.evaluate(() => {
    getApp().globalData.loggedIn = true;
  });
  let page = null;
  for (let i = 0; i < 3; i++) {
    await mini.switchTab('/pages/march/march');
    await sleep(1500);
    page = await mini.currentPage();
    if (page.path === 'pages/march/march') break;
    if (i === 2) throw new Error('未进入 march 页: ' + page.path);
  }
  await page.callMethod('skipIntro').catch(() => {});
  if ((await page.data('mode')) !== 'canvas') {
    await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } });
  }
  const t0 = Date.now();
  for (;;) {
    const ready = await mini.evaluate(() => {
      const p = getCurrentPages().pop();
      return !!(p.hud && p.canvas);
    }).catch(() => false);
    if (ready) break;
    if (Date.now() - t0 > 20000) throw new Error('等待星空画布内核超时');
    await sleep(400);
  }
  return page;
}

/** 注入报障路线并等入场描画/增量推进播完 */
async function inject(mini, page) {
  await mini.evaluate((route) => getCurrentPages().pop().renderRoute(route), FAKE_ROUTE);
  await sleep(2600);
  return page;
}

(async () => {
  const mini = await connect();
  const page = await enterCanvas(mini);

  /* ---- SP-01 真实路线（后端可达且已登录时）：红线终点不落在最远已点亮节点之前 ---- */
  try {
    const live = await mini.evaluate(() => {
      const h = getCurrentPages().pop().hud;
      if (!h || !h.route || !(h.route.nodes || []).length) return null;
      const nodes = h.route.nodes;
      let lit = -1;
      nodes.forEach((n, i) => {
        if (n.status === 'completed') lit = i;
      });
      if (lit < 0) return null;
      return {
        steps: h.route.currentSteps,
        litName: nodes[lit].name,
        endIdx: h.endIdxOf(h.framePathRatio(null)),
        litIdx: h.nodePathIdx[lit]
      };
    });
    record(
      'SP-01',
      '真实路线：红线终点已过最远已点亮节点',
      !!live && live.endIdx >= live.litIdx,
      live ? live.steps + '步 / ' + live.litName + '：endIdx=' + live.endIdx + ' ≥ ' + live.litIdx : '跳过（未取到后端路线数据）'
    );
  } catch (e) {
    record('SP-01', '真实路线断言', false, e.message);
  }

  /* ---- SP-02~05 注入报障态（46000 步 / 过草地已点亮）---- */
  try {
    await inject(mini, page);
    const s = await mini.evaluate(() => {
      const h = getCurrentPages().pop().hud;
      const last = h.path.length - 1;
      const grass = h.nodePathIdx[7]; // 过草地
      const wuqi = h.nodePathIdx[8]; // 吴起镇
      // 逐节点阈值即到达（临时清零点亮下限，只验步数口径换算本身）
      const savedFloor = h.litFloor;
      h.litFloor = 0;
      let strictOk = true;
      h.progressMarks.forEach((m, i) => {
        if (i === 0) return;
        if (h.endIdxOf(h.pathRatio(m)) !== h.nodePathIdx[i]) strictOk = false;
      });
      // 全程单调不减 + 值域
      let prev = -1;
      let monoOk = true;
      for (let st = 0; st <= 65000; st += 130) {
        const r = h.pathRatio(st / 65000);
        if (!(r >= 0 && r <= 1) || r < prev - 1e-9) monoOk = false;
        prev = r;
      }
      h.litFloor = savedFloor;
      const endIdx = h.endIdxOf(h.framePathRatio(null));
      return {
        pathLen: h.path.length,
        lastNodeIdx: h.nodePathIdx[9],
        steps: h.route.currentSteps,
        litFloor: Math.round(h.litFloor * 10000) / 10000,
        endIdx: endIdx,
        grassIdx: grass,
        wuqiIdx: wuqi,
        legacyIdx: Math.max(1, Math.floor(h.currentRatio() * last)),
        tipPastGrass: h.path[endIdx].y < h.nodePts[7].y,
        strictOk: strictOk,
        monoOk: monoOk
      };
    });
    record(
      'SP-02',
      '采样下标末节点不越界',
      s.lastNodeIdx === s.pathLen - 1,
      'path.len=' + s.pathLen + ' nodePathIdx[9]=' + s.lastNodeIdx
    );
    record(
      'SP-03',
      '46000 步：红线终点已过「过草地」、未到吴起镇',
      s.endIdx >= s.grassIdx && s.endIdx < s.wuqiIdx,
      'endIdx=' + s.endIdx + ' 过草地=' + s.grassIdx + ' 吴起镇=' + s.wuqiIdx + ' 旗位y更靠北=' + s.tipPastGrass
    );
    record('SP-04', '旧口径确实在过草地之前（缺陷复现证据）', s.legacyIdx < s.grassIdx, '旧 endIdx=' + s.legacyIdx + ' < 过草地=' + s.grassIdx);
    record('SP-05', '逐节点阈值即到达 + 全程单调', s.strictOk && s.monoOk, 'strictOk=' + s.strictOk + ' monoOk=' + s.monoOk + ' litFloor=' + s.litFloor);
  } catch (e) {
    record('SP-02', '星空内核注入断言', false, e.message);
  }

  /* ---- SP-06 实景模式同口径：金色已完成折线末点已过草地 ---- */
  try {
    await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'real' } } });
    await sleep(800);
    await mini.evaluate((route) => getCurrentPages().pop().renderRoute(route), FAKE_ROUTE);
    const d = await page.data();
    const pts = ((d.polylines || [])[1] || {}).points || [];
    const last = pts[pts.length - 1] || {};
    record(
      'SP-06',
      '实景已完成折线：末点过草地且指向吴起镇方向',
      pts.length === 9 && last.latitude > 33.58,
      'points=' + pts.length + ' 末点lat=' + (last.latitude || 0).toFixed(3) + '（过草地 33.58，吴起镇 36.93）'
    );
  } catch (e) {
    record('SP-06', '实景折线同口径', false, e.message);
  }

  /* ---- 视觉取证：星空模式截图（放最后，截图后桥会退化，需重新武装才能再连） ---- */
  try {
    const page2 = await enterCanvas(mini);
    await inject(mini, page2);
    await mini.screenshot({ path: path.join(IMG, 'starmap-progress-46000.png') });
    console.log('OK starmap-progress-46000.png（46000 步：红线已过草地）');
  } catch (e) {
    console.log('星空截图阶段异常（不影响断言）: ' + e.message);
  }

  /* 实景 <map> 为原生组件，automator 截图取不到其图层，故实景侧只做 SP-06 的数据断言 */

  try {
    mini.disconnect();
  } catch (e) {
    /* 截图后自动化桥常已退化，断开失败忽略 */
  }
  const failed = results.filter((r) => !r.pass);
  console.log('\n== 共 ' + results.length + ' 用例，失败 ' + failed.length + ' ==');
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FATAL: ' + (e && e.message));
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  process.exit(2);
});
