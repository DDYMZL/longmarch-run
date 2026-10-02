/**
 * P1-6 我的长征足迹地图（小程序侧）验收（断言先行，截图放末尾）
 *
 * 覆盖（需求 §7）：
 *   P1L-01 足迹链渲染：瑞金/遵义按路线顺序、点亮日期=今日、末节点 isLast
 *   P1L-02 点击节点展开详情：日期/「我在这一天抵达」/当日步数/累计步数，再点收起
 *   P1L-03 详情 DOM 与数据自洽（展开态 .fp-detail 存在且数值正确）
 * 末尾截图：28-profile-footprint.png
 *
 *   node p1-footprint-map.cjs
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
const NICKNAME = 'P1足迹';
const AVATAR = 'https://example.com/auto-avatar.png';
const RESULTS_FILE = path.join(__dirname, 'results-p1l.json');
const SHOT_FILE = path.join(__dirname, '..', 'images', '28-profile-footprint.png');

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
  const code = 'automator-p1l-' + Date.now();
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

async function apiToken(code) {
  const login = await api('/auth/login', null, 'POST', { code, nickname: NICKNAME });
  const token = login.body && login.body.token;
  if (!token) throw new Error('API 登录失败');
  return token;
}

(async () => {
  mini = await connectMini();
  const code = await freshLogin();

  // 同步 8000 步并点亮（瑞金/遵义），再进档案页
  const token = await apiToken(code);
  const add = await api('/sport/add', token, 'POST', { delta: 8000 });
  if (add.status !== 200) throw new Error('补步数失败: ' + add.status);
  const lit = await api('/march/light-up', token, 'POST');
  if (lit.status !== 200) throw new Error('点亮失败: ' + lit.status);

  await cmd(() => mini.reLaunch('/pages/profile/profile'), 'reLaunch profile', 2);
  const page = await waitPath('pages/profile/profile');
  const d = await waitFor(async () => {
    const dd = await cmd(() => page.data(), 'profile data');
    return dd && dd.loading === false && (dd.footprints || []).length > 0 ? dd : null;
  }, 20000, 500, 'profile footprints ready');

  /* P1L-01 足迹链渲染 */
  const fps = d.footprints;
  const today = new Date();
  const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  record('P1L-01', '足迹链：瑞金/遵义按路线顺序、点亮日期=今日、末节点 isLast',
    fps.length === 2
      && fps[0].name === '瑞金' && fps[1].name === '遵义'
      && fps[0].id < fps[1].id
      && fps.every((f) => f.litDate === todayStr)
      && fps[1].isLast === true && fps[0].isLast === false,
    'names=' + fps.map((f) => f.name).join(',') + ' dates=' + fps.map((f) => f.litDate).join(','));

  /* P1L-02 点击展开详情 */
  try {
    await cmd(() => page.callMethod('toggleFootprint', { currentTarget: { dataset: { id: fps[1].id } } }), 'expand zunyi', 2);
    await sleep(300);
    const d2 = await cmd(() => page.data(), 'read data 2');
    const okExpand = d2.fpSelected === fps[1].id;
    await cmd(() => page.callMethod('toggleFootprint', { currentTarget: { dataset: { id: fps[1].id } } }), 'collapse', 1);
    const d3 = await cmd(() => page.data(), 'read data 3');
    record('P1L-02', '点击节点展开/收起详情',
      okExpand && d3.fpSelected === 0,
      'fpSelected=' + d2.fpSelected + ' -> ' + d3.fpSelected);
  } catch (e) { record('P1L-02', '展开/收起', false, e.message); }

  /* P1L-03 详情 DOM 与数据自洽 */
  try {
    await cmd(() => page.callMethod('toggleFootprint', { currentTarget: { dataset: { id: fps[1].id } } }), 'expand again', 2);
    await sleep(400);
    const detailEl = await cmd(() => page.$('.fp-detail'), 'find fp-detail', 1);
    const d4 = await cmd(() => page.data(), 'read data 4');
    const zunyi = d4.footprints[1];
    record('P1L-03', '详情：当日步数 8,000 / 累计步数 8,000 / DOM 渲染',
      !!detailEl && zunyi.dayStepsText === '8,000' && zunyi.cumStepsText === '8,000',
      'daySteps=' + zunyi.dayStepsText + ' cum=' + zunyi.cumStepsText + ' dom=' + !!detailEl);
  } catch (e) { record('P1L-03', '详情自洽', false, e.message); }

  /* 截图：滚动到足迹地图卡（展开态） */
  try {
    await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.createSelectorQuery().select('.fp-chain').boundingClientRect((rect) => {
        if (rect) {
          wx.pageScrollTo({ scrollTop: Math.max(0, rect.top - 160), duration: 0, complete: () => resolve(true) });
        } else {
          wx.pageScrollTo({ scrollTop: 600, duration: 0, complete: () => resolve(true) });
        }
      }).exec();
    })), 'scroll to footprint', 1);
    await sleep(700);
    await withTimeout(mini.screenshot({ path: SHOT_FILE }), 25000, 'screenshot footprint');
    console.log('SHOT 28-profile-footprint.png');
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
