/**
 * S5 截图巡礼（与断言完全分离）—— 复现 S5 各新页面/弹层状态并补拍截图。
 *
 * 任何 mini.screenshot 都会使自动化桥退化，故每个状态独立连接、截图后断开冷却；
 * 每个状态以主动导航开头（唤醒退化桥）。不含任何断言。
 *
 *   node s5-shots.cjs                 全部状态
 *   node s5-shots.cjs s5-01-home      只拍指定状态（可逗号分隔）
 *
 * 前置：后端 8010 已运行；开发者工具自动化端口 9420 可用。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const CLI = 'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const PROJECT = 'D:/project/longmarch-run';
const IMAGES_DIR = path.join(__dirname, '..', 'images');
const NICKNAME = '自动化测试员';
const AVATAR = 'https://example.com/auto-avatar.png';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('超时:' + label)), ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t));
}

async function cmd(fn, desc, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    try { return await withTimeout(fn(), 12000, desc); } catch (e) {
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

function rearmBridge() {
  console.log('--- 重启自动化桥 ---');
  spawnSync('cmd.exe', ['/c', CLI, 'auto', '--project', PROJECT, '--auto-port', '9420'], { stdio: 'ignore', timeout: 60000 });
}

async function connectMini() {
  for (let i = 0; i < 3; i++) {
    try { return await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect'); } catch (e) {
      console.log('connect 失败(' + (i + 1) + '/3): ' + e.message);
      await sleep(6000);
    }
  }
  rearmBridge();
  await sleep(25000);
  return await withTimeout(automator.connect({ wsEndpoint: WS }), 25000, 'connect-final');
}

function tourLoginCode() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
    if (s && s.loginCode) return s.loginCode;
  } catch (e) { /* ignore */ }
  return 'automator-s5-' + Date.now();
}

async function ensureLoginMock(mini) {
  const code = tourLoginCode();
  for (let i = 0; i < 5; i++) {
    await withTimeout(mini.mockWxMethod('login', { code }), 10000, 'mock login').catch(() => {});
    const got = await withTimeout(mini.evaluate(() => new Promise((resolve) => {
      wx.login({ success: (r) => resolve(r && r.code ? r.code : 'NO_CODE'), fail: () => resolve('FAIL_BRANCH') });
    })), 10000, 'verify login mock').catch(() => 'EVAL_ERR');
    if (got === code) return;
    await sleep(2000);
  }
  throw new Error('wx.login mock 反复未生效');
}

/** 登录态缺失时执行完整登录（正常情况复用 IDE 持久登录态，直接返回） */
async function ensureLoggedIn(mini) {
  const state = await cmd(() => mini.evaluate(() => {
    const g = getApp().globalData;
    return { loggedIn: !!g.loggedIn, orgId: g.user && g.user.orgId ? g.user.orgId : null };
  }), 'login state', 1).catch(() => null);
  if (state && state.loggedIn && state.orgId) return;
  console.log('登录态缺失，执行登录流程');
  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) { /* ignore */ }
    return true;
  }), 'resetAuth', 2);
  await cmd(() => mini.reLaunch('/pages/login/login'), 'reLaunch login', 2);
  const login = await waitPath(mini, 'pages/login/login');
  await ensureLoginMock(mini);
  await cmd(() => login.setData({ nickname: NICKNAME }), 'setData nickname', 2);
  await cmd(() => login.callMethod('doLogin', AVATAR), 'doLogin', 2);
  const org = await waitPath(mini, 'pages/org-select/org-select');
  await cmd(() => org.callMethod('confirmSelect', 12), 'confirmSelect 12', 2);
  await waitPath(mini, 'pages/home/home');
  await sleep(1500);
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

// 合成「抵达事件卡」节点数据（纯 UI 演示，不改业务数据）
const DEMO_LIT = [{
  name: '遵义',
  icon: '🏛️',
  historicalTime: '1935年1月',
  gainedPoints: 10,
  nextNode: { name: '四渡赤水', remain: 5000 }
}];

const STATES = [
  ['s5-01-home', async (mini) => {
    await cmd(() => mini.switchTab('/pages/home/home'), 'switchTab home', 2);
    await waitPath(mini, 'pages/home/home');
    await sleep(3500);
  }],
  ['s5-02-home-arrive-card', async (mini) => {
    await cmd(() => mini.switchTab('/pages/home/home'), 'switchTab home 2', 2);
    const home = await waitPath(mini, 'pages/home/home');
    await sleep(1200);
    await cmd(() => home.callMethod('playLitPopup', DEMO_LIT), 'playLitPopup demo', 2);
    await sleep(1400); // 弹层弹出 + 星星动画落定
  }],
  ['s5-03-profile', async (mini) => {
    await cmd(() => mini.navigateTo('/pages/profile/profile'), 'navigateTo profile', 2);
    await waitPath(mini, 'pages/profile/profile');
    await sleep(2800);
  }],
  ['s5-04-calendar', async (mini) => {
    await cmd(() => mini.navigateTo('/pages/calendar/calendar'), 'navigateTo calendar', 2);
    await waitPath(mini, 'pages/calendar/calendar');
    await sleep(2500);
  }],
  ['s5-05-calendar-detail', async (mini) => {
    await cmd(() => mini.navigateTo('/pages/calendar/calendar'), 'navigateTo calendar 2', 2);
    const cal = await waitPath(mini, 'pages/calendar/calendar');
    await sleep(1800);
    const d = await cmd(() => cal.data(), 'calendar cells', 2);
    const cell = d.cells.find((c) => !c.blank);
    await cmd(() => cal.callMethod('handleDayTap', { currentTarget: { dataset: { cell } } }), 'handleDayTap', 2);
    await sleep(1200);
  }],
  ['s5-06-quiz', async (mini) => {
    await cmd(() => mini.switchTab('/pages/quiz/quiz'), 'switchTab quiz', 2);
    await waitPath(mini, 'pages/quiz/quiz');
    await sleep(2800);
  }],
  ['s5-07-medals', async (mini) => {
    await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine for medals', 2);
    const mine = await waitPath(mini, 'pages/mine/mine');
    await sleep(1200);
    await cmd(() => mine.callMethod('goMedals'), 'goMedals', 2);
    await waitPath(mini, 'pages/medals/medals');
    await sleep(2200);
  }],
  ['s5-08-medal-detail', async (mini) => {
    await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine for medal detail', 2);
    const mine = await waitPath(mini, 'pages/mine/mine');
    await sleep(1200);
    await cmd(() => mine.callMethod('goMedals'), 'goMedals 2', 2);
    const medals = await waitPath(mini, 'pages/medals/medals');
    await sleep(1800);
    const d = await cmd(() => medals.data(), 'medals groups', 2);
    const item = d.groups[0].medals[0];
    await cmd(() => medals.callMethod('handleMedalTap', { currentTarget: { dataset: { item } } }), 'handleMedalTap', 2);
    await sleep(1200);
  }],
  ['s5-09-node-detail', async (mini) => {
    await cmd(() => mini.navigateTo('/pages/node-detail/node-detail?id=2'), 'navigateTo node-detail', 2);
    await waitPath(mini, 'pages/node-detail/node-detail');
    await sleep(2500);
  }],
  ['s5-10-march-canvas', async (mini) => {
    await cmd(() => mini.switchTab('/pages/march/march'), 'switchTab march', 2);
    const march = await waitPath(mini, 'pages/march/march');
    await sleep(2500);
    await cmd(() => march.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } }), 'switchMode canvas', 2);
    await sleep(3500); // canvas 入场动画
  }],
  ['s5-11-march-arrive-card', async (mini) => {
    await cmd(() => mini.switchTab('/pages/march/march'), 'switchTab march 2', 2);
    const march = await waitPath(mini, 'pages/march/march');
    await sleep(2500);
    await cmd(() => march.callMethod('playArrivePopup', DEMO_LIT), 'playArrivePopup demo', 2);
    await sleep(1400);
  }],
  ['s5-12-mine', async (mini) => {
    await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine', 2);
    await waitPath(mini, 'pages/mine/mine');
    await sleep(2500);
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
      await ensureLoggedIn(mini);
      await setup(mini);
      if (await shot(mini, name)) done.push(name); else missing.push(name);
    } catch (e) {
      console.log('STATE ' + name + ' FAIL: ' + e.message);
      missing.push(name);
    }
    try { if (mini) await withTimeout(mini.disconnect(), 6000, 'disconnect'); } catch (e) { /* ignore */ }
    // 截图后自动化桥需冷却
    await sleep(15000);
  }
  console.log('===== S5 TOUR DONE ===== 通过 ' + done.length + '/' + STATES.length +
    (missing.length ? '；缺失: ' + missing.join(',') : ''));
  process.exit(missing.length ? 1 : 0);
})().catch((e) => { console.log('TOUR CRASH: ' + e.message); process.exit(2); });
