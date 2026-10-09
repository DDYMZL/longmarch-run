/**
 * 身份关联截图巡礼（与断言流程完全分离）—— identity-ui-test.cjs 断言落盘后独立补拍 6 个状态。
 * 每个状态独立连接、以主动导航命令开头、只拍一张；截图导致的桥退化在状态间消化。
 *
 *   node identity-shots.cjs            全部 6 个状态
 *   node identity-shots.cjs b5-01-mine-entry   只拍指定状态
 *
 * 前置：后端 http://127.0.0.1:8010 已运行；开发者工具自动化端口 9420 可用
 * （连不上时本脚本会自动执行 cli.bat auto 重开桥）。L 场景由本脚本直调
 * POST /api/admin/wechat/qr 现取（无需鉴权，mock 模式返回明文 scene）；
 * B 场景读 fixtures-identity.json（4 小时有效）。
 * 每个状态先 ensureLogin：已登录且已选组织则复用，否则重置 -> mock wx.login ->
 * 登录 -> confirmSelect(1)，保证 IDE 重启/存储变化后状态仍可复现。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const CLI = 'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const PROJECT = 'D:/project/longmarch-run';
const IMAGES_DIR = path.join(__dirname, '..', 'images');
const API_BASE = 'http://127.0.0.1:8010';
const LOGIN_CODE = 'identity-shots-' + Date.now();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('超时:' + label)), ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t));
}

async function cmd(fn, desc, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await withTimeout(fn(), 12000, desc);
    } catch (e) {
      if (i === retries) throw e;
      await sleep(1500);
    }
  }
}

async function waitPath(mini, prefix, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = await withTimeout(mini.currentPage().catch(() => null), 8000, 'currentPage').catch(() => null);
    if (p && p.path && p.path.indexOf(prefix) === 0) return p;
    await sleep(500);
  }
  throw new Error('等待页面超时: ' + prefix);
}

/** 轮询页面 data 直到谓词为真值 */
async function waitData(mini, fn, timeout = 20000, desc = 'data') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = await withTimeout(mini.currentPage().catch(() => null), 8000, 'currentPage').catch(() => null);
    if (!p) { await sleep(500); continue; }
    try {
      const d = await cmd(() => p.data(), 'page.data', 1);
      if (fn(d)) return d;
    } catch (e) { /* retry */ }
    await sleep(500);
  }
  throw new Error('等待数据超时: ' + desc);
}

function rearmBridge() {
  console.log('--- 重启自动化桥 ---');
  spawnSync('cmd.exe', ['/c', CLI, 'auto', '--project', PROJECT, '--auto-port', '9420'], { stdio: 'ignore', timeout: 60000 });
}

async function connectMini() {
  for (let i = 0; i < 3; i++) {
    try {
      return await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect');
    } catch (e) {
      console.log('connect 失败(' + (i + 1) + '/3): ' + e.message);
      await sleep(6000);
    }
  }
  rearmBridge();
  await sleep(25000);
  return await withTimeout(automator.connect({ wsEndpoint: WS }), 25000, 'connect-final');
}

async function shot(mini, name) {
  const file = path.join(IMAGES_DIR, name + '.png');
  for (let i = 0; i < 2; i++) {
    try {
      await withTimeout(mini.screenshot({ path: file }), 15000, 'shot ' + name);
      console.log('shot: ' + name);
      return true;
    } catch (e) {
      console.log('shot 失败(' + (i + 1) + '/2): ' + name + ' ' + e.message);
      await sleep(8000);
    }
  }
  console.log('MISSING: ' + name);
  return false;
}

/** 夹具：B 场景（bindSceneShots，绑定模式待确认） */
function bindScene() {
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures-identity.json'), 'utf8'));
  if (!f.bindSceneShots) throw new Error('缺少 fixtures-identity.json bindSceneShots');
  return f.bindSceneShots;
}

/** 现取 L 场景（登录模式，无鉴权） */
async function freshLoginScene() {
  const res = await fetch(API_BASE + '/api/admin/wechat/qr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error('创建 L 场景失败 HTTP ' + res.status);
  const data = await res.json();
  if (!data.scene) throw new Error('L 场景缺少 scene 字段: ' + JSON.stringify(data));
  return data.scene;
}

/** 每个状态前保障登录：已登录且已选组织直接返回；否则重置 -> mock wx.login -> 登录 -> 选组织 1 */
async function ensureLogin(mini) {
  const ok = await cmd(() => mini.evaluate(() => {
    const app = getApp();
    return !!(app.globalData.loggedIn && app.globalData.user && app.globalData.user.orgId);
  }), 'check login', 2).catch(() => null);
  if (ok === true) return true;

  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) { /* ignore */ }
    return true;
  }), 'resetAuth', 2);
  await cmd(() => mini.reLaunch('/pages/login/login'), 'reLaunch login', 2);
  await waitPath(mini, 'pages/login/login');
  // 页面加载完成后 mock wx.login（过早 mock 会被 appservice 启动过程冲掉）
  for (let i = 0; i < 5; i++) {
    await cmd(() => mini.mockWxMethod('login', { code: LOGIN_CODE }), 'mock login', 1).catch(() => {});
    const got = await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.login({ success: (r) => resolve(r && r.code ? r.code : 'NO_CODE'), fail: () => resolve('FAIL_BRANCH') });
    })), 'verify login mock', 1).catch(() => 'EVAL_ERR');
    if (got === LOGIN_CODE) break;
    console.log('wx.login mock 未生效(' + (i + 1) + '/5)，重试');
    await sleep(2000);
  }
  const login = await waitPath(mini, 'pages/login/login');
  await cmd(() => login.callMethod('doLogin', ''), 'doLogin', 2);
  const org = await waitPath(mini, 'pages/org-select/org-select');
  await sleep(1200);
  await cmd(() => org.callMethod('confirmSelect', 1), 'confirmSelect 1', 2);
  await waitPath(mini, 'pages/home/home');
  await sleep(800);
  return true;
}

function goBind(mini, scene) {
  return cmd(() => mini.reLaunch('/pages/bind/bind?scene=' + encodeURIComponent(scene)), 'reLaunch bind ' + scene.slice(0, 6) + '..', 2);
}

// 每个状态都以主动导航命令开头（截图后桥退化时主动命令可唤醒桥，纯 currentPage 轮询只会持续超时）
const STATES = [
  ['b5-01-mine-entry', async (mini) => {
    await ensureLogin(mini);
    await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine', 2);
    await waitPath(mini, 'pages/mine/mine');
    await sleep(2500);
  }],
  ['b5-02-bind-confirm-bind', async (mini) => {
    await ensureLogin(mini);
    await goBind(mini, bindScene());
    await waitData(mini, (d) => d.phase === 'confirm' && d.mode === 'bind', 20000, 'bind confirm card');
    await sleep(800);
  }],
  // 确认 B 场景绑定（创建 wx_web 身份）-> 进入 account 页展示 1 条身份
  ['b5-03-account-list', async (mini) => {
    await ensureLogin(mini);
    await goBind(mini, bindScene());
    await waitData(mini, (d) => d.phase === 'confirm' && d.mode === 'bind', 20000, 'bind confirm card 03');
    const page = await waitPath(mini, 'pages/bind/bind');
    await cmd(() => page.callMethod('handleConfirm'), 'handleConfirm bind', 2);
    await waitData(mini, (d) => d.phase === 'done', 20000, 'bind done');
    await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine 03', 2);
    await sleep(1200);
    const mine = await waitPath(mini, 'pages/mine/mine');
    await cmd(() => mine.callMethod('goAccount'), 'goAccount 03', 2);
    await waitPath(mini, 'pages/account/account');
    await waitData(mini, (d) => d.identities && d.identities.length === 1, 20000, 'account list 1');
    await sleep(1200);
  }],
  // 解绑唯一 wx_web 身份 -> 空态
  ['b5-04-account-empty', async (mini) => {
    await ensureLogin(mini);
    await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine 04', 2);
    await sleep(1200);
    const mine = await waitPath(mini, 'pages/mine/mine');
    await cmd(() => mine.callMethod('goAccount'), 'goAccount 04', 2);
    await waitPath(mini, 'pages/account/account');
    const d = await waitData(mini, (x) => x.identities && x.identities.length === 1, 20000, 'account list 1 before unbind');
    const item = d.identities[0];
    await cmd(() => mini.mockWxMethod('showModal', { confirm: true, cancel: false }), 'mock showModal', 2);
    const page = await waitPath(mini, 'pages/account/account');
    await cmd(() => page.callMethod('handleUnbind', { currentTarget: { dataset: { id: item.id, name: item.providerName } } }), 'handleUnbind', 2);
    await waitData(mini, (x) => x.empty === true, 25000, 'account empty');
    await sleep(1000);
  }],
  ['b5-05-bind-confirm-login', async (mini) => {
    await ensureLogin(mini);
    const scene = await freshLoginScene();
    await goBind(mini, scene);
    await waitData(mini, (d) => d.phase === 'confirm' && d.mode === 'login', 20000, 'login confirm card');
    await sleep(800);
  }],
  ['b5-06-bind-error', async (mini) => {
    await ensureLogin(mini);
    await goBind(mini, 'invalid-scene-xyz');
    await waitData(mini, (d) => d.phase === 'error', 20000, 'error card');
    await sleep(800);
  }],
];

(async () => {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const only = process.argv[2] ? process.argv[2].split(',') : null;
  const done = [];
  const missing = [];
  for (const [name, setup] of STATES) {
    if (only && only.indexOf(name) === -1) continue;
    let mini = null;
    try {
      mini = await connectMini();
      await setup(mini);
      if (await shot(mini, name)) done.push(name); else missing.push(name);
    } catch (e) {
      console.log('STATE ' + name + ' FAIL: ' + e.message);
      missing.push(name);
    }
    try { if (mini) await withTimeout(mini.disconnect(), 6000, 'disconnect'); } catch (e) { /* ignore */ }
    // 截图后自动化桥需更长冷却：紧邻的下一状态会 currentPage 失败，约一个状态周期后自愈
    await sleep(15000);
  }
  console.log('===== IDENTITY SHOTS DONE ===== 通过 ' + done.length + '/' + STATES.length +
    (missing.length ? '；缺失: ' + missing.join(',') : ''));
  process.exit(missing.length ? 1 : 0);
})().catch((e) => { console.log('SHOTS CRASH: ' + e.message); process.exit(2); });
