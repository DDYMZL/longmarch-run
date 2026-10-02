/**
 * P0-3 长征章节系统 小程序验收（断言先行，截图放末尾）
 *
 * 覆盖（需求 §4.1~4.5）：
 *   P0CH-01 0 步：march 页章节卡展示「第一章 · 出发」1/2、进度 50%
 *   P0CH-02 +5000（点亮遵义）：章节完成仪式卡弹出（kind=chapter，含标题与历史介绍）
 *   P0CH-03 仪式结束后：章节卡切换为「第二章 · 转折」ACTIVE，第一章 COMPLETED
 * 末尾截图：
 *   20-march-chapter-card.png      章节卡（第二章进行中）
 *   21-march-chapter-ceremony.png  章节完成仪式卡（补 10000 步完成第二章时抓取）
 *
 *   node p0-chapters.cjs
 *
 * 前置：后端 8010 运行（含章节字段新代码）；开发者工具自动化端口 9420 可用。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const NICKNAME = 'P0章节';
const AVATAR = 'https://example.com/auto-avatar.png';
const RESULTS_FILE = path.join(__dirname, 'results-p0ch.json');
const SHOT_CARD = path.join(__dirname, '..', 'images', '20-march-chapter-card.png');
const SHOT_CEREMONY = path.join(__dirname, '..', 'images', '21-march-chapter-ceremony.png');

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

async function waitFor(fn, timeout = 15000, interval = 300, desc = 'condition') {
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

/** 全新账号登录（独立 login code，确保 0 步起步） */
async function freshLogin() {
  const code = 'automator-p0ch-' + Date.now();
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

async function reloadMarch() {
  await cmd(() => mini.reLaunch('/pages/march/march'), 'reLaunch march', 2);
  const page = await waitPath('pages/march/march');
  await waitFor(async () => {
    const d = await cmd(() => page.data(), 'march data');
    return d && d.chapters && d.chapters.length === 5 && d.currentChapter ? d : null;
  }, 20000, 500, 'march.chapters ready');
  return page;
}

(async () => {
  mini = await connectMini();
  const code = await freshLogin();

  /* P0CH-01 0 步：第一章 ACTIVE 1/2 */
  try {
    const page = await reloadMarch();
    const d = await cmd(() => page.data(), 'march data');
    const c = d.currentChapter || {};
    record('P0CH-01', '0步：章节卡「第一章 · 出发」1/2 进度50%',
      c.title === '第一章 · 出发' && c.litCount === 1 && c.totalCount === 2 && c.progressPct === 50,
      'title=' + c.title + ' ' + c.litCount + '/' + c.totalCount + ' pct=' + c.progressPct);
  } catch (e) { record('P0CH-01', '0步章节卡', false, e.message); }

  /* P0CH-02 +5000：章节完成仪式卡弹出 */
  try {
    await apiAddSteps(code, 5000);
    const page = await reloadMarch();
    const popup = await waitFor(async () => {
      const d = await cmd(() => page.data(), 'march popup poll', 1);
      return d && d.litPopup && d.litPopup.kind === 'chapter' ? d.litPopup : null;
    }, 15000, 250, '章节仪式卡');
    record('P0CH-02', '5000步：章节完成仪式卡弹出（含历史介绍）',
      popup.title === '第一章 · 出发' && typeof popup.intro === 'string' && popup.intro.length > 10,
      'title=' + popup.title + ' intro=' + (popup.intro || '').slice(0, 24) + '...');

    /* P0CH-03 仪式结束后：切到第二章 ACTIVE，第一章 COMPLETED */
    await waitFor(async () => {
      const d = await cmd(() => page.data(), 'march popup done', 1);
      return d && !d.litPopup ? d : null;
    }, 15000, 400, '仪式卡结束');
    const d = await cmd(() => page.data(), 'march data after');
    const c = d.currentChapter || {};
    const ch1 = (d.chapters || []).find((x) => x.id === 1) || {};
    record('P0CH-03', '仪式后：第二章 ACTIVE、第一章 COMPLETED',
      c.title === '第二章 · 转折' && ch1.status === 'COMPLETED',
      'current=' + c.title + ' ch1=' + ch1.status);

    // 截图 1：章节卡（第二章进行中）
    await sleep(600);
    await withTimeout(mini.screenshot({ path: SHOT_CARD }), 25000, 'screenshot card');
    console.log('SHOT 20-march-chapter-card.png');
  } catch (e) { record('P0CH-02', '章节仪式卡', false, e.message); }

  /* 截图 2：章节完成仪式卡（+10000 累计 15000 完成第二章） */
  try {
    await apiAddSteps(code, 10000);
    const page = await reloadMarch();
    await waitFor(async () => {
      const d = await cmd(() => page.data(), 'march popup poll2', 1);
      return d && d.litPopup && d.litPopup.kind === 'chapter' ? d.litPopup : null;
    }, 15000, 200, '第二章仪式卡');
    await withTimeout(mini.screenshot({ path: SHOT_CEREMONY }), 25000, 'screenshot ceremony');
    console.log('SHOT 21-march-chapter-ceremony.png');
  } catch (e) { console.log('截图2失败（不影响断言）: ' + e.message); }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log('\n== 共 ' + results.length + ' 用例，失败 ' + failed.length + ' ==');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FATAL: ' + (e && e.message));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  process.exit(2);
});
