/**
 * tabBar 图标 + 星空地图闪烁 验收（断言专用，不截图 —— 截图由 tabbar-starmap-shots.cjs 分离补拍）
 *
 * 覆盖：
 *   TS-01 tabBar 配置：5 项名称/顺序/路径不变，普通/选中图标齐备且为 81×81 PNG
 *   TS-02 5 个 tab 依次 switchTab 均落到正确页面
 *   TS-03 星空分层：远景 110 颗已烘焙、中近景 64 颗参数各异（周期/亮度/色彩/呼吸曲线）、避让节点
 *   TS-04 单帧绘制耗时（120 帧均值）
 *   TS-05 切走 tab 时动画暂停、切回恢复且帧在推进
 *   TS-06 实景↔星空往返：画布释放与重建
 *   TS-07 星空模式点击节点仍可进入详情
 *   TS-08 全程无新增运行时异常
 *
 * 断言对象：星空绘制状态与方法全部在渲染内核 page.hud（utils/hudMap）上。
 *
 *   cd frontend/test/automator && node tabbar-starmap.cjs
 * 前置：开发者工具自动化端口 9420 可用、模拟器已有有效登录态。
 */
const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const FRONTEND = path.join(__dirname, '..', '..');
const RESULTS_FILE = path.join(__dirname, 'results-tabbar-starmap.json');
const TABS = [
  ['pages/home/home', '首页', 'home'],
  ['pages/march/march', '长征', 'march'],
  ['pages/ai-chat/ai-chat', 'AI 问答', 'ai'],
  ['pages/rank/rank', '排行', 'rank'],
  ['pages/mine/mine', '我的', 'mine']
];

const results = [];
const errors = [];
let mini = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(id, name, pass, detail) {
  results.push({ id, name, pass: !!pass, detail: String(detail == null ? '' : detail).slice(0, 500) });
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

/** 读 PNG 头：返回 { w, h } */
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
}

const marchState = () => mini.evaluate(() => {
  const p = getApp().__tsMarch;
  return { running: !!p.running, hasHud: !!p.hud, animId: p.animId === undefined ? null : String(p.animId), mode: p.data.mode };
});

async function openStarry() {
  await mini.switchTab('/pages/march/march');
  const page = await waitPath('pages/march/march');
  await page.callMethod('skipIntro').catch(() => {});
  await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } });
  await waitFor(() => mini.evaluate(() => {
    const p = getCurrentPages().pop();
    const h = p && p.hud;
    if (!(h && p.routeData && h.nodePts && h.nodePts.length && h.stars)) return false;
    getApp().__tsMarch = p;
    return true;
  }), 20000, 'canvas ready');
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

  /* TS-01 tabBar 配置与图标文件 */
  try {
    const list = await mini.evaluate(() => __wxConfig.tabBar.list.map((i) => ({
      pagePath: i.pagePath, text: i.text, iconPath: i.iconPath, selectedIconPath: i.selectedIconPath
    })));
    const problems = [];
    list.forEach((item, i) => {
      const [p, text, key] = TABS[i] || [];
      if (item.pagePath.replace(/\.html$/, '') !== p || item.text !== text) problems.push('顺序/名称变化@' + i);
      [['iconPath', key + '.png'], ['selectedIconPath', key + '-active.png']].forEach(([k, name]) => {
        if (item[k] !== 'images/tabbar/' + name) problems.push(k + '@' + text + '=' + item[k]);
        const s = pngSize(path.join(FRONTEND, 'images', 'tabbar', name));
        if (!s || s.w !== 81 || s.h !== 81 || s.bytes > 40 * 1024) problems.push(name + ' 尺寸/体积不符 ' + JSON.stringify(s));
      });
    });
    record('TS-01', 'tabBar 名称/顺序/路径不变，10 个图标为 81×81 PNG', list.length === 5 && !problems.length,
      problems.length ? problems.join('; ') : list.map((i) => i.text).join('/'));
  } catch (e) { record('TS-01', 'tabBar 配置', false, e.message); }

  /* TS-02 依次切换 5 个 tab */
  try {
    const landed = [];
    for (const [p] of TABS) {
      await mini.switchTab('/' + p);
      await waitPath(p);
      landed.push(p.split('/')[1]);
    }
    record('TS-02', '5 个 tab 均可切换并落到对应页面', landed.length === 5, landed.join(' → '));
  } catch (e) { record('TS-02', 'tab 切换', false, e.message); }

  /* TS-03 星空分层与参数多样性 */
  let page = null;
  try {
    page = await openStarry();
    const s = await mini.evaluate(() => {
      const h = getApp().__tsMarch.hud;
      const near = (q) => h.nodePts.some((n) => Math.abs(n.x - q.x) < 16 && Math.abs(n.y - q.y) < 16);
      const uniq = (arr) => Object.keys(arr.reduce((m, v) => { m[v] = 1; return m; }, {})).length;
      return {
        far: (h.farStars || []).length,
        mid: h.stars.length,
        baked: !!h.staticLayer,
        freqs: uniq(h.stars.map((x) => x.freq.toFixed(3))),
        colors: uniq(h.stars.map((x) => x.color)),
        slow: h.stars.filter((x) => x.slow).length,
        glint: h.stars.filter((x) => x.glint).length,
        loRange: [Math.min.apply(null, h.stars.map((x) => x.lo)), Math.max.apply(null, h.stars.map((x) => x.lo))],
        nearNode: h.stars.filter(near).length + h.farStars.filter(near).length,
        inSky: h.stars.every((x) => x.x >= 0 && x.x <= h.cw && x.y >= 0 && x.y <= h.ch * 0.72)
      };
    });
    const ok = s.far === 110 && s.mid === 64 && s.baked && s.freqs >= 60 && s.colors >= 2
      && s.slow > 0 && s.slow < 64 && s.glint === 9 && s.loRange[1] - s.loRange[0] > 0.2 && s.inSky && s.nearNode <= 3;
    record('TS-03', '星空三层：远景烘焙 + 中近景参数各异 + 避让节点', ok, JSON.stringify(s));
  } catch (e) { record('TS-03', '星空分层', false, e.message); }

  /* TS-04 单帧绘制耗时 */
  try {
    const perf = await mini.evaluate(() => {
      const h = getApp().__tsMarch.hud;
      const N = 120;
      const t0 = Date.now();
      for (let i = 0; i < N; i++) h.draw(t0 / 1000 + i / 60);
      const tStars = Date.now();
      for (let i = 0; i < N; i++) h.drawStars(t0 / 1000 + i / 60);
      return { frameMs: (tStars - t0) / N, starsMs: (Date.now() - tStars) / N };
    });
    record('TS-04', '整帧/星空绘制耗时（模拟器，120 帧均值）', perf.frameMs < 16,
      'frame=' + perf.frameMs.toFixed(2) + 'ms stars=' + perf.starsMs.toFixed(2) + 'ms');
  } catch (e) { record('TS-04', '绘制耗时', false, e.message); }

  /* TS-05 切走暂停 / 切回恢复 */
  try {
    const before = await marchState();
    await mini.switchTab('/pages/home/home');
    await waitPath('pages/home/home');
    await sleep(500);
    const hidden = await marchState();
    await mini.switchTab('/pages/march/march');
    await waitPath('pages/march/march');
    await sleep(300);
    const back1 = await marchState();
    await sleep(400);
    const back2 = await marchState();
    const ok = before.running && !hidden.running && hidden.animId === null
      && back1.running && back1.hasHud && back2.running && back1.animId !== back2.animId;
    record('TS-05', '切走 tab 动画暂停、切回恢复且帧推进', ok,
      'before=' + JSON.stringify(before) + ' hidden=' + JSON.stringify(hidden) + ' back=' + back1.animId + '→' + back2.animId);
  } catch (e) { record('TS-05', '暂停/恢复', false, e.message); }

  /* TS-06 实景 ↔ 星空 往返 */
  try {
    page = await waitPath('pages/march/march');
    await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'real' } } });
    await sleep(600);
    const real = await marchState();
    page = await openStarry();
    const again = await marchState();
    const ok = real.mode === 'real' && !real.running && !real.hasHud && again.mode === 'canvas' && again.running && again.hasHud;
    record('TS-06', '实景↔星空往返：画布释放与重建', ok, 'real=' + JSON.stringify(real) + ' canvas=' + JSON.stringify(again));
  } catch (e) { record('TS-06', '模式往返', false, e.message); }

  /* TS-07 星空模式点击节点进详情 */
  try {
    const np = await mini.evaluate(() => { const q = getApp().__tsMarch.hud.nodePts[0]; return { x: q.x, y: q.y }; });
    await page.callMethod('onMapTouchStart', { touches: [{ x: np.x, y: np.y }] });
    await page.callMethod('onMapTouchEnd', { touches: [], changedTouches: [{ x: np.x, y: np.y }] });
    await waitPath('pages/node-detail/node-detail', 8000);
    record('TS-07', '星空模式点击节点进入详情', true, 'node0=(' + np.x.toFixed(0) + ',' + np.y.toFixed(0) + ')');
    await mini.navigateBack();
    await waitPath('pages/march/march');
  } catch (e) { record('TS-07', '节点点击', false, e.message); }

  await sleep(1000);
  record('TS-08', '全程无新增运行时异常', errors.length === 0, errors.slice(0, 5).join(' | '));

  await mini.evaluate(() => { delete getApp().__tsMarch; return true; }).catch(() => {});
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log('\n' + results.filter((r) => r.pass).length + '/' + results.length + ' PASS');
  mini.disconnect();
  process.exit(0);
})().catch((e) => {
  console.log('FATAL', e.message);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  process.exit(1);
});
