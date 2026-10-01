/**
 * 小程序全功能自动化测试（微信开发者工具 automator）— 分阶段 + 硬超时版
 *
 * 长会话自动化会阻塞 IDE 自动化桥，且被阻塞的命令既不返回也不reject，
 * 因此：每条 automator 命令都套 20s 硬超时；每阶段设全局看门狗，
 * 超时强制落盘 results-pN.json（带 hung 标记）后退出，便于外层重试。
 *
 *   node ui-test.cjs 1    登录 + 组织选择 + 首页运动
 *   node ui-test.cjs 2    长征路线 + 节点详情
 *   node ui-test.cjs 3    每日答题（满分 / 重置 / 零分）
 *   node ui-test.cjs 4    排行榜 + 我的 + 记录页 + 勋章
 *   node ui-test.cjs 5    修改组织 + 退出登录 + 未登录深链守卫验证
 *   node ui-test.cjs merge 汇总结果
 *
 * 前置：后端 http://127.0.0.1:8010 已运行；开发者工具已开自动化端口 9420。
 * 数据环境：登录/运动/路线/答题/排行/组织/勋章/积分全部走真实后端
 * （services/*.js → request.js → FastAPI），前端无本地业务数据生成。
 * wx.login 以 mockWxMethod 固定 code：IDE 未登录微信账号时真实 wx.login 报 41002（appid missing），
 * 而后端未配微信凭证时由 code 派生 mock openid，仍走完整真实登录链路；
 * 同一套件运行内各阶段共用同一 code = 同一测试用户（阶段 1 强制换新用户）。
 * 阶段间依赖：阶段 1 完成登录与运动数据（storage 在 IDE 会话间持久），后续阶段复用登录态。
 * 各阶段可安全重跑：阶段 1 先清 storage；阶段 3 先重置今日答题；阶段 5 缺登录态时自动重登。
 */
const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

// cmd() 的 20s 超时先于 automator 内部 30s 协议超时触发时，原始 promise 变成孤儿；
// 若不接管 unhandledRejection，Node 会在协议超时回报时直接崩掉整个进程（实测发生）。
process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略，避免进程崩溃）: ' + (e && e.message ? e.message : e));
});

const WS_ENDPOINT = 'ws://127.0.0.1:9420';
const ORG_PAGE = 'pages/org-select/org-select';
const IMAGES_DIR = path.join(__dirname, '..', 'images');
const STATE_FILE = path.join(__dirname, 'state.json');
const RESULTS_FILE = path.join(__dirname, 'results.json');
const CONSOLE_FILE = path.join(__dirname, 'console-log.json');

// 后端题库（15 题，与 mock/data.js 种子一致）的 id → 正确答案（判分在服务端）
const ANSWERS = {
  1: 'B', 2: 'A', 3: 'A', 4: 'A', 5: 'A', 6: 'A', 7: 'A',
  8: 'A', 9: 'B', 10: 'A', 11: 'C', 12: 'A', 13: 'A', 14: 'A', 15: 'A'
};
const NICKNAME = '自动化测试员';
const AVATAR = 'https://example.com/auto-avatar.png';
const CMD_TIMEOUT = 20000;

const results = [];
const defects = [];
const consoleLogs = [];

let mini = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 给任何 Promise 套硬超时；unref 定时器避免拖住进程退出 */
function withTimeout(p, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('命令超时(' + ms + 'ms): ' + label)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

/**
 * 套件级登录 code：IDE 账号会话掉线时真实 wx.login 报 41002（appid missing），
 * 而后端在未配置微信凭证时由 code 稳定派生 mock openid（backend auth_service._mock_openid），
 * 故以 mockWxMethod 固定 wx.login 返回本 code，仍走完整真实后端登录链路。
 * 同一套件运行内所有阶段共用同一 code = 同一测试用户；阶段 1 强制换新（全新数据用户）。
 */
function ensureLoginCode(forceNew) {
  const state = readJson(STATE_FILE, {});
  if (forceNew || !state.loginCode) {
    state.loginCode = 'automator-' + Date.now();
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  return state.loginCode;
}

/**
 * 拦截 wx.login：返回固定 code（见 ensureLoginCode 注释）。
 * 必须在桥就绪后应用：过早应用的 mock 会随 appservice 完成 bundle 加载而被冲掉
 * （表现为 mockWxMethod 返回成功但 doLogin 时仍走真实 wx.login 报 41002）。
 * 应用后立即实测验证，未生效则重试。
 */
async function ensureWxLoginMock(loginCode) {
  for (let i = 0; i < 5; i++) {
    await cmd(() => mini.mockWxMethod('login', { code: loginCode }), 'mockWxMethod login', 1).catch(() => {});
    const got = await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.login({ success: (r) => resolve(r && r.code ? r.code : 'NO_CODE'), fail: () => resolve('FAIL_BRANCH') });
    })), 'verify wx.login mock', 1).catch(() => 'EVAL_ERR');
    if (got === loginCode) return;
    console.log('wx.login mock 未生效(' + (i + 1) + '/5): got=' + got + '，重试');
    await sleep(2000);
  }
  throw new Error('wx.login mock 反复未生效，放弃本阶段');
}

function record(id, name, pass, detail) {
  results.push({ id, name, pass: !!pass, detail: String(detail == null ? '' : detail).slice(0, 500) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + (detail ? ' | ' + detail : ''));
}

function addDefect(id, title, evidence) {
  defects.push({ id, title, evidence: String(evidence).slice(0, 800) });
  console.log('DEFECT | ' + id + ' ' + title);
}

/** 全局命令队列：automator 命令必须串行，并行请求会堵塞 IDE 自动化桥 */
let cmdChain = Promise.resolve();

function cmd(fn, desc, retries = 2) {
  // 重试必须内联在已获取的队列槽位内：若重新排队（cmdChain.then）会与自身形成循环等待而死锁
  const run = async () => {
    for (let n = 0; ; n++) {
      try {
        const r = await withTimeout(fn(), CMD_TIMEOUT, desc);
        await sleep(40);
        return r;
      } catch (e) {
        const retriable = /timeout|超时|ETIMEDOUT|socket|ECONN|disconnect/i.test(e && e.message || String(e));
        if (!retriable || n >= retries) throw e;
        console.log('retry[' + (n + 1) + '] ' + desc + ': ' + (e && e.message));
        await sleep(1500);
      }
    }
  };
  const p = cmdChain.then(run, run);
  cmdChain = p.then(() => undefined, () => undefined);
  return p;
}

async function waitPage(pathPrefix, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    let p = null;
    try { p = await withTimeout(mini.currentPage(), 8000, 'currentPage@' + pathPrefix); } catch (e) { p = null; }
    if (p && p.path && p.path.indexOf(pathPrefix) === 0) return p;
    if (Date.now() - start > timeout) {
      throw new Error('等待页面超时: ' + pathPrefix + ' 当前: ' + (p && p.path));
    }
    await sleep(300);
  }
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

async function shot(name) {
  // 实测（probe5/6 及多轮套件）：无论哪个进程调用 mini.screenshot，自动化桥都会进入
  // 退化状态——后续页面句柄操作报 not on top / 超时，甚至 currentPage 返回 null，
  // 且并非每次都恢复。正式流程内因此完全不截图，断言全部基于逻辑层数据；
  // 截图由独立的 shots-tour.cjs 在测试结束后复现各页面状态补拍。
  console.log('screenshot-skip: ' + name);
}

async function data(page, key, timeout = 8000) {
  return waitFor(async () => {
    const d = await cmd(() => page.data(), 'page.data');
    return key ? d[key] : d;
  }, timeout, 400, 'data.' + (key || '*'));
}

async function getEls(page, selector) {
  return cmd(() => page.$$(selector), '$$ ' + selector);
}

async function attr(el, name) {
  return cmd(() => el.attribute(name), 'attribute ' + name, 1);
}

// tap 不重试：超时后命令可能已实际执行，重试会造成误双击
async function tapEl(el, desc) {
  return cmd(() => el.tap(), 'tap ' + (desc || ''), 1);
}

/** IDE 桥偶发使 Page 句柄失效（not on top of page stack），此时重新获取页面句柄自愈 */
async function reacquire(page, pathPrefix) {
  const top = await mini.currentPage().catch(() => null);
  console.log('句柄失效自愈: top=' + (top && top.path) + ' 重取 ' + pathPrefix);
  return waitPage(pathPrefix, 10000);
}

function tapEvent(dataset) {
  return { currentTarget: { dataset: dataset || {} }, target: { dataset: dataset || {} } };
}

/** 在时限内反复求证 effectCheck，为真即返回 true */
async function checkWithTimeout(effectCheck, ms) {
  const start = Date.now();
  for (;;) {
    try { if (await effectCheck()) return true; } catch (e) { /* 未生效继续等 */ }
    if (Date.now() - start > ms) return false;
    await sleep(300);
  }
}

/**
 * 真实点击元素后校验效果；未生效则回退 page.callMethod(处理器, 合成事件) 再校验。
 * 本 IDE 桥下 element.tap() 协议层成功但事件偶发不触发处理器，必须以效果为准。
 * reacquireFn：回退前重取页面句柄（应对 not on top of page stack）。
 */
async function tapOrCall(page, el, methodName, dataset, effectCheck, desc, reacquireFn) {
  let tapped = false;
  try {
    await tapEl(el, desc);
    tapped = true;
  } catch (e) {
    console.log('tap 异常 ' + desc + ': ' + e.message);
  }
  if (tapped && (await checkWithTimeout(effectCheck, 2500))) {
    await sleep(800); // 等待 webview 重渲染落定，紧接着的 $$ 才不会拿到旧快照
    return 'tap';
  }
  console.log('回退 callMethod ' + methodName + ' (' + desc + ')');
  if (reacquireFn) {
    try { page = await reacquireFn(); } catch (e) { /* 沿用原句柄 */ }
  }
  await cmd(() => page.callMethod(methodName, tapEvent(dataset)), 'callMethod ' + methodName, 1);
  if (await checkWithTimeout(effectCheck, 5000)) {
    await sleep(800);
    return 'callMethod';
  }
  throw new Error(desc + ' 点击后效果未生效');
}

/** 读取全局登录用户的 orgId（选定组织会同步 app.globalData.user） */
async function globalUserOrgId() {
  return cmd(() => mini.evaluate(() => {
    const u = getApp().globalData.user;
    return u && u.orgId != null ? u.orgId : null;
  }), 'evaluate userOrgId');
}

async function drill(page, id, pathPrefix) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let rows;
    try {
      rows = await getEls(page, '.org-main');
    } catch (e) {
      console.log('drill[' + id + '] getEls 失败: ' + e.message);
      // tap 派发是异步的：not on top 多为瞬态，先在同句柄上等重试，末两次才重取句柄
      if (pathPrefix && attempt >= 2) page = await reacquire(page, pathPrefix).catch(() => page);
      await sleep(1000);
      continue;
    }
    let row = null;
    for (const r of rows) {
      if (String(await attr(r, 'data-id')) === String(id)) { row = r; break; }
    }
    if (!row) {
      // DOM 快照可能滞后于 setData（逻辑层已更新），等待渲染追上
      console.log('drill[' + id + '] 第' + (attempt + 1) + '轮未命中行（DOM 或滞后），等待重试');
      await sleep(1200);
      continue;
    }
    let hasChildren = true;
    try { hasChildren = String(await attr(row, 'data-has')) === 'true'; } catch (e) { /* 缺省按有下级处理 */ }
    const check = async () => String(await cmd(() => page.data('currentId'), 'data.currentId@' + id, 1)) === String(id);
    return tapOrCall(page, row, 'onTapRow', { id: id, has: hasChildren }, check, 'org-main#' + id,
      () => reacquire(page, pathPrefix));
  }
  return false;
}

async function selectOrg(page, id, pathPrefix) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let btns;
    try {
      btns = await getEls(page, '.org-select-btn');
    } catch (e) {
      console.log('selectOrg[' + id + '] getEls 失败: ' + e.message);
      if (pathPrefix && attempt >= 2) page = await reacquire(page, pathPrefix).catch(() => page);
      await sleep(1000);
      continue;
    }
    let btn = null;
    for (const b of btns) {
      if (String(await attr(b, 'data-id')) === String(id)) { btn = b; break; }
    }
    if (!btn) {
      console.log('selectOrg[' + id + '] 第' + (attempt + 1) + '轮未命中按钮（DOM 或滞后），等待重试');
      await sleep(1200);
      continue;
    }
    const check = async () => String(await globalUserOrgId()) === String(id);
    return tapOrCall(page, btn, 'onTapSelect', { id: id }, check, 'select#' + id,
      () => reacquire(page, pathPrefix));
  }
  return false;
}

/** 校验当前栈顶页面是否到达 pathPrefix */
function navCheck(pathPrefix) {
  return async () => {
    const p = await mini.currentPage().catch(() => null);
    return !!(p && p.path && p.path.indexOf(pathPrefix) === 0);
  };
}

/** 在 quiz-answer 页回答当前题，并点下一题/提交 */
async function answerCurrent(page, wantCorrect, pathPrefix) {
  const qid = await waitFor(async () => {
    const d = await cmd(() => page.data('current'), 'data.current');
    return d && d.id ? d.id : null;
  }, 8000, 400, 'current.id');

  const correct = ANSWERS[qid];
  const options = await getEls(page, '.option');
  if (!options || !options.length) throw new Error('题目 ' + qid + ' 未找到选项元素');

  const labels = [];
  for (const opt of options) labels.push(await attr(opt, 'data-label'));
  let targetLabel = null;
  for (let i = 0; i < labels.length; i++) {
    if (wantCorrect ? labels[i] === correct : labels[i] !== correct) { targetLabel = labels[i]; break; }
  }
  if (!targetLabel) throw new Error('题目 ' + qid + ' 未找到目标选项');

  for (let i = 0; i < options.length; i++) {
    if (labels[i] === targetLabel) {
      await tapOrCall(page, options[i], 'handleSelect', { label: targetLabel },
        async () => String(await cmd(() => page.data('selected'), 'data.selected', 1)) === String(targetLabel),
        'option ' + targetLabel, pathPrefix ? () => reacquire(page, pathPrefix) : null);
      break;
    }
  }
  await sleep(300);
  const idxBefore = await cmd(() => page.data('currentIndex'), 'currentIndex', 1);
  const nextBtn = await waitFor(async () => cmd(() => page.$('.next-btn'), '$ .next-btn', 1), 8000, 400, '.next-btn');
  await tapOrCall(page, nextBtn, 'handleNext', {}, async () => {
    const d = await cmd(() => page.data('currentIndex'), 'currentIndex2', 1).catch(() => null);
    if (d == null || d !== idxBefore) return true;
    return navCheck('pages/quiz-result/quiz-result')();
  }, 'next-btn#' + qid, pathPrefix ? () => reacquire(page, pathPrefix) : null);
  return qid;
}

/** 确保已登录：storage 有 token 则直接用；否则重新走登录 + 选总部 */
async function ensureLoggedIn() {
  const token = await cmd(() => mini.callWxMethod('getStorageSync', 'lm_auth_token'), 'getStorage token');
  if (token && String(token).length > 10) {
    await cmd(() => mini.switchTab('/pages/home/home').catch(() => null), 'switchTab home', 1);
    await waitPage('pages/home/home', 10000).catch(() => null);
    return 'existing';
  }
  await cmd(() => mini.callWxMethod('clearStorageSync'), 'clearStorageSync relogin');
  await resetAppState();
  await cmd(() => mini.reLaunch('/pages/login/login').catch(() => null), 'reLaunch login relogin');
  const loginPage = await waitPage('pages/login/login', 20000);
  await cmd(() => loginPage.setData({ nickname: NICKNAME }), 'setData nickname relogin');
  await cmd(() => loginPage.callMethod('doLogin', AVATAR), 'callMethod doLogin relogin');
  const orgPage = await waitPage('pages/org-select/org-select');
  await sleep(600);
  if (!(await selectOrg(orgPage, 1, ORG_PAGE))) throw new Error('重登时未找到总部选定按钮');
  await waitPage('pages/home/home');
  return 'fresh';
}

/** 重置登录态：必须同时清 storage 与 app.globalData 内存态（login.onLoad 只看内存态） */
async function resetAppState() {
  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) { /* ignore */ }
    return true;
  }), 'evaluate resetAppState');
}

async function connectAndListen(loginCode) {
  console.log('连接 ' + WS_ENDPOINT + ' ...');
  mini = await withTimeout(automator.connect({ wsEndpoint: WS_ENDPOINT }), 30000, 'automator.connect');
  mini.on('console', (msg) => {
    let args = [];
    try {
      args = (msg.args || []).map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      });
    } catch (e) { /* ignore */ }
    consoleLogs.push({ ts: Date.now(), phase: process.argv[2], type: msg.type, args: args.join(' ').slice(0, 1000) });
  });
  mini.on('exception', (err) => {
    consoleLogs.push({ ts: Date.now(), phase: process.argv[2], type: 'exception', args: ((err && (err.message + '\n' + err.stack)) || String(err)).slice(0, 1500) });
  });
  await waitFor(async () => {
    try {
      const p = await withTimeout(mini.currentPage(), 8000, 'currentPage ready-check');
      return p && p.path ? p : null;
    } catch (e) { return null; }
  }, 60000, 2000, '自动化桥就绪');
  // 桥就绪（appservice bundle 已加载）后再 mock，避免被启动过程冲掉
  await ensureWxLoginMock(loginCode);
}

/* ================= 阶段 1：登录 + 组织 + 首页运动 ================= */
async function phase1() {
  await sleep(1000);
  let loginPage = null;
  for (let attempt = 1; attempt <= 3 && !loginPage; attempt++) {
    await resetAppState();
    await cmd(() => mini.reLaunch('/pages/login/login').catch(() => null), 'reLaunch login');
    try {
      loginPage = await waitPage('pages/login/login', 20000);
    } catch (e) {
      console.log('T01 第 ' + attempt + ' 次尝试未落到登录页，重试... (' + e.message + ')');
    }
  }
  if (!loginPage) throw new Error('无法回到登录页');
  const tokenCheck = await cmd(() => mini.callWxMethod('getStorageSync', 'lm_auth_token'), 'getStorage token');
  record('T01', '冷启动进入登录页', tokenCheck === '', 'path=' + loginPage.path + ' token=' + JSON.stringify(tokenCheck));
  await shot('01-login');

  await cmd(() => loginPage.setData({ nickname: NICKNAME }), 'setData nickname');
  // 绕过 chooseAvatar 原生头像选择，直接调用 doLogin（与 onChooseAvatar 同一入口），走真实后端 /auth/login
  await cmd(() => loginPage.callMethod('doLogin', AVATAR), 'callMethod doLogin');
  let orgPage = await waitPage('pages/org-select/org-select');
  record('T02', '登录成功并跳转组织选择', true, 'path=' + orgPage.path);
  await shot('02-org-select');

  const stack0 = await data(orgPage, 'stack');
  const list0 = await data(orgPage, 'list');
  record('T03a', '组织根层级加载', list0 && list0.length === 1 && list0[0].name === '长征集团总部' && (!stack0 || stack0.length === 0),
    '根层级=' + (list0 || []).map((o) => o.name).join(','));

  if (!(await drill(orgPage, 1, ORG_PAGE))) throw new Error('未找到长征集团总部节点');
  await sleep(500);
  if (!(await drill(orgPage, 2, ORG_PAGE))) throw new Error('未找到华东分公司节点');
  await sleep(500);
  const list1 = await data(orgPage, 'list');
  const stack1 = await data(orgPage, 'stack');
  record('T03b', '下钻总部→华东分公司', list1 && list1.length === 3 && stack1 && stack1.length === 2,
    '第二层=' + (list1 || []).map((o) => o.name).join(','));

  if (!(await drill(orgPage, 6, ORG_PAGE))) throw new Error('未找到技术部节点');
  await sleep(500);
  const list2 = await data(orgPage, 'list');
  record('T03c', '下钻技术部', list2 && list2.length === 2, '第三层=' + (list2 || []).map((o) => o.name).join(','));

  orgPage = await reacquire(orgPage, ORG_PAGE);
  const crumbs = await getEls(orgPage, '.crumb');
  const crumbCheck = async () => {
    const d = await cmd(() => orgPage.data(), 'data crumb-check', 1);
    return !d.currentId && d.list && d.list.length === 1 && d.list[0].name === '长征集团总部';
  };
  await tapOrCall(orgPage, crumbs[0], 'onTapCrumb', { index: -1 }, crumbCheck, 'crumb 全部组织',
    () => reacquire(orgPage, ORG_PAGE));
  orgPage = await reacquire(orgPage, ORG_PAGE);
  const listAfterCrumb = await data(orgPage, 'list');
  record('T03d', '面包屑回跳根层级', listAfterCrumb && listAfterCrumb.length === 1 && listAfterCrumb[0].name === '长征集团总部',
    '回跳后=' + (listAfterCrumb || []).map((o) => o.name).join(','));
  await drill(orgPage, 1, ORG_PAGE); await sleep(400);
  await drill(orgPage, 2, ORG_PAGE); await sleep(400);
  await drill(orgPage, 6, ORG_PAGE); await sleep(400);

  if (!(await selectOrg(orgPage, 12, ORG_PAGE))) throw new Error('未找到前端组的选定按钮');
  const homePage = await waitPage('pages/home/home');
  await sleep(800);
  const orgFull = await cmd(() => homePage.data('user.orgFullName'), 'data orgFullName');
  record('T03e', '选定前端组并进入首页', homePage.path === 'pages/home/home' && /前端组/.test(orgFull || ''),
    'orgFullName=' + orgFull);

  const beforeSteps = await homePage ? await cmd(() => homePage.data('todaySteps'), 'data todaySteps0') : 0;
  let syncedSteps = 0;
  let syncError = null;
  try {
    const syncBtn = await waitFor(async () => cmd(() => homePage.$('.sync-btn'), '$ .sync-btn', 1), 8000, 400, '.sync-btn');
    const syncCheck = async () => {
      const v = await cmd(() => homePage.data('todaySteps'), 'data.todaySteps', 1);
      return v > 0 ? v : null;
    };
    await tapOrCall(homePage, syncBtn, 'handleSyncSteps', {}, async () => !!(await syncCheck()), 'sync-btn',
      () => reacquire(homePage, 'pages/home/home'));
    syncedSteps = await syncCheck();
    if (!syncedSteps) {
      // 冷启动后 wx.authorize 偶发无回调，syncing 卡 true：复位后重试一次
      console.log('sync 未生效，复位 syncing 后重试');
      await cmd(() => homePage.setData({ syncing: false }), 'setData syncing=false', 1);
      await cmd(() => homePage.callMethod('handleSyncSteps'), 'callMethod handleSyncSteps retry', 2);
      await sleep(2500);
      syncedSteps = await syncCheck();
    }
    await sleep(2500);
  } catch (e) {
    syncError = e.message;
    try { syncedSteps = await cmd(() => homePage.data('todaySteps'), 'data todaySteps-fb'); } catch (e2) { syncedSteps = 0; }
  }
  const litCount = await data(homePage, 'litCount');
  const totalCount = await data(homePage, 'totalCount');
  const stepPercent = await cmd(() => homePage.data('stepPercent'), 'data stepPercent');
  const syncErrFlag = await cmd(() => homePage.data('syncError'), 'data syncError');
  record('T04a', '同步微信步数', syncedSteps > 0 && !syncError && !syncErrFlag,
    'steps=' + syncedSteps + '(before=' + beforeSteps + ') lit=' + litCount + '/' + totalCount +
    ' percent=' + stepPercent + '% syncError=' + syncErrFlag + (syncError ? ' 等待失败:' + syncError : ''));
  await shot('03-home-synced');

  const demoBtn = await waitFor(async () => cmd(() => homePage.$('.demo-btn'), '$ .demo-btn', 1), 8000, 400, '.demo-btn');
  const demoCheck = async () => {
    const v = await cmd(() => homePage.data('todaySteps'), 'data.todaySteps2', 1);
    return v >= syncedSteps + 2000 ? v : null;
  };
  await tapOrCall(homePage, demoBtn, 'handleAddSteps', {}, async () => !!(await demoCheck()), 'demo-btn',
    () => reacquire(homePage, 'pages/home/home'));
  const afterDemo = await demoCheck();
  record('T04b', '演示按钮 +2000 步', afterDemo === syncedSteps + 2000, 'steps=' + afterDemo);

  const quizBadge = await cmd(() => homePage.data('quizRemain'), 'data quizRemain');
  record('T04c', '首页今日答题入口状态', quizBadge === 5, '剩余题数=' + quizBadge);

  // 保留 ensureLoginCode 写入的 loginCode（阶段 2-5 需复用同一用户）
  const prevState = readJson(STATE_FILE, {});
  fs.writeFileSync(STATE_FILE, JSON.stringify(Object.assign({}, prevState,
    { seededSteps: syncedSteps, afterDemo, litCount, totalCount })));
}

/* ================= 阶段 2：长征路线 + 节点详情 ================= */
async function phase2() {
  await ensureLoggedIn();
  await cmd(() => mini.switchTab('/pages/march/march'), 'switchTab march');
  const marchPage = await waitPage('pages/march/march');
  await data(marchPage, 'nodes', 15000).then(async (n) => {
    if (!n || n.length !== 10) throw new Error('路线节点数量异常: ' + (n && n.length));
  });
  const mAll = await cmd(() => marchPage.data(), 'march data');
  const mNodes = mAll.nodes;
  const mMode = mAll.mode;
  const mSelected = mAll.selectedNode;
  const statusesOk = mNodes.every((n) => ['unlocked', 'current', 'completed'].indexOf(n.status) >= 0);
  record('T05a', '路线节点加载（后端 route-nodes）',
    mNodes.length === 10 && statusesOk && mNodes[0].name === '瑞金' && mNodes[9].name === '延安',
    'mode=' + mMode + ' nodes=' + mNodes.length + ' lit=' + mNodes.filter((n) => n.status === 'completed').length +
    ' selected=' + (mSelected && mSelected.name));
  await shot('04-march');

  await cmd(() => marchPage.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } }), 'switchMode canvas');
  await sleep(1500);
  const canvasMode = await cmd(() => marchPage.data('mode'), 'data mode canvas');
  record('T05b', '切换星空插画模式', canvasMode === 'canvas', 'mode=' + canvasMode);
  await shot('05-march-canvas');
  await cmd(() => marchPage.callMethod('switchMode', { currentTarget: { dataset: { mode: 'real' } } }), 'switchMode real');
  await sleep(1000);

  await cmd(() => mini.navigateTo('/pages/node-detail/node-detail?id=2'), 'navigateTo node-detail');
  const detailPage = await waitPage('pages/node-detail/node-detail');
  const dNode = await data(detailPage, 'node');
  record('T06', '节点详情页（遵义）', dNode && dNode.name === '遵义' && dNode.status,
    'name=' + (dNode && dNode.name) + ' status=' + (dNode && dNode.status));
  await shot('06-node-detail');
  await cmd(() => mini.navigateBack(), 'navigateBack');
}

/* ================= 阶段 3：每日答题 ================= */
async function phase3() {
  await ensureLoggedIn();
  await cmd(() => mini.switchTab('/pages/quiz/quiz'), 'switchTab quiz');
  const quizPage = await waitPage('pages/quiz/quiz');
  await sleep(600);

  // 重跑保护：若上次运行已完成答题，先用开发重置拿到干净的未完成态
  const completedPre = await cmd(() => quizPage.data('completed'), 'completed pre');
  if (completedPre === true) {
    console.log('prep: 检测到已完成答题，先重置');
    await cmd(() => mini.mockWxMethod('showModal', { confirm: true, cancel: false }), 'mock showModal prep');
    const resetBtnPre = await waitFor(async () => cmd(() => quizPage.$('.dev-reset'), '$ .dev-reset', 1), 8000, 400, '.dev-reset');
    await tapOrCall(quizPage, resetBtnPre, 'handleResetToday', {},
      async () => (await cmd(() => quizPage.data('completed'), 'completed prep poll', 1)) === false,
      'dev-reset prep', () => reacquire(quizPage, 'pages/quiz/quiz'));
    await waitFor(async () => {
      const c = await cmd(() => quizPage.data('completed'), 'completed prep poll');
      return c === false ? true : null; // waitFor 按真值判断，不能返回 false 本身
    }, 8000, 400, 'prep reset');
    await cmd(() => mini.restoreWxMethod('showModal'), 'restore showModal prep');
  }

  const completed0 = await cmd(() => quizPage.data('completed'), 'completed0');
  record('T07a', '答题首页未完成状态', completed0 === false, 'completed=' + completed0);

  const startBtn = await waitFor(async () => cmd(() => quizPage.$('.start-btn'), '$ .start-btn', 1), 8000, 400, '.start-btn');
  await tapOrCall(quizPage, startBtn, 'handleStart', {}, navCheck('pages/quiz-answer/quiz-answer'), 'start-btn',
    () => reacquire(quizPage, 'pages/quiz/quiz'));
  const ansPage = await waitPage('pages/quiz-answer/quiz-answer');
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(await answerCurrent(ansPage, true, 'pages/quiz-answer/quiz-answer'));
  }
  const resultPage = await waitPage('pages/quiz-result/quiz-result');
  const score = await waitFor(async () => {
    const s = await cmd(() => resultPage.data('displayScore'), 'displayScore');
    return s === 100 ? s : null;
  }, 12000, 400, 'displayScore=100');
  const rec = await cmd(() => resultPage.data('record'), 'record');
  record('T07b', '满分提交（答对 5 题）', score === 100 && rec.correctCount === 5 && rec.points === 15,
    'score=' + score + ' correct=' + rec.correctCount + '/' + rec.totalCount + ' points=' + rec.points);
  await shot('07-quiz-result-100');

  await cmd(() => mini.navigateBack(), 'navigateBack quiz');
  let quizPage2 = await waitPage('pages/quiz/quiz');
  await sleep(600);
  const recDone = await cmd(() => quizPage2.data('record'), 'record after back');
  const quizDone = await cmd(() => quizPage2.data('completed'), 'completed after back');
  record('T07c', '答题页已完成态', quizDone === true && recDone && recDone.score === 100,
    'completed=' + quizDone + ' score=' + (recDone && recDone.score) + ' correct=' + (recDone && recDone.correctCount) + '/' + (recDone && recDone.totalCount));

  await cmd(() => mini.mockWxMethod('showModal', { confirm: true, cancel: false }), 'mock showModal');
  const resetBtn = await waitFor(async () => cmd(() => quizPage2.$('.dev-reset'), '$ .dev-reset', 1), 8000, 400, '.dev-reset');
  const pollCompleted = async (tag) => {
    const c = await cmd(() => quizPage2.data('completed'), 'completed after reset ' + tag);
    console.log('reset poll[' + tag + ']: completed=' + c);
    return c === false ? true : null; // waitFor 按真值判断，不能返回 false 本身
  };
  await tapOrCall(quizPage2, resetBtn, 'handleResetToday', {},
    async () => (await cmd(() => quizPage2.data('completed'), 'completed after reset tap', 1)) === false,
    'dev-reset', () => reacquire(quizPage2, 'pages/quiz/quiz'));
  let resetOk = null;
  try {
    resetOk = await waitFor(() => pollCompleted('a'), 8000, 400, 'reset->completed=false');
  } catch (e) {
    // tap 协议层成功但处理器未消费时兜底：重取句柄直接调 handleResetToday
    console.log('reset 未生效，直接 callMethod 重试: ' + e.message);
    quizPage2 = await waitPage('pages/quiz/quiz', 8000).catch(() => quizPage2);
    await cmd(() => quizPage2.callMethod('handleResetToday', tapEvent({})), 'callMethod handleResetToday', 1);
    resetOk = await waitFor(() => pollCompleted('b'), 8000, 400, 'reset->completed=false retry');
  }
  const cAgain = await cmd(() => quizPage2.data('completed'), 'completed post-reset');
  if (cAgain !== false) {
    const recDump = await cmd(() => quizPage2.data('record'), 'record post-reset').catch(() => null);
    console.log('reset 后 completed 翻回 ' + cAgain + ' record=' + JSON.stringify(recDump));
  }
  await cmd(() => mini.restoreWxMethod('showModal'), 'restore showModal');
  record('T08a', '开发调试重置今日答题', resetOk === true && cAgain === false,
    'completed=' + cAgain + (resetOk === true ? '' : '（经 callMethod 重试生效）'));

  const startBtn2 = await waitFor(async () => cmd(() => quizPage2.$('.start-btn'), '$ .start-btn2', 1), 8000, 400, '.start-btn2');
  await tapOrCall(quizPage2, startBtn2, 'handleStart', {}, navCheck('pages/quiz-answer/quiz-answer'), 'start-btn2',
    () => reacquire(quizPage2, 'pages/quiz/quiz'));
  const ansPage2 = await waitPage('pages/quiz-answer/quiz-answer');
  for (let i = 0; i < 5; i++) await answerCurrent(ansPage2, false, 'pages/quiz-answer/quiz-answer');
  const resultPage2 = await waitPage('pages/quiz-result/quiz-result');
  const score0 = await waitFor(async () => {
    const s = await cmd(() => resultPage2.data('displayScore'), 'displayScore0');
    return s === 0 ? 'ZERO' : null; // 0 为假值，需用哨兵
  }, 12000, 400, 'displayScore=0');
  const rec0 = await cmd(() => resultPage2.data('record'), 'record0');
  record('T08b', '零分提交（全答错）', score0 === 'ZERO' && rec0.correctCount === 0 && rec0.points === 5,
    'score=0 correct=' + rec0.correctCount + ' points=' + rec0.points);
  await shot('08-quiz-result-0');
  await cmd(() => mini.navigateBack(), 'navigateBack quiz2');
  await waitPage('pages/quiz/quiz');
}

/* ================= 阶段 4：排行榜 + 我的 + 记录 + 勋章 ================= */
async function phase4() {
  await ensureLoggedIn();
  const state = readJson(STATE_FILE, {});
  const afterDemo = state.afterDemo;

  await cmd(() => mini.switchTab('/pages/rank/rank'), 'switchTab rank');
  const rankPage = await waitPage('pages/rank/rank');
  await data(rankPage, 'list', 10000);
  const rAll = await cmd(() => rankPage.data(), 'rank data');
  const rList = rAll.list;
  const myRank = rAll.myRank;
  const mySteps = rAll.mySteps;
  const total = rAll.total;
  const meEl = await cmd(() => rankPage.$('.rank-item-me'), 'rank-item-me');
  record('T09', '排行榜（真实后端总榜，当前用户在榜且高亮）',
    rList && rList.length >= 1 && !!meEl && mySteps === afterDemo && myRank >= 1 && myRank <= total && total >= 1,
    'list=' + rList.length + ' myRank=' + myRank + ' mySteps=' + mySteps + '(state=' + afterDemo + ') total=' + total + ' me高亮=' + !!meEl);
  await shot('09-rank');

  await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine');
  let minePage = await waitPage('pages/mine/mine');
  // 答题记录按日期唯一：阶段 3 的满分+零分两次作答同日，仅留 1 条记录
  await waitFor(async () => {
    const q = await cmd(() => minePage.data('quizCount'), 'mine quizCount');
    return q === 1 ? q : null;
  }, 8000, 400, 'mine quizCount=1');
  const mAll = await cmd(() => minePage.data(), 'mine data');
  record('T10a', '我的页统计一致性', mAll.totalSteps === afterDemo && mAll.quizCount === 1 && mAll.points >= 1,
    'steps=' + mAll.totalSteps + '(state=' + afterDemo + ') lit=' + mAll.litCount + ' quiz=' + mAll.quizCount + ' points=' + mAll.points);
  await shot('10-mine');

  minePage = await reacquire(minePage, 'pages/mine/mine');
  let menuItems = await getEls(minePage, '.menu-item');
  await tapOrCall(minePage, menuItems[1], 'goSportRecords', {}, navCheck('pages/sport-records/sport-records'),
    'menu 运动记录', () => reacquire(minePage, 'pages/mine/mine'));
  const sportPage = await waitPage('pages/sport-records/sport-records');
  const sTotal = await data(sportPage, 'totalSteps');
  record('T11', '运动记录页', sTotal === afterDemo, 'totalSteps=' + sTotal + '(state=' + afterDemo + ')');
  await shot('11-sport-records');
  await cmd(() => mini.navigateBack(), 'navigateBack mine1');
  minePage = await waitPage('pages/mine/mine');

  menuItems = await getEls(minePage, '.menu-item');
  await tapOrCall(minePage, menuItems[2], 'goQuizRecords', {}, navCheck('pages/quiz-records/quiz-records'),
    'menu 答题记录', () => reacquire(minePage, 'pages/mine/mine'));
  const qrecPage = await waitPage('pages/quiz-records/quiz-records');
  const qrecs = await data(qrecPage, 'records');
  record('T12', '答题记录页（同日两次作答仅留 1 条）', qrecs && qrecs.length === 1 && qrecs[0].totalCount === 5,
    'records=' + (qrecs || []).map((r) => r.date + ':' + r.score + '分').join(', '));
  await cmd(() => mini.navigateBack(), 'navigateBack mine2');
  minePage = await waitPage('pages/mine/mine');

  menuItems = await getEls(minePage, '.menu-item');
  await tapOrCall(minePage, menuItems[3], 'goMedals', {}, navCheck('pages/medals/medals'),
    'menu 我的勋章', () => reacquire(minePage, 'pages/mine/mine'));
  const medalPage = await waitPage('pages/medals/medals');
  await data(medalPage, 'medals');
  const mdAll = await cmd(() => medalPage.data(), 'medals data');
  const ownedIds = (mdAll.medals || []).filter((m) => m.owned).map((m) => m.id);
  record('T13', '勋章墙（6 枚，首步勋章必得）',
    mdAll.medals && mdAll.medals.length === 6 && mdAll.ownedCount >= 1 && ownedIds.indexOf('first-step') >= 0,
    'owned=' + mdAll.ownedCount + '/' + mdAll.totalCount + ' [' + ownedIds.join(',') + ']');
  await shot('12-medals');
  await cmd(() => mini.navigateBack(), 'navigateBack mine3');
}

/* ================= 阶段 5：修改组织 + 退出 + 深链守卫 ================= */
async function phase5() {
  await ensureLoggedIn();
  await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine p5');
  let minePage = await waitPage('pages/mine/mine', 10000);

  const orgEntry = await waitFor(async () => cmd(() => minePage.$('.mine-org'), '.mine-org', 1), 8000, 400, '.mine-org');
  await tapOrCall(minePage, orgEntry, 'goOrgSelect', {}, navCheck('pages/org-select/org-select'),
    'mine-org', () => reacquire(minePage, 'pages/mine/mine'));
  const orgPage2 = await waitPage('pages/org-select/org-select');
  await sleep(600);
  await drill(orgPage2, 1, ORG_PAGE); await sleep(500);
  await drill(orgPage2, 2, ORG_PAGE); await sleep(500);
  await drill(orgPage2, 6, ORG_PAGE); await sleep(500);
  if (!(await selectOrg(orgPage2, 13, ORG_PAGE))) {
    throw new Error('未找到后端组选定按钮（当前层级列表：' + JSON.stringify(await orgPage2.data('list')) + '）');
  }
  minePage = await waitPage('pages/mine/mine');
  await sleep(600);
  const newOrg = await cmd(() => minePage.data('user.orgFullName'), 'data orgFullName p5');
  record('T14', '我的页修改组织为后端组', /后端组/.test(newOrg || ''), 'orgFullName=' + newOrg);

  await cmd(() => mini.mockWxMethod('showModal', { confirm: true, cancel: false }), 'mock showModal2');
  const logoutBtn = await waitFor(async () => cmd(() => minePage.$('.logout-btn'), '.logout-btn', 1), 8000, 400, '.logout-btn');
  await tapOrCall(minePage, logoutBtn, 'handleLogout', {}, navCheck('pages/login/login'),
    'logout', () => reacquire(minePage, 'pages/mine/mine'));
  await waitPage('pages/login/login');
  await cmd(() => mini.restoreWxMethod('showModal'), 'restore showModal2');
  const loggedOut = await cmd(() => mini.callWxMethod('getStorageSync', 'lm_auth_token'), 'getStorage after logout');
  record('T15', '退出登录', loggedOut === '', 'token已清除=' + (loggedOut === ''));

  // 未登录深链（修复后预期）：页面数据接口返回 401 → request.js 清理登录态并 reLaunch 登录页，
  // 页面不崩溃、无 TypeError 日志
  // 深链导航必须从 app 侧发起（evaluate 内 wx.reLaunch）：automator 桥的 reLaunch 命令
  // 偶发丢响应（命令超时）会把 IDE 的导航串行化楔死，此后一切导航（含 app 侧 401 后的
  // reLaunch login）报 reLaunch:fail timeout，深链断言必然误失败（实测 probe-hook2）。
  const excBefore = consoleLogs.length;
  await cmd(() => mini.evaluate(() => wx.reLaunch({ url: '/pages/quiz-result/quiz-result' })),
    'app reLaunch deeplink result', 2);
  let p1 = null;
  try {
    p1 = await waitPage('pages/login/login', 15000);
  } catch (e) {
    try { p1 = await cmd(() => mini.currentPage(), 'currentPage deeplink1'); } catch (e2) { p1 = null; }
  }
  const crashLogs1 = consoleLogs.slice(excBefore).filter((l) => /Cannot read propert|TypeError/.test(l.args));
  record('T16a', '未登录深链答题结果页（401 自动跳回登录页，不崩溃）',
    p1 && p1.path === 'pages/login/login' && crashLogs1.length === 0,
    '最终页=' + (p1 && p1.path) + ' 崩溃日志=' + crashLogs1.length + ' 条');
  if (crashLogs1.length) {
    addDefect('F1', '未登录状态深链 quiz-result 页崩溃（登录守卫失效）',
      'reLaunch /pages/quiz-result/quiz-result 后未跳回登录页且抛 TypeError。日志：' +
      (crashLogs1[0] && crashLogs1[0].args).slice(0, 300));
  }
  await shot('13-deeplink-quiz-result');

  const excBefore2 = consoleLogs.length;
  await cmd(() => mini.evaluate(() => wx.reLaunch({ url: '/pages/quiz-answer/quiz-answer' })),
    'app reLaunch deeplink answer', 2);
  let p2 = null;
  try {
    p2 = await waitPage('pages/login/login', 15000);
  } catch (e) {
    try { p2 = await cmd(() => mini.currentPage(), 'currentPage deeplink2'); } catch (e2) { p2 = null; }
  }
  const crashLogs2 = consoleLogs.slice(excBefore2).filter((l) => /Cannot read propert|TypeError/.test(l.args));
  record('T16b', '未登录深链答题页（401 自动跳回登录页，不崩溃）',
    p2 && p2.path === 'pages/login/login' && crashLogs2.length === 0,
    '最终页=' + (p2 && p2.path) + ' 崩溃日志=' + crashLogs2.length + ' 条');
  if (crashLogs2.length) {
    addDefect('F2', '未登录状态深链 quiz-answer 页崩溃（登录守卫失效）',
      'reLaunch /pages/quiz-answer/quiz-answer 后未跳回登录页且抛 TypeError。日志：' +
      (crashLogs2[0] && crashLogs2[0].args).slice(0, 300));
  }
  await shot('14-deeplink-quiz-answer');

  await resetAppState();
  await cmd(() => mini.evaluate(() => wx.reLaunch({ url: '/pages/login/login' })), 'cleanup relaunch', 1);
  await sleep(800);
}

/* ================= 汇总 ================= */
function mergeAll() {
  const all = [];
  const allDefects = [];
  const hungPhases = [];
  for (let i = 1; i <= 5; i++) {
    const part = readJson(path.join(__dirname, 'results-p' + i + '.json'), null);
    if (part) {
      all.push(...(part.results || []));
      allDefects.push(...(part.defects || []));
      if (part.hung) hungPhases.push(i);
    }
  }
  const logs = readJson(CONSOLE_FILE, []);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({
    finishedAt: new Date().toISOString(),
    env: { backend: 'http://127.0.0.1:8010/api', devtools: 'automation ws://127.0.0.1:9420' },
    hungPhases,
    results: all, defects: allDefects
  }, null, 2));
  const failed = all.filter((r) => !r.pass);
  console.log('===== 汇总 =====');
  console.log('通过 ' + (all.length - failed.length) + '/' + all.length + '，缺陷 ' + allDefects.length + ' 个' +
    (hungPhases.length ? '，被看门狗中断的阶段: ' + hungPhases.join(',') : ''));
  failed.forEach((r) => console.log('FAILED: ' + r.id + ' ' + r.name + ' | ' + r.detail));
  allDefects.forEach((d) => console.log('DEFECT: ' + d.id + ' ' + d.title));
}

async function main() {
  const phase = process.argv[2];
  if (phase === 'merge') { mergeAll(); return; }
  if (!['1', '2', '3', '4', '5'].includes(phase)) {
    console.log('用法: node ui-test.cjs <1|2|3|4|5|merge>');
    process.exit(1);
  }
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  // 全局看门狗：任何命令挂死时强制落盘并退出（exit code 2）
  const WATCHDOG_MS = { 1: 300000, 2: 160000, 3: 280000, 4: 220000, 5: 240000 }[phase] || 200000;
  const wd = setTimeout(() => {
    console.error('WATCHDOG 触发：阶段 ' + phase + ' 超时 ' + WATCHDOG_MS + 'ms，强制落盘退出');
    try {
      fs.writeFileSync(path.join(__dirname, 'results-p' + phase + '.json'),
        JSON.stringify({ results, defects, hung: true }, null, 2));
    } catch (e) { /* ignore */ }
    try {
      const prevLogs = readJson(CONSOLE_FILE, []);
      fs.writeFileSync(CONSOLE_FILE, JSON.stringify(prevLogs.concat(consoleLogs), null, 2));
    } catch (e) { /* ignore */ }
    process.exit(2);
  }, WATCHDOG_MS);

  try {
    // 阶段 1 强制新 code（全新用户，保证断言起点干净）；后续阶段复用同一用户
    const loginCode = ensureLoginCode(phase === '1');
    await connectAndListen(loginCode);
    const fn = { 1: phase1, 2: phase2, 3: phase3, 4: phase4, 5: phase5 }[phase];
    await fn();
    console.log('===== 阶段 ' + phase + ' 完成：' +
      results.filter((r) => r.pass).length + '/' + results.length + ' 通过 =====');
  } finally {
    clearTimeout(wd);
    // 每阶段落盘（覆盖对应阶段文件），console 日志合并追加
    fs.writeFileSync(path.join(__dirname, 'results-p' + phase + '.json'), JSON.stringify({ results, defects }, null, 2));
    const prevLogs = readJson(CONSOLE_FILE, []);
    fs.writeFileSync(CONSOLE_FILE, JSON.stringify(prevLogs.concat(consoleLogs), null, 2));
    if (mini) { try { mini.disconnect(); } catch (e) { /* ignore */ } }
  }
}

main().catch((e) => {
  console.error('阶段 ' + process.argv[2] + ' 异常终止:', e && e.message || e);
  process.exit(1);
});
