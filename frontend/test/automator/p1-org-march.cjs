/**
 * P1-3 组织共同长征目标（小程序侧）验收（断言先行，截图放末尾）
 *
 * 覆盖（需求 §10）：
 *   P1H-01 卡片渲染：进度/累计/当前到达/节点条齐备（10 节点）
 *   P1H-02 节点条自洽：已完成 ✓、当前节点百分比、未完成 0%
 *   P1H-03 增量：API 补 2000 步后重进首页，组织累计精确 +2000
 * 末尾截图：25-home-org-march.png
 *
 *   node p1-org-march.cjs
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
const NICKNAME = 'P1集体';
const AVATAR = 'https://example.com/auto-avatar.png';
const RESULTS_FILE = path.join(__dirname, 'results-p1h.json');
const SHOT_FILE = path.join(__dirname, '..', 'images', '25-home-org-march.png');

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
  const code = 'automator-p1h-' + Date.now();
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
  await cmd(() => org.setData({ nickname: NICKNAME }), 'setData org nickname', 2);
  await cmd(() => org.callMethod('confirmSelect', 11), 'confirmSelect 11', 2);
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
    return d && d.routeLoading === false && (d.omNodes || []).length > 0 ? d : null;
  }, 20000, 500, 'home ready');
  return home;
}

function parseSteps(text) {
  return parseInt(String(text).replace(/,/g, ''), 10);
}

(async () => {
  mini = await connectMini();
  const code = await freshLogin();
  await apiAddSteps(code, 3000);
  const home = await reloadHome();
  const d = home.data ? await cmd(() => home.data(), 'read data') : null;

  /* P1H-01 卡片渲染 */
  record('P1H-01', '集体长征卡：进度/累计/当前到达/节点条齐备',
    d.omProgress >= 0 && d.omProgress <= 100
      && /^[\d,]+$/.test(d.omTotalText)
      && (d.omFinished || d.omCurrent.length > 0)
      && d.omNodes.length === 10,
    'pct=' + d.omProgress + ' total=' + d.omTotalText + ' current=' + d.omCurrent + ' nodes=' + d.omNodes.length);

  /* P1H-02 节点条自洽 */
  const labels = d.omNodes.map((n) => n.pctLabel);
  const firstIncomplete = d.omNodes.findIndex((n) => n.status !== 'completed');
  const okLabels = d.omNodes.every((n, i) => {
    if (n.status === 'completed') return n.pctLabel === '✓';
    if (n.status === 'current') return /^\d{1,3}%$/.test(n.pctLabel);
    return n.pctLabel === '0%' && i > firstIncomplete;
  });
  record('P1H-02', '节点条：✓/百分比/0% 与状态一致',
    okLabels && labels[0] === '✓',
    'labels=' + labels.join(','));

  /* P1H-03 增量：补 2000 步 → 组织累计 +2000 */
  try {
    const beforeTotal = parseSteps(d.omTotalText);
    await apiAddSteps(code, 2000);
    const home2 = await reloadHome();
    const d2 = await cmd(() => home2.data(), 'read data 2');
    const afterTotal = parseSteps(d2.omTotalText);
    record('P1H-03', '增量：补 2000 步后组织累计精确 +2000',
      afterTotal - beforeTotal === 2000,
      'before=' + beforeTotal + ' after=' + afterTotal);
  } catch (e) { record('P1H-03', '组织累计增量', false, e.message); }

  /* 截图：滚动到底部集体长征卡 */
  try {
    await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.pageScrollTo({ scrollTop: 99999, duration: 0, complete: () => resolve(true) });
    })), 'scroll bottom', 1);
    await sleep(800);
    await withTimeout(mini.screenshot({ path: SHOT_FILE }), 25000, 'screenshot org-march');
    console.log('SHOT 25-home-org-march.png');
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
