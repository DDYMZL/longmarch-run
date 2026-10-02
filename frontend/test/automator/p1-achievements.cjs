/**
 * P1-7 我的成就总览 + 数据画像（小程序侧）验收（断言先行，截图放末尾）
 *
 * 覆盖（需求 §17/§18）：
 *   P1P-01 成就总览六格渲染：行军/路线/情报/连续/勋章/积分，数值与 summary 数据自洽
 *   P1P-02 点击进入详情：行军格 → 行军日历；情报格 → 答题记录
 *   P1P-03 数据画像：五维齐全且 ∈[0,100]、雷达 canvas 存在、drawPortrait 重放不抛错
 * 末尾截图：29-profile-achievements.png
 *
 *   node p1-achievements.cjs
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
const NICKNAME = 'P1成就';
const AVATAR = 'https://example.com/auto-avatar.png';
const RESULTS_FILE = path.join(__dirname, 'results-p1p.json');
const SHOT_FILE = path.join(__dirname, '..', 'images', '29-profile-achievements.png');

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
  const code = 'automator-p1p-' + Date.now();
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

function formatNumber(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
  let page = await waitPath('pages/profile/profile');
  const d = await waitFor(async () => {
    const dd = await cmd(() => page.data(), 'profile data');
    return dd && dd.loading === false && dd.summary && (dd.achievements || []).length === 6 ? dd : null;
  }, 20000, 500, 'profile achievements ready');

  /* P1P-01 成就总览六格渲染与数据自洽 */
  const s = d.summary;
  const ach = d.achievements;
  const expected = {
    march: formatNumber(s.stats.totalSteps) + ' 步',
    route: s.stats.litCount + ' / ' + s.stats.totalCount,
    quiz: s.quiz.totalCount + ' 次',
    streak: s.stats.currentStreak + ' 天',
    medal: s.medals.ownedCount + ' / ' + s.medals.totalCount,
    points: formatNumber(s.points.total)
  };
  const keys = ach.map((a) => a.key);
  const mismatch = ach.filter((a) => a.value !== expected[a.key]).map((a) => a.key + '=' + a.value);
  record('P1P-01', '成就总览六格：行军/路线/情报/连续/勋章/积分，数值与 summary 自洽',
    keys.join(',') === 'march,route,quiz,streak,medal,points' && mismatch.length === 0,
    'mismatch=' + (mismatch.join(',') || '无') + ' march=' + expected.march + ' route=' + expected.route);

  /* P1P-02 点击进入详情：行军 → 行军日历；情报 → 答题记录 */
  try {
    await cmd(() => page.callMethod('goAchievement', { currentTarget: { dataset: { key: 'march' } } }), 'go march cell', 2);
    await waitPath('pages/calendar/calendar');
    await cmd(() => mini.navigateBack(), 'back from calendar', 2);
    page = await waitPath('pages/profile/profile');
    await cmd(() => page.callMethod('goAchievement', { currentTarget: { dataset: { key: 'quiz' } } }), 'go quiz cell', 2);
    await waitPath('pages/quiz-records/quiz-records');
    await cmd(() => mini.navigateBack(), 'back from quiz-records', 2);
    page = await waitPath('pages/profile/profile');
    record('P1P-02', '成就格点击跳转：行军 → 行军日历、情报 → 答题记录', true, 'calendar + quiz-records 均可达');
  } catch (e) { record('P1P-02', '成就格点击跳转', false, e.message); }

  /* P1P-03 数据画像：五维值域、canvas 存在、绘制重放不抛错 */
  try {
    const p = (d.summary.portrait) || {};
    const dims = ['march', 'persistence', 'knowledge', 'route', 'achievement'];
    const inRange = dims.every((k) => typeof p[k] === 'number' && p[k] >= 0 && p[k] <= 100);
    const canvasEl = await cmd(() => page.$('#portraitCanvas'), 'find portraitCanvas', 1);
    await cmd(() => page.callMethod('drawPortrait'), 'replay drawPortrait', 2);
    await sleep(500);
    record('P1P-03', '数据画像：五维齐全 ∈[0,100]、雷达 canvas 存在、重绘不抛错',
      inRange && !!canvasEl && d.summary.stats.litCount > 0 && p.route > 0 && p.march > 0,
      'portrait=' + JSON.stringify(p) + ' canvas=' + !!canvasEl);
  } catch (e) { record('P1P-03', '数据画像', false, e.message); }

  /* 截图：滚动到成就总览/数据画像卡 */
  try {
    await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.createSelectorQuery().select('.ach-grid').boundingClientRect((rect) => {
        if (rect) {
          wx.pageScrollTo({ scrollTop: Math.max(0, rect.top - 140), duration: 0, complete: () => resolve(true) });
        } else {
          wx.pageScrollTo({ scrollTop: 300, duration: 0, complete: () => resolve(true) });
        }
      }).exec();
    })), 'scroll to achievements', 1);
    await sleep(700);
    await withTimeout(mini.screenshot({ path: SHOT_FILE }), 25000, 'screenshot achievements');
    console.log('SHOT 29-profile-achievements.png');
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
