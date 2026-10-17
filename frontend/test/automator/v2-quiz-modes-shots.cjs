/**
 * quiz 页双模式截图（视觉证据，与断言脚本分离）。
 * 已知：mini.screenshot 会让自动化桥退化——每个状态用独立连接 + 主动导航（见 automator 协议）。
 *
 *   60-v2-quiz-mode-switch.png  quiz 页：模式切换（情报2 高亮）
 *   61-v2-quiz2-answering.png   情报2 作答中：已选中但无对错提示
 *   62-v2-quiz2-submitted.png   情报2 交卷态：全部已提交
 *   63-v2-quiz2-result.png      交卷后结果页：逐题解析一次性展示
 *
 *   node v2-quiz-modes-shots.cjs
 * 前置：后端 8010；开发者工具自动化端口 9420；../v12-fixture.json
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => console.log('未处理 rejection: ' + (e && e.message ? e.message : e)));

const WS = 'ws://127.0.0.1:9420';
const CLI = 'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'v12-fixture.json'), 'utf8'));
const IMAGES = path.join(__dirname, '..', 'images');
let mini = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const answerLabel = (id) => (FIXTURE.answers[id] || [])[0] || '';

function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('超时: ' + label)), ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t));
}

async function cmd(fn, desc, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await withTimeout(fn(), 20000, desc); } catch (e) {
      if (i === retries) throw e;
      await sleep(1500);
    }
  }
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

async function waitFor(fn, timeout = 15000, desc = 'condition') {
  const start = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { /* retry */ }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('等待超时: ' + desc);
    await sleep(400);
  }
}

function api(p, m) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 8010, path: '/api' + p, method: m || 'GET', headers: { Authorization: 'Bearer ' + FIXTURE.token } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject); req.end();
  });
}

async function connect() {
  for (let i = 0; i < 3; i++) {
    try { return await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect'); } catch (e) { await sleep(6000); }
  }
  throw new Error('无法连接自动化桥');
}

/** 重新激活自动化桥（截图退化后的自愈手段，见 automator 协议） */
async function rearm() {
  console.log('重新激活自动化桥…');
  try { spawnSync('"' + CLI + '"', ['auto', '--project', 'D:/project/longmarch-run', '--auto-port', '9420'], { shell: true, stdio: 'ignore', timeout: 60000 }); } catch (e) { /* ignore */ }
  await sleep(20000);
}

/** 独立连接执行一个状态：fn 内主动导航到目标态并截图；失败时自愈重试一次 */
async function withBridge(label, fn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    mini = await connect();
    await sleep(500);
    try {
      await fn();
      try { await mini.disconnect(); } catch (e) { /* ignore */ }
      mini = null;
      console.log('状态完成: ' + label);
      return;
    } catch (e) {
      try { await mini.disconnect(); } catch (err) { /* ignore */ }
      mini = null;
      if (attempt === 1) throw e;
      console.log('状态 ' + label + ' 失败，自愈重试: ' + (e && e.message));
      await rearm();
    }
  }
}

async function shot(name) {
  await cmd(() => mini.screenshot({ path: path.join(IMAGES, name) }), 'shot ' + name, 1);
  console.log('截图 ' + name);
}

async function loginIfNeeded() {
  const p = await withTimeout(mini.currentPage().catch(() => null), 8000, 'cur').catch(() => null);
  if (p && p.path && p.path.indexOf('pages/login') < 0 && p.path.indexOf('pages/launch') < 0) return;
  await cmd(() => mini.evaluate((token) => {
    const app = getApp();
    app.globalData.user = null; app.globalData.loggedIn = false;
    wx.clearStorageSync(); wx.setStorageSync('lm_auth_token', token);
    return true;
  }, FIXTURE.token), 'inject token');
  await cmd(() => mini.reLaunch('/pages/launch/launch'), 'reLaunch launch');
  await waitPath('pages/home/home', 30000);
  await sleep(800);
}

/** 情报2：答完全部 5 题进入交卷态 */
async function answerAllReview() {
  const tab = await setMode('review');
  await cmd(() => tab.callMethod('handleStart'), 'start');
  const ans = await waitPath('pages/quiz-answer/quiz-answer');
  await waitFor(async () => ((await ans.data()).phase === 'answering' ? true : null), 15000, 'answering');
  for (let i = 1; i <= 5; i++) {
    const d = await ans.data();
    const l = answerLabel(d.question.id) || d.options[0].label;
    await cmd(() => ans.callMethod('handleSelect', { currentTarget: { dataset: { label: l } } }), 'sel ' + i);
    await cmd(() => ans.callMethod('handleSubmit'), 'submit ' + i);
    if (i < 5) await waitFor(async () => { const x = await ans.data(); return x.phase === 'answering' && x.seq === i + 1 ? true : null; }, 15000, 'q' + (i + 1));
    else await waitFor(async () => { const x = await ans.data(); return x.phase === 'submitted' ? true : null; }, 15000, 'submitted');
  }
  return ans;
}

async function setMode(mode) {
  await cmd(() => mini.reLaunch('/pages/quiz/quiz'), 'reLaunch quiz');
  const tab = await waitPath('pages/quiz/quiz');
  await cmd(() => tab.callMethod('handleModeChange', { currentTarget: { dataset: { mode } } }), 'mode ' + mode);
  await waitFor(async () => ((await tab.data()).mode === mode ? true : null), 8000, 'mode ' + mode);
  return tab;
}

async function run() {
  const only = (process.argv.find((a) => a.indexOf('--only=') === 0) || '').split('=')[1] || '';
  const want = (id) => !only || only === id;

  // 60：quiz 页模式切换
  if (want('60')) await withBridge('60 mode-switch', async () => {
    await loginIfNeeded();
    await setMode('review');
    await sleep(1200);
    await shot('60-v2-quiz-mode-switch.png');
  });

  // 61：情报2 作答中（选中但无对错）
  if (want('61')) await withBridge('61 answering', async () => {
    await loginIfNeeded();
    await api('/quiz/reset', 'POST');
    const tab = await setMode('review');
    await cmd(() => tab.callMethod('handleStart'), 'start');
    const ans = await waitPath('pages/quiz-answer/quiz-answer');
    await waitFor(async () => ((await ans.data()).phase === 'answering' ? true : null), 15000, 'answering');
    const d = await ans.data();
    const l = answerLabel(d.question.id) || d.options[0].label;
    await cmd(() => ans.callMethod('handleSelect', { currentTarget: { dataset: { label: l } } }), 'select');
    await sleep(600);
    await shot('61-v2-quiz2-answering.png');
  });

  // 62：交卷态
  if (want('62')) await withBridge('62 submitted', async () => {
    await loginIfNeeded();
    await api('/quiz/reset', 'POST');
    await answerAllReview();
    await sleep(800);
    await shot('62-v2-quiz2-submitted.png');
  });

  // 63：结果页（全部解析）
  if (want('63')) await withBridge('63 result', async () => {
    await loginIfNeeded();
    await api('/quiz/reset', 'POST');
    const ans = await answerAllReview();
    await cmd(() => ans.callMethod('handleViewResult'), 'view result');
    const rp = await waitPath('pages/quiz-result/quiz-result');
    await waitFor(async () => { const x = await rp.data(); return x.details && x.details.length ? true : null; }, 15000, 'details');
    await sleep(1600);
    await shot('63-v2-quiz2-result.png');
  });

  console.log('完成');
}

run().catch((e) => { console.log('异常: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
