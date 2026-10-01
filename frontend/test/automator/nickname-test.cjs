/**
 * 昵称功能小程序自动化测试（微信开发者工具 automator）
 * 覆盖：微信名称直接登录 -> mine 页修改昵称（成功一次） -> 二次修改拦截 -> 退出重登昵称不被微信名覆盖
 * 前置：后端 http://127.0.0.1:8010 已运行；开发者工具已开自动化端口 9420。
 * 用法：node nickname-test.cjs
 * 结果：stdout PASS/FAIL + results-nickname.json
 */
const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS_ENDPOINT = 'ws://127.0.0.1:9420';
const ORG_PAGE = 'pages/org-select/org-select';
const CMD_TIMEOUT = 20000;
const WECHAT_NAME = '微信昵称甲';
const NEW_NAME = '新昵称乙';
const RESULTS_FILE = path.join(__dirname, 'results-nickname.json');

const results = [];
let mini = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(p, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('命令超时(' + ms + 'ms): ' + label)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
}

function record(id, name, pass, detail) {
  results.push({ id, name, pass: !!pass, detail: String(detail == null ? '' : detail).slice(0, 500) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + (detail ? ' | ' + detail : ''));
}

let cmdChain = Promise.resolve();
function cmd(fn, desc, retries = 2) {
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
    if (Date.now() - start > timeout) throw new Error('等待页面超时: ' + pathPrefix);
    await sleep(300);
  }
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

async function data(page, key) {
  return waitFor(async () => {
    const d = await cmd(() => page.data(), 'page.data');
    return key ? d[key] : d;
  }, 10000, 400, 'data.' + (key || '*'));
}

async function getEls(page, selector) {
  return cmd(() => page.$$(selector), '$$ ' + selector);
}

async function attr(el, name) {
  return cmd(() => el.attribute(name), 'attribute ' + name, 1);
}

async function text(el) {
  return cmd(() => el.text(), 'text', 1);
}

async function tapEl(el, desc) {
  return cmd(() => el.tap(), 'tap ' + (desc || ''), 1);
}

async function checkWithTimeout(fn, timeout) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return true;
    } catch (e) { /* retry */ }
    if (Date.now() - start > timeout) return false;
    await sleep(400);
  }
}

async function globalUserOrgId() {
  return cmd(() => mini.evaluate(() => {
    const u = getApp().globalData.user;
    return u && u.orgId != null ? u.orgId : null;
  }), 'evaluate userOrgId');
}

async function selectOrg(page, id) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let btns = null;
    try { btns = await getEls(page, '.org-select-btn'); } catch (e) { await sleep(1000); continue; }
    let btn = null;
    for (const b of btns) {
      if (String(await attr(b, 'data-id')) === String(id)) { btn = b; break; }
    }
    if (!btn) { console.log('selectOrg 未命中按钮，重试 ' + (attempt + 1)); await sleep(1200); continue; }
    try { await tapEl(btn, 'select#' + id); } catch (e) { /* 已派发 */ }
    if (await checkWithTimeout(async () => String(await globalUserOrgId()) === String(id), 3000)) return true;
  }
  return false;
}

async function resetAppState() {
  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) { /* ignore */ }
    return true;
  }), 'evaluate resetAppState');
}

async function ensureWxLoginMock(loginCode) {
  for (let i = 0; i < 5; i++) {
    await cmd(() => mini.mockWxMethod('login', { code: loginCode }), 'mockWxMethod login', 1).catch(() => {});
    const got = await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.login({ success: (r) => resolve(r && r.code ? r.code : 'NO_CODE'), fail: () => resolve('FAIL_BRANCH') });
    })), 'verify wx.login mock', 1).catch(() => 'EVAL_ERR');
    if (got === loginCode) return;
    console.log('wx.login mock 未生效(' + (i + 1) + '/5)，重试');
    await sleep(2000);
  }
  throw new Error('wx.login mock 反复未生效');
}

async function main() {
  console.log('== 昵称功能小程序自动化测试 ==');
  mini = await withTimeout(automator.connect({ wsEndpoint: WS_ENDPOINT }), 30000, 'automator.connect');
  const loginCode = 'nickname-auto-' + Date.now();
  await waitFor(async () => {
    try {
      const p = await withTimeout(mini.currentPage(), 8000, 'ready');
      return p && p.path ? p : null;
    } catch (e) { return null; }
  }, 60000, 2000, '自动化桥就绪');
  await ensureWxLoginMock(loginCode);

  // ---- 1. 微信名称直接登录（新用户） ----
  await resetAppState();
  await cmd(() => mini.reLaunch('/pages/login/login').catch(() => null), 'reLaunch login');
  const loginPage = await waitPage('pages/login/login');
  const tokenBefore = await cmd(() => mini.callWxMethod('getStorageSync', 'lm_auth_token'), 'token before');
  record('M01', '冷启动进入登录页', tokenBefore === '', 'token=' + JSON.stringify(tokenBefore));

  await cmd(() => loginPage.setData({ nickname: WECHAT_NAME }), 'setData nickname');
  await cmd(() => loginPage.callMethod('doLogin', ''), 'callMethod doLogin');
  const orgPage = await waitPage(ORG_PAGE);
  record('M02', '微信名称登录成功并跳转组织选择', true, 'path=' + orgPage.path);

  await sleep(600);
  if (!(await selectOrg(orgPage, 1))) throw new Error('未选中总部组织');
  await waitPage('pages/home/home');
  await sleep(800);

  // ---- 2. mine 页：显示微信名称，修改入口可用 ----
  await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine');
  const minePage = await waitPage('pages/mine/mine');
  const mUser = await data(minePage, 'user');
  record('M03', 'mine 页展示微信名称且未改名', mUser && mUser.nickname === WECHAT_NAME && !mUser.nicknameChangedAt,
    'nickname=' + (mUser && mUser.nickname) + ' changedAt=' + (mUser && mUser.nicknameChangedAt));

  const editEls = await getEls(minePage, '.mine-name-edit');
  const editText = editEls && editEls.length ? await text(editEls[0]) : '';
  record('M04', '昵称修改入口展示「修改昵称」', /修改昵称/.test(editText || ''), 'text=' + editText);

  // ---- 3. 修改昵称：成功一次 ----
  await cmd(() => mini.mockWxMethod('showModal', { confirm: true, content: NEW_NAME }), 'mock showModal confirm');
  await cmd(() => minePage.callMethod('handleEditNickname'), 'callMethod handleEditNickname');
  const afterRename = await waitFor(async () => {
    const u = await cmd(() => minePage.data('user'), 'data.user after rename', 1).catch(() => null);
    return u && u.nickname === NEW_NAME && u.nicknameChangedAt ? u : null;
  }, 15000, 500, 'nickname updated');
  record('M05', '首次修改昵称成功并记录时间', !!afterRename,
    'nickname=' + (afterRename && afterRename.nickname) + ' changedAt=' + (afterRename && afterRename.nicknameChangedAt));

  // ---- 4. 二次修改：前端入口拦截（toast 提示，不再发请求） ----
  await cmd(() => minePage.callMethod('handleEditNickname'), 'callMethod handleEditNickname again');
  await sleep(1500);
  const afterSecond = await cmd(() => minePage.data('user'), 'data.user after 2nd', 1);
  record('M06', '二次修改被拦截（昵称不变）', afterSecond && afterSecond.nickname === NEW_NAME,
    'nickname=' + (afterSecond && afterSecond.nickname));

  // ---- 5. 退出重登：登录携带微信名也不覆盖已改昵称 ----
  const logoutBtn = await waitFor(async () => cmd(() => minePage.$('.logout-btn'), '.logout-btn', 1), 8000, 400, '.logout-btn');
  await tapEl(logoutBtn, 'logout');
  await waitPage('pages/login/login', 15000);
  await cmd(() => mini.mockWxMethod('login', { code: loginCode }), 'mockWxMethod login relogin', 1).catch(() => {});
  const loginPage2 = await waitPage('pages/login/login');
  await cmd(() => loginPage2.setData({ nickname: WECHAT_NAME }), 'setData nickname relogin');
  await cmd(() => loginPage2.callMethod('doLogin', ''), 'callMethod doLogin relogin');
  await waitPage('pages/home/home');
  await sleep(800);
  await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine relogin');
  const minePage2 = await waitPage('pages/mine/mine');
  const reloginUser = await data(minePage2, 'user');
  record('M07', '重登后昵称保持改后值（登录不覆盖）', reloginUser && reloginUser.nickname === NEW_NAME && !!reloginUser.nicknameChangedAt,
    'nickname=' + (reloginUser && reloginUser.nickname));

  const editEls2 = await getEls(minePage2, '.mine-name-edit');
  const editText2 = editEls2 && editEls2.length ? await text(editEls2[0]) : '';
  record('M08', '已改名用户入口展示「已修改」', /已修改/.test(editText2 || ''), 'text=' + editText2);

  const failed = results.filter((r) => !r.pass);
  console.log('== 结果：%d 通过 / %d 失败 ==', results.length - failed.length, failed.length);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ loginCode: loginCode, results: results }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

setTimeout(() => { console.log('WATCHDOG 超时退出'); process.exit(3); }, 300000);

main().catch((e) => {
  console.error('昵称测试异常终止: ' + (e && e.message || e));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ error: String(e && e.message || e), results: results }, null, 2));
  process.exit(2);
});
