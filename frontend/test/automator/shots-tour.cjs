/**
 * 截图巡礼（与断言流程完全分离）—— 在套件跑完后独立复现 16 个页面状态并补拍截图。
 *
 * 为什么独立：实测（probe5/6）任何 mini.screenshot 都会使自动化桥退化，破坏后续
 * 页面句柄操作；本脚本不含任何断言，每个状态前重新连接，截图导致的退化在状态间
 * 消化（disconnect + 重新 connect），无法污染测试结论。
 *
 *   node shots-tour.cjs            全部 16 个状态
 *   node shots-tour.cjs 05-march   只拍指定状态（可逗号分隔多个）
 *
 * 前置：后端 http://127.0.0.1:8010 已运行；开发者工具自动化端口 9420 可用
 * （连不上时本脚本会自动执行 cli.bat auto 重开桥）。
 * wx.login 与套件同法 mock（复用 ui-test.cjs 落盘的 loginCode，保证与断言同一测试用户）；
 * 详见 ui-test.cjs 头注（IDE 未登录微信账号时真实 wx.login 报 41002）。
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
// 后端题库（15 题，与 mock/data.js 种子一致）id → 正确答案。每日随机抽 5 题（非前 5），
// 映射必须覆盖全题库；页面题目对象不含 answer（判分在后端 quiz.submit）
const CORRECT = {
  1: 'B', 2: 'A', 3: 'A', 4: 'A', 5: 'A', 6: 'A', 7: 'A',
  8: 'A', 9: 'B', 10: 'A', 11: 'C', 12: 'A', 13: 'A', 14: 'A', 15: 'A'
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('超时:' + label)), ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t));
}

async function cmd(fn, desc, retries = 1) {
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

/** 复用 ui-test.cjs 落盘的 loginCode，保证巡礼与断言同一测试用户 */
function tourLoginCode() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
    if (s && s.loginCode) return s.loginCode;
  } catch (e) { /* ignore */ }
  return 'automator-tour-' + Date.now();
}

/** 应用并实测验证 wx.login mock（须在页面已加载后调用，否则会被启动过程冲掉） */
async function ensureLoginMock(mini) {
  const code = tourLoginCode();
  for (let i = 0; i < 5; i++) {
    await withTimeout(mini.mockWxMethod('login', { code }), 10000, 'mock login').catch(() => {});
    const got = await withTimeout(mini.evaluate(() => new Promise((resolve) => {
      wx.login({ success: (r) => resolve(r && r.code ? r.code : 'NO_CODE'), fail: () => resolve('FAIL_BRANCH') });
    })), 10000, 'verify login mock').catch(() => 'EVAL_ERR');
    if (got === code) return;
    console.log('wx.login mock 未生效(' + (i + 1) + '/5): got=' + got + '，重试');
    await sleep(2000);
  }
  throw new Error('wx.login mock 反复未生效');
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

async function resetAuth(mini) {
  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) { /* ignore */ }
    return true;
  }), 'resetAuth', 2);
}

/** 清登录态 → 登录 → 停在组织选择页，返回页句柄 */
async function loginFlow(mini) {
  await resetAuth(mini);
  await cmd(() => mini.reLaunch('/pages/login/login'), 'reLaunch login', 2);
  const login = await waitPath(mini, 'pages/login/login');
  // 页面加载完成后 mock wx.login（过早 mock 会被 appservice 启动过程冲掉）
  await ensureLoginMock(mini);
  await cmd(() => login.setData({ nickname: NICKNAME }), 'setData nickname', 2);
  await cmd(() => login.callMethod('doLogin', AVATAR), 'doLogin', 2);
  return await waitPath(mini, 'pages/org-select/org-select');
}

/** 组织页下钻到指定 id（直接调页面方法，绕过 DOM 事件） */
async function drillTo(mini, orgPage, ids) {
  let page = orgPage;
  for (const id of ids) {
    await cmd(() => page.callMethod('drillInto', id), 'drillInto ' + id, 2);
    await sleep(1400);
    const p = await withTimeout(mini.currentPage().catch(() => null), 8000, 'currentPage').catch(() => null);
    if (p) page = p;
  }
  return page;
}

async function ensureQuizFresh(mini, quizPage) {
  const completed = await cmd(() => quizPage.data('completed'), 'quiz completed');
  if (completed === true) {
    await cmd(() => mini.mockWxMethod('showModal', { confirm: true, cancel: false }), 'mock showModal');
    await cmd(() => quizPage.callMethod('handleResetToday'), 'handleResetToday', 2);
    await sleep(2200);
    await cmd(() => mini.restoreWxMethod('showModal'), 'restore showModal');
    await sleep(600);
  }
}

/** 在 quiz-answer 页答完 5 题（wrong=true 时全选错误答案），停到 quiz-result */
async function answerAll(mini, wrong) {
  await waitPath(mini, 'pages/quiz-answer/quiz-answer');
  let answered = 0;
  while (answered < 5) {
    // 每轮重取栈顶句柄：redirectTo 后旧句柄会报 page is not on top of page stack
    const top = await withTimeout(mini.currentPage().catch(() => null), 8000, 'currentPage').catch(() => null);
    if (!top) break;
    if (top.path.indexOf('pages/quiz-result/quiz-result') === 0) break;
    if (top.path.indexOf('pages/quiz-answer/quiz-answer') !== 0) { await sleep(800); continue; }
    await sleep(500);
    const d = await cmd(() => top.data(), 'answer data', 3);
    if (!d.current) break;
    const correct = CORRECT[d.current.id] || 'A';
    const label = wrong ? (correct === 'A' ? 'B' : 'A') : correct;
    console.log('answerAll: Q' + d.current.id + ' label=' + label);
    await cmd(() => top.callMethod('handleSelect', { currentTarget: { dataset: { label } } }), 'handleSelect', 3);
    await sleep(400);
    await cmd(() => top.callMethod('handleNext'), 'handleNext', 3);
    answered++;
    await sleep(1100);
  }
  // 第 5 题 handleNext 触发提交 + redirectTo（异步）；此后绝不再触碰 answer 页句柄
  await waitPath(mini, 'pages/quiz-result/quiz-result', 15000);
  await sleep(2200);
}

// 每个状态都以主动导航命令开头（而非 waitPath 盲等）：截图后自动化桥退化时，
// 主动命令可唤醒桥，纯 currentPage 轮询只会持续超时
const STATES = [
  ['01-login', async (mini) => {
    await resetAuth(mini);
    await cmd(() => mini.reLaunch('/pages/login/login'), 'reLaunch login', 2);
    await sleep(2500);
  }],
  ['02-org-select', async (mini) => {
    await loginFlow(mini);
    await sleep(2200);
  }],
  ['03-org-drill', async (mini) => {
    const org = await waitPath(mini, 'pages/org-select/org-select');
    await drillTo(mini, org, [1, 2, 6]);
    await sleep(1500);
  }],
  ['04-home', async (mini) => {
    const org = await waitPath(mini, 'pages/org-select/org-select');
    await cmd(() => org.callMethod('confirmSelect', 12), 'confirmSelect 前端组', 2);
    await waitPath(mini, 'pages/home/home');
    await sleep(1200);
    const home = await waitPath(mini, 'pages/home/home');
    await cmd(() => home.callMethod('handleSyncSteps'), 'handleSyncSteps', 2);
    await sleep(2600);
    await cmd(() => home.callMethod('handleAddSteps'), 'handleAddSteps', 2);
    await sleep(1800);
  }],
  ['05-march', async (mini) => {
    await cmd(() => mini.switchTab('/pages/march/march'), 'switchTab march', 2);
    await sleep(4500);
  }],
  ['06-node-detail', async (mini) => {
    await cmd(() => mini.navigateTo('/pages/node-detail/node-detail?id=2'), 'navigateTo node-detail', 2);
    await sleep(2200);
  }],
  ['07-quiz-answer', async (mini) => {
    await cmd(() => mini.switchTab('/pages/quiz/quiz'), 'switchTab quiz', 2);
    const quiz = await waitPath(mini, 'pages/quiz/quiz');
    await ensureQuizFresh(mini, quiz);
    await cmd(() => quiz.callMethod('handleStart'), 'handleStart', 2);
    await waitPath(mini, 'pages/quiz-answer/quiz-answer');
    await sleep(2000);
  }],
  ['08-quiz-result-100', async (mini) => {
    await cmd(() => mini.switchTab('/pages/quiz/quiz'), 'switchTab quiz 08', 2);
    const quiz = await waitPath(mini, 'pages/quiz/quiz');
    console.log('08: on quiz page');
    await ensureQuizFresh(mini, quiz);
    await cmd(() => quiz.callMethod('handleStart'), 'handleStart 08', 2);
    await sleep(1500); // navigateTo 压栈动画完成后再取句柄，否则桥报 not on top
    await answerAll(mini, false);
  }],
  ['09-quiz-result-0', async (mini) => {
    await cmd(() => mini.switchTab('/pages/quiz/quiz'), 'switchTab quiz back', 2);
    const quiz = await waitPath(mini, 'pages/quiz/quiz');
    await ensureQuizFresh(mini, quiz);
    await cmd(() => quiz.callMethod('handleStart'), 'handleStart 2nd', 2);
    await answerAll(mini, true);
  }],
  ['10-rank', async (mini) => {
    await cmd(() => mini.switchTab('/pages/rank/rank'), 'switchTab rank', 2);
    await sleep(2500);
  }],
  ['11-mine', async (mini) => {
    await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine', 2);
    await sleep(2200);
  }],
  ['12-sport-records', async (mini) => {
    await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine 12', 2);
    const mine = await waitPath(mini, 'pages/mine/mine');
    await cmd(() => mine.callMethod('goSportRecords'), 'goSportRecords', 2);
    await waitPath(mini, 'pages/sport-records/sport-records');
    await sleep(1800);
  }],
  ['13-quiz-records', async (mini) => {
    await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine 13', 2);
    const mine = await waitPath(mini, 'pages/mine/mine');
    await cmd(() => mine.callMethod('goQuizRecords'), 'goQuizRecords', 2);
    await waitPath(mini, 'pages/quiz-records/quiz-records');
    await sleep(1800);
  }],
  ['14-medals', async (mini) => {
    await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine 14', 2);
    const mine = await waitPath(mini, 'pages/mine/mine');
    await cmd(() => mine.callMethod('goMedals'), 'goMedals', 2);
    await waitPath(mini, 'pages/medals/medals');
    await sleep(1800);
  }],
  // 未登录深链（修复后行为）：401 → request.js 清理登录态并跳登录页，截图即证据
  // 深链导航走 evaluate 内 app 侧 wx.reLaunch（桥 reLaunch 命令丢响应会楔死导航串行化）
  ['15-deeplink-quiz-result', async (mini) => {
    await resetAuth(mini);
    await cmd(() => mini.evaluate(() => wx.reLaunch({ url: '/pages/quiz-result/quiz-result' })), 'app reLaunch quiz-result deeplink', 2);
    await sleep(2500);
  }],
  ['16-deeplink-quiz-answer', async (mini) => {
    await resetAuth(mini);
    await cmd(() => mini.evaluate(() => wx.reLaunch({ url: '/pages/quiz-answer/quiz-answer' })), 'app reLaunch quiz-answer deeplink', 2);
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
      await setup(mini);
      if (await shot(mini, name)) done.push(name); else missing.push(name);
    } catch (e) {
      console.log('STATE ' + name + ' FAIL: ' + e.message);
      missing.push(name);
    }
    try { if (mini) await withTimeout(mini.disconnect(), 6000, 'disconnect'); } catch (e) { /* ignore */ }
    // 截图后自动化桥需更长冷却：实测紧邻的下一状态会 currentPage 失败，约一个状态周期后自愈
    await sleep(15000);
  }
  // 收尾：清登录态回登录页
  try {
    const mini = await connectMini();
    await resetAuth(mini);
    await mini.reLaunch('/pages/login/login').catch(() => {});
    await withTimeout(mini.disconnect(), 6000, 'disconnect-final');
  } catch (e) { /* ignore */ }
  console.log('===== TOUR DONE ===== 通过 ' + done.length + '/' + STATES.length +
    (missing.length ? '；缺失: ' + missing.join(',') : ''));
  process.exit(missing.length ? 1 : 0);
})().catch((e) => { console.log('TOUR CRASH: ' + e.message); process.exit(2); });
