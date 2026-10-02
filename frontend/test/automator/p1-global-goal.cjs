/**
 * P1-4 全员共同长征目标（小程序侧）验收（断言先行，截图放末尾）
 *
 * 覆盖（需求 §11）：
 *   P1I-01 卡片渲染：全员累计/进度/下一阶段/里程碑条齐备（4 个里程碑）
 *   P1I-02 里程碑自洽：名称序列、✓/○ 与 reached 一致、下一阶段为首个未达成项
 *   P1I-03 增量：API 补 20000 步后重进首页，全员累计精确 +20000（中文大数解析）
 * 末尾截图：26-home-global-goal.png
 *
 *   node p1-global-goal.cjs
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
const NICKNAME = 'P1全员';
const AVATAR = 'https://example.com/auto-avatar.png';
const RESULTS_FILE = path.join(__dirname, 'results-p1i.json');
const SHOT_FILE = path.join(__dirname, '..', 'images', '26-home-global-goal.png');
const MS_NAMES = ['5000万', '1亿', '1.5亿', '2亿'];

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
  const code = 'automator-p1i-' + Date.now();
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
    return d && d.routeLoading === false && (d.ggMilestones || []).length > 0 ? d : null;
  }, 20000, 500, 'home ready');
  return home;
}

/* 中文大数解析：1.63亿 / 100.1万 / 25,000 -> 数值。
   增量断言安全性：formatCn 千位取整，delta 为 1000 整数倍时解析差恒等于真实增量。 */
function parseCn(text) {
  const s = String(text || '').replace(/,/g, '');
  if (s.endsWith('亿')) return Math.round(parseFloat(s) * 100000000);
  if (s.endsWith('万')) return Math.round(parseFloat(s) * 10000);
  return parseInt(s, 10);
}

(async () => {
  mini = await connectMini();
  const code = await freshLogin();
  const home = await reloadHome();
  const d = await cmd(() => home.data(), 'read data');

  /* P1I-01 卡片渲染 */
  record('P1I-01', '全员同行卡：累计/进度/下一阶段/里程碑条齐备',
    /^[\d,.]+(万|亿)?$/.test(d.ggTotalText)
      && d.ggProgress >= 0 && d.ggProgress <= 100
      && d.ggMilestones.length === 4
      && (d.ggAllDone || (d.ggNextName.length > 0 && d.ggRemainText.length > 0)),
    'total=' + d.ggTotalText + ' pct=' + d.ggProgress + ' next=' + d.ggNextName + ' remain=' + d.ggRemainText);

  /* P1I-02 里程碑自洽 */
  const names = d.ggMilestones.map((m) => m.name);
  const okNames = names.join(',') === MS_NAMES.join(',');
  const okMarks = d.ggMilestones.every((m) => m.mark === (m.reached ? '✓' : '○'));
  const firstUnreached = d.ggMilestones.find((m) => !m.reached);
  const okNext = d.ggAllDone
    ? d.ggMilestones.every((m) => m.reached)
    : (firstUnreached && d.ggNextName === firstUnreached.name);
  const okOrder = d.ggMilestones.every((m, i) => !m.reached || d.ggMilestones.slice(0, i).every((x) => x.reached));
  record('P1I-02', '里程碑：名称序列/✓○标记/下一阶段 自洽',
    okNames && okMarks && okNext && okOrder,
    'marks=' + d.ggMilestones.map((m) => m.name + m.mark).join(' '));

  /* P1I-03 增量：补 20000 步 → 全员累计 +20000 */
  try {
    const beforeTotal = parseCn(d.ggTotalText);
    await apiAddSteps(code, 20000);
    const home2 = await reloadHome();
    const d2 = await cmd(() => home2.data(), 'read data 2');
    const afterTotal = parseCn(d2.ggTotalText);
    record('P1I-03', '增量：补 20000 步后全员累计精确 +20000',
      afterTotal - beforeTotal === 20000,
      'before=' + d.ggTotalText + '(' + beforeTotal + ') after=' + d2.ggTotalText + '(' + afterTotal + ')');
  } catch (e) { record('P1I-03', '全员累计增量', false, e.message); }

  /* 截图：滚动到底部全员同行卡 */
  try {
    await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.pageScrollTo({ scrollTop: 99999, duration: 0, complete: () => resolve(true) });
    })), 'scroll bottom', 1);
    await sleep(800);
    await withTimeout(mini.screenshot({ path: SHOT_FILE }), 25000, 'screenshot global-goal');
    console.log('SHOT 26-home-global-goal.png');
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
