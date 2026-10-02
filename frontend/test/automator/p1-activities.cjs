/**
 * P1-1 实时行军动态（小程序侧）验收（断言先行，截图放末尾）
 *
 * 覆盖（需求 §8）：
 *   P1F-01 REST 快照：触发本人事件后重进首页，动态流含本人昵称与文案
 *   P1F-02 WS 实时：停留在首页不刷新，API 触发事件后动态流自动置顶新条目
 *   P1F-03 视图模型完整：图标/昵称/相对时间齐备
 * 末尾截图：23-home-activities.png
 *
 *   node p1-activities.cjs
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
const NICKNAME = 'P1动态';
const AVATAR = 'https://example.com/auto-avatar.png';
const RESULTS_FILE = path.join(__dirname, 'results-p1f.json');
const SHOT_FILE = path.join(__dirname, '..', 'images', '23-home-activities.png');

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

async function freshLogin() {
  const code = 'automator-p1f-' + Date.now();
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
  await cmd(() => login.callMethod('doLogin', AVATAR), 'doLogin', 2);
  const org = await waitPath('pages/org-select/org-select');
  // 登录页不采集昵称（后端默认「长征小战士」），首次引导在组织选择页设置
  await cmd(() => org.setData({ nickname: NICKNAME }), 'setData org nickname', 2);
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
  }, 20000, 500, 'home ready');
  return home;
}

(async () => {
  mini = await connectMini();
  const code = await freshLogin();

  /* P1F-01 REST 快照：本人事件入流 */
  try {
    await apiAddSteps(code, 3000);
    const home = await reloadHome();
    const d = await waitFor(async () => {
      const dd = await cmd(() => home.data(), 'home activities poll', 1);
      return dd && (dd.activities || []).some((x) => x.nickname === NICKNAME) ? dd : null;
    }, 15000, 500, '本人动态入流');
    const mine = d.activities.find((x) => x.nickname === NICKNAME && x.text.indexOf('首次完成运动同步') >= 0);
    record('P1F-01', 'REST快照：动态流含本人昵称与事件文案',
      !!mine,
      'mine=' + (mine ? mine.icon + ' ' + mine.text : 'null'));
  } catch (e) { record('P1F-01', 'REST快照动态流', false, e.message); }

  /* P1F-02 WS 实时：不刷新页面自动置顶 */
  try {
    await sleep(2000); // 等 WS 连接就绪
    await apiAddSteps(code, 3000); // 累计6000 → DAILY_GOAL 事件
    const home = await waitPath('pages/home/home');
    const top = await waitFor(async () => {
      const d = await cmd(() => home.data(), 'ws feed poll', 1);
      const t = d && d.activities && d.activities[0];
      return t && t.nickname === NICKNAME && t.text.indexOf('完成当日行军目标') >= 0 ? t : null;
    }, 15000, 400, 'WS实时置顶');
    record('P1F-02', 'WS实时：动态流自动置顶新事件', true,
      'top=' + top.icon + ' ' + top.nickname + ' ' + top.text + ' (' + top.timeText + ')');

    /* P1F-03 视图模型完整 */
    record('P1F-03', '视图模型：图标/昵称/相对时间齐备',
      !!top.icon && !!top.nickname && top.timeText === '刚刚',
      'icon=' + top.icon + ' time=' + top.timeText);
  } catch (e) { record('P1F-02', 'WS实时动态', false, e.message); }

  /* 截图 */
  try {
    await sleep(500);
    await withTimeout(mini.screenshot({ path: SHOT_FILE }), 25000, 'screenshot activities');
    console.log('SHOT 23-home-activities.png');
  } catch (e) { console.log('截图失败（不影响断言）: ' + e.message); }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log('\n== 共 ' + results.length + ' 用例，失败 ' + failed.length + ' ==');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FATAL: ' + (e && e.message));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  process.exit(2);
});
