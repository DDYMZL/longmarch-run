/**
 * P1-2 同组织同行者（小程序侧）验收（断言先行，截图放末尾）
 *
 * 覆盖（需求 §9）：
 *   P1G-01 卡片组织信息：orgName/orgFullName 渲染（前端组 / 全路径含技术部）
 *   P1G-02 同行者本人行：isSelf 置顶（20000 步为全组织今日最高）+ 千分位步数
 *   P1G-03 统计区：同行人数 ≥1、今日共同前进 ≥20000
 * 末尾截图：24-home-companions.png
 *
 *   node p1-companions.cjs
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
const NICKNAME = 'P1同行';
const AVATAR = 'https://example.com/auto-avatar.png';
const STEPS = 20000; // 高于组织 12 内历史测试用户今日步数，确保本人置顶
const RESULTS_FILE = path.join(__dirname, 'results-p1g.json');
const SHOT_FILE = path.join(__dirname, '..', 'images', '24-home-companions.png');

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
  const code = 'automator-p1g-' + Date.now();
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
  await apiAddSteps(code, STEPS);
  const home = await reloadHome();

  const d = await waitFor(async () => {
    const dd = await cmd(() => home.data(), 'companions poll', 1);
    const self = dd && (dd.companions || []).find((x) => x.isSelf && x.stepsText === '20,000');
    return dd && self ? dd : null;
  }, 20000, 500, '组织同行卡数据');

  /* P1G-01 卡片组织信息 */
  record('P1G-01', '卡片组织信息：orgName/orgFullName',
    d.orgName === '前端组' && d.orgFullName.indexOf('技术部') >= 0 && d.orgFullName.indexOf('前端组') >= 0,
    'orgName=' + d.orgName + ' full=' + d.orgFullName);

  /* P1G-02 同行者本人行 */
  const top = d.companions[0];
  record('P1G-02', '同行者本人行置顶（isSelf + 千分位步数）',
    !!top && top.isSelf === true && top.nickname === NICKNAME && top.stepsText === '20,000',
    'top=' + (top ? top.nickname + ' ' + top.stepsText + ' self=' + top.isSelf : 'null'));

  /* P1G-03 统计区 */
  const total = parseInt(String(d.orgTodayStepsText).replace(/,/g, ''), 10);
  record('P1G-03', '统计区：同行人数 ≥1 且今日共同前进 ≥20000',
    d.memberCount >= 1 && total >= STEPS,
    'memberCount=' + d.memberCount + ' todayTotal=' + d.orgTodayStepsText);

  /* 截图：滚动到组织同行卡 */
  try {
    await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.pageScrollTo({ scrollTop: 99999, duration: 0, complete: () => resolve(true) });
    })), 'scroll bottom', 1);
    await sleep(800);
    await withTimeout(mini.screenshot({ path: SHOT_FILE }), 25000, 'screenshot companions');
    console.log('SHOT 24-home-companions.png');
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
