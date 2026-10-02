/**
 * P0-2 今日行军状态卡片 验收（断言 + 末尾单张截图）
 *
 * 覆盖（需求 §6.2/6.3/6.4，文案必须基于真实数据分档）：
 *   P0H-01 0 步：「今天还没有开始行军」+ 连续行军未开始（dim）
 *   P0H-02 +3000（累计3000，<5000）：「正在向下一站前进」
 *   P0H-03 +3000（累计6000，≥5000）：「今日行军目标已完成」+ 🔥连续行军 1 天
 *   P0H-04 +5000（累计11000，≥10000）：「今日完成一次长距离行军」
 * 末尾截图：frontend/test/images/19-home-today-p0.png（长距离行军状态）
 *
 *   node p0-home.cjs
 *
 * 前置：后端 8010 运行；开发者工具自动化端口 9420 可用。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const NICKNAME = 'P0状态卡';
const AVATAR = 'https://example.com/auto-avatar.png';
const RESULTS_FILE = path.join(__dirname, 'results-p0h.json');
const SHOT_FILE = path.join(__dirname, '..', 'images', '19-home-today-p0.png');

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

function api(path_, token, method, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const req = http.request({
      host: '127.0.0.1', port: 8010, path: '/api' + path_, method: method || 'GET',
      headers: Object.assign(
        token ? { Authorization: 'Bearer ' + token } : {},
        body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}
      )
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); }
        catch (e) { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function connectMini() {
  for (let i = 0; i < 3; i++) {
    try { return await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect'); } catch (e) {
      console.log('connect 失败(' + (i + 1) + '/3): ' + e.message);
      await sleep(6000);
    }
  }
  throw new Error('无法连接自动化桥');
}

/** 全新账号登录（独立 login code，确保今日 0 步起步） */
async function freshLogin() {
  const code = 'automator-p0h-' + Date.now();
  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) { /* ignore */ }
    return true;
  }), 'resetAuth', 2);
  await cmd(() => mini.reLaunch('/pages/login/login'), 'reLaunch login', 2);
  const login = await waitPath('pages/login/login');
  for (let i = 0; i < 5; i++) {
    await cmd(() => mini.mockWxMethod('login', { code }), 'mock login', 1).catch(() => {});
    const got = await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.login({ success: (r) => resolve(r && r.code ? r.code : 'NO_CODE'), fail: () => resolve('FAIL_BRANCH') });
    })), 'verify login mock', 1).catch(() => 'EVAL_ERR');
    if (got === code) break;
    if (i === 4) throw new Error('wx.login mock 反复未生效');
    await sleep(2000);
  }
  await cmd(() => login.setData({ nickname: NICKNAME }), 'setData nickname', 2);
  await cmd(() => login.callMethod('doLogin', AVATAR), 'doLogin', 2);
  const org = await waitPath('pages/org-select/org-select');
  await cmd(() => org.callMethod('confirmSelect', 12), 'confirmSelect 12', 2);
  await waitPath('pages/home/home');
  await sleep(1200);
  return code;
}

async function apiAddSteps(code, delta) {
  const login = await api('/auth/login', null, 'POST', { code, nickname: NICKNAME });
  const token = login.body && login.body.token;
  if (!token) throw new Error('API 登录失败');
  const r = await api('/sport/add', token, 'POST', { delta });
  if (r.status !== 200) throw new Error('API 补步数失败: ' + r.status);
  return r.body;
}

async function reloadHome() {
  await cmd(() => mini.reLaunch('/pages/home/home'), 'reLaunch home', 2);
  const home = await waitPath('pages/home/home');
  await waitFor(async () => {
    const d = await cmd(() => home.data(), 'home data');
    return d && d.routeLoading === false ? d : null;
  }, 20000, 500, 'home.routeLoading=false');
  return home;
}

async function homeDataAt(home, steps) {
  // 步数滚动动画 900ms：等 todaySteps 收敛到目标值
  return waitFor(async () => {
    const d = await cmd(() => home.data(), 'home data poll');
    return d && d.todaySteps === steps ? d : null;
  }, 15000, 400, 'todaySteps=' + steps);
}

(async () => {
  mini = await connectMini();
  const code = await freshLogin();

  /* P0H-01 0 步：未开始 */
  try {
    const home = await reloadHome();
    const d = await homeDataAt(home, 0);
    record('P0H-01', '0步：未开始行军 + 连续未开始',
      d.marchStatus === '今天还没有开始行军' && d.currentStreak === 0,
      'status=' + d.marchStatus + ' streak=' + d.currentStreak);
  } catch (e) { record('P0H-01', '0步未开始', false, e.message); }

  /* P0H-02 3000 步：运动中 */
  try {
    await apiAddSteps(code, 3000);
    const home = await reloadHome();
    const d = await homeDataAt(home, 3000);
    record('P0H-02', '3000步：正在向下一站前进',
      d.marchStatus === '正在向下一站前进',
      'status=' + d.marchStatus + ' percent=' + d.stepPercent);
  } catch (e) { record('P0H-02', '3000步运动中', false, e.message); }

  /* P0H-03 6000 步：目标完成 + 连续1天 */
  try {
    await apiAddSteps(code, 3000);
    const home = await reloadHome();
    const d = await homeDataAt(home, 6000);
    record('P0H-03', '6000步：今日行军目标已完成 + 🔥连续1天',
      d.marchStatus === '今日行军目标已完成' && d.currentStreak === 1,
      'status=' + d.marchStatus + ' streak=' + d.currentStreak);
  } catch (e) { record('P0H-03', '6000步目标完成', false, e.message); }

  /* P0H-04 11000 步：长距离行军 */
  try {
    await apiAddSteps(code, 5000);
    const home = await reloadHome();
    const d = await homeDataAt(home, 11000);
    record('P0H-04', '11000步：今日完成一次长距离行军',
      d.marchStatus === '今日完成一次长距离行军',
      'status=' + d.marchStatus + ' percent=' + d.stepPercent);
    // 截图（最后一步，截图后桥退化不影响断言）
    await sleep(800);
    await withTimeout(mini.screenshot({ path: SHOT_FILE }), 25000, 'screenshot home');
    console.log('SHOT 19-home-today-p0.png');
  } catch (e) { record('P0H-04', '11000步长距离', false, e.message); }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log('\n== 共 ' + results.length + ' 用例，失败 ' + failed.length + ' ==');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FATAL: ' + (e && e.message));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  process.exit(2);
});
