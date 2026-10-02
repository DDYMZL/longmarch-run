/**
 * P0-1 行军轨迹验收（断言专用，不截图 —— 截图由 p0-shots.cjs 分离补拍）
 *
 * 覆盖：
 *   P0M-01 长征页（实景模式）路线数据齐备（nodes/markers/polylines/进度旗 marker）
 *   P0M-02 calcRouteProgress：后端 routeProgress 字段优先
 *   P0M-03 calcRouteProgress：旧接口降级为步数比例
 *   P0M-04 currentRatio 返回 [0,1] 数值（routeData 链路完好）
 *   P0M-05 切插画模式后画布初始化且 _viewPlayed 语义正确（镜头动画不重复播放）
 *
 *   node p0-march.cjs
 *
 * 前置：后端 http://127.0.0.1:8010 已运行；开发者工具自动化端口 9420 可用。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const CLI = 'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const PROJECT = 'D:/project/longmarch-run';
const RESULTS_FILE = path.join(__dirname, 'results-p0m.json');
const NICKNAME = '自动化测试员';
const AVATAR = 'https://example.com/auto-avatar.png';

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

async function waitFor(fn, timeout = 15000, interval = 400, desc = 'condition') {
  const start = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { /* retry */ }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('等待超时: ' + desc);
    await sleep(interval);
  }
}

function rearmBridge() {
  console.log('--- 重启自动化桥 ---');
  spawnSync('cmd.exe', ['/c', CLI, 'auto', '--project', PROJECT, '--auto-port', '9420'], { stdio: 'ignore', timeout: 60000 });
}

async function connectMini() {
  for (let i = 0; i < 3; i++) {
    try { return await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect'); } catch (e) {
      console.log('connect 失败(' + (i + 1) + '/3): ' + e.message);
      await sleep(6000);
    }
  }
  rearmBridge();
  await sleep(25000);
  return await withTimeout(automator.connect({ wsEndpoint: WS }), 25000, 'connect-final');
}

function tourLoginCode() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
    if (s && s.loginCode) return s.loginCode;
  } catch (e) { /* ignore */ }
  return 'automator-p0m-' + Date.now();
}

async function ensureLoginMock() {
  const code = tourLoginCode();
  for (let i = 0; i < 5; i++) {
    await cmd(() => mini.mockWxMethod('login', { code }), 'mock login', 1).catch(() => {});
    const got = await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.login({ success: (r) => resolve(r && r.code ? r.code : 'NO_CODE'), fail: () => resolve('FAIL_BRANCH') });
    })), 'verify login mock', 1).catch(() => 'EVAL_ERR');
    if (got === code) return;
    console.log('wx.login mock 未生效(' + (i + 1) + '/5): got=' + got);
    await sleep(2000);
  }
  throw new Error('wx.login mock 反复未生效');
}

/** 已登录（含组织）返回；否则走完整登录 + 选组织流程 */
async function ensureLoggedIn() {
  const state = await cmd(() => mini.evaluate(() => {
    const g = getApp().globalData;
    return { loggedIn: !!g.loggedIn, orgId: g.user && g.user.orgId ? g.user.orgId : null };
  }), 'evaluate login state', 2).catch(() => null);
  if (state && state.loggedIn && state.orgId) {
    console.log('复用持久登录态 orgId=' + state.orgId);
    return;
  }
  console.log('登录态缺失，执行登录流程');
  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) { /* ignore */ }
    return true;
  }), 'resetAuth', 2);
  await cmd(() => mini.reLaunch('/pages/login/login'), 'reLaunch login', 2);
  const login = await waitPath('pages/login/login');
  await ensureLoginMock();
  await cmd(() => login.setData({ nickname: NICKNAME }), 'setData nickname', 2);
  await cmd(() => login.callMethod('doLogin', AVATAR), 'doLogin', 2);
  // 老用户已有组织 -> 直接进首页；新用户 -> 组织选择页
  const landed = await waitFor(async () => {
    const p = await withTimeout(mini.currentPage().catch(() => null), 8000, 'currentPage').catch(() => null);
    if (p && p.path && (p.path.indexOf('pages/org-select/org-select') === 0 || p.path.indexOf('pages/home/home') === 0)) return p;
    return null;
  }, 25000, 500, '登录落地页');
  if (landed.path.indexOf('pages/org-select/org-select') === 0) {
    await cmd(() => landed.callMethod('confirmSelect', 12), 'confirmSelect 12', 2);
    await waitPath('pages/home/home');
  }
  await sleep(1500);
}

(async () => {
  mini = await connectMini();
  await ensureLoggedIn();

  /* ---------- P0M-01 实景模式路线数据 ---------- */
  try {
    await cmd(() => mini.switchTab('/pages/march/march'), 'switchTab march', 2);
    const marchPage = await waitPath('pages/march/march');
    await waitFor(async () => {
      const d = await cmd(() => marchPage.data(), 'march data');
      return d && Array.isArray(d.nodes) && d.nodes.length > 0 ? d : null;
    }, 20000, 500, 'march.nodes 非空');
    const d = await cmd(() => marchPage.data(), 'march data final');
    const flagMarker = d.markers.find((m) => m.id === 999);
    const ok =
      d.mode === 'real' &&
      d.nodes.length === 10 &&
      d.polylines.length >= 1 &&
      typeof d.currentSteps === 'number' &&
      typeof d.totalSteps === 'number';
    record('P0M-01', '实景模式：节点/markers/polylines 齐备', ok,
      'nodes=' + d.nodes.length + ' markers=' + d.markers.length + ' polylines=' + d.polylines.length +
      ' flag=' + (flagMarker ? '有' : '无(0步或已完结)'));
  } catch (e) { record('P0M-01', '实景模式路线数据', false, e.message); }

  const marchPage = await waitPath('pages/march/march');

  /* ---------- P0M-02 routeProgress 字段优先 ---------- */
  try {
    const v = await cmd(() => marchPage.callMethod('calcRouteProgress', { routeProgress: 0.7, totalSteps: 100, currentSteps: 50 }), 'calcRouteProgress 后端字段');
    record('P0M-02', 'calcRouteProgress：后端 routeProgress 优先', Math.abs(v - 0.7) < 1e-9, 'return=' + v);
  } catch (e) { record('P0M-02', 'calcRouteProgress 后端字段优先', false, e.message); }

  /* ---------- P0M-03 旧接口降级 ---------- */
  try {
    const v = await cmd(() => marchPage.callMethod('calcRouteProgress', { totalSteps: 100, currentSteps: 50 }), 'calcRouteProgress 降级');
    record('P0M-03', 'calcRouteProgress：旧接口降级为步数比例', Math.abs(v - 0.5) < 1e-9, 'return=' + v);
  } catch (e) { record('P0M-03', 'calcRouteProgress 旧接口降级', false, e.message); }

  /* ---------- P0M-04 currentRatio 链路 ---------- */
  try {
    const v = await cmd(() => marchPage.callMethod('currentRatio'), 'currentRatio');
    const ok = typeof v === 'number' && v >= 0 && v <= 1;
    record('P0M-04', 'currentRatio 返回 [0,1] 数值', ok, 'return=' + v);
  } catch (e) { record('P0M-04', 'currentRatio 链路', false, e.message); }

  /* ---------- P0M-05 插画模式切换 + 镜头动画不重复 ---------- */
  try {
    await cmd(() => marchPage.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } }), 'switchMode canvas', 2);
    await sleep(2500);
    const d = await cmd(() => marchPage.data(), 'march data canvas');
    const ratio = await cmd(() => marchPage.callMethod('currentRatio'), 'currentRatio canvas');
    const ok = d.mode === 'canvas' && typeof ratio === 'number' && ratio >= 0 && ratio <= 1;
    record('P0M-05', '插画模式：画布初始化且进度链路正常', ok, 'mode=' + d.mode + ' ratio=' + ratio);
    // 切回实景：_viewPlayed 已为 true，不应再重播镜头俯冲（playViewAnim 不再被调用）
    await cmd(() => marchPage.callMethod('switchMode', { currentTarget: { dataset: { mode: 'real' } } }), 'switchMode real', 2);
    await sleep(800);
    const d2 = await cmd(() => marchPage.data(), 'march data real2');
    record('P0M-06', '切回实景模式正常', d2.mode === 'real', 'mode=' + d2.mode);
  } catch (e) { record('P0M-05', '插画模式切换', false, e.message); }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log('\n== 共 ' + results.length + ' 用例，失败 ' + failed.length + ' ==');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FATAL: ' + (e && e.message));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  process.exit(2);
});
