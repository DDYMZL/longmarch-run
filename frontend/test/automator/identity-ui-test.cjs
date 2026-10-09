/**
 * 批次5 身份关联小程序自动化测试（微信开发者工具 automator，断言阶段）
 * 覆盖：bind 页无效场景/绑定确认（B 场景）/登录确认未授权拒绝/授权后确认成功/取消、
 *       未登录扫码跳登录并 redirect 返回、account 页身份列表/解绑/空态。
 * 前置：后端 http://127.0.0.1:8010 已运行；fixtures-identity.json 已生成；
 *       开发者工具已开自动化端口 9420；环境变量 SUPER_TOKEN 为超管令牌。
 * 用法：node identity-ui-test.cjs
 * 结果：stdout PASS/FAIL + results-identity.json
 */
const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS_ENDPOINT = 'ws://127.0.0.1:9420';
const API_BASE = 'http://127.0.0.1:8010';
const CMD_TIMEOUT = 20000;
const RESULTS_FILE = path.join(__dirname, 'results-identity.json');
const FIXTURES_FILE = path.join(__dirname, 'fixtures-identity.json');

const results = [];
let mini = null;
let uid = null;
let userToken = '';
let fixtures = {};
const SUPER_TOKEN = process.env.SUPER_TOKEN || '';

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
        const retriable = /timeout|超时|ETIMEDOUT|socket|ECONN|disconnect/i.test((e && e.message) || String(e));
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

async function api(method, url, body, token) {
  const res = await fetch(API_BASE + url, {
    method: method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}
    ),
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* 非 JSON */ }
  return { status: res.status, data: json };
}

/** 创建登录场景（L），返回 scene 明文 */
async function createLoginScene() {
  const r = await api('POST', '/api/admin/wechat/qr', {});
  if (r.status !== 200 || !r.data || !r.data.scene) throw new Error('创建扫码会话失败: ' + r.status);
  return r.data.scene;
}

/** 进入 bind 页并等待数据状态 */
async function openBind(scene) {
  await cmd(() => mini.reLaunch('/pages/bind/bind?scene=' + encodeURIComponent(scene)).catch(() => null), 'reLaunch bind');
  return waitPage('pages/bind/bind');
}

async function main() {
  console.log('== 身份关联（bind/account）小程序自动化测试 ==');
  fixtures = JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf-8'));
  mini = await withTimeout(automator.connect({ wsEndpoint: WS_ENDPOINT }), 30000, 'automator.connect');
  await waitFor(async () => {
    try {
      const p = await withTimeout(mini.currentPage(), 8000, 'ready');
      return p && p.path ? p : null;
    } catch (e) { return null; }
  }, 60000, 2000, '自动化桥就绪');

  // ---- 0. 登录态准备：未登录则走微信登录（并确保已选组织） ----
  let state = await cmd(() => mini.evaluate(() => ({
    loggedIn: !!(getApp().globalData.loggedIn),
    user: getApp().globalData.user || null,
    token: wx.getStorageSync('lm_auth_token') || ''
  })), 'evaluate state');
  if (!state.loggedIn || !state.token) {
    const loginCode = 'identity-auto-' + Date.now();
    await cmd(() => mini.mockWxMethod('login', { code: loginCode }), 'mockWxMethod login');
    await cmd(() => mini.reLaunch('/pages/login/login').catch(() => null), 'reLaunch login');
    const loginPage = await waitPage('pages/login/login');
    await cmd(() => loginPage.callMethod('doLogin', ''), 'callMethod doLogin');
    await sleep(1500);
    const cur = await cmd(() => mini.currentPage(), 'currentPage after login');
    if (cur && cur.path === 'pages/org-select/org-select') {
      // 无组织的新用户先选总部组织
      await sleep(800);
      await cmd(() => cur.callMethod('confirmSelect', 1), 'callMethod confirmSelect');
      await waitPage('pages/home/home');
    }
    state = await cmd(() => mini.evaluate(() => ({
      loggedIn: !!(getApp().globalData.loggedIn),
      user: getApp().globalData.user || null,
      token: wx.getStorageSync('lm_auth_token') || ''
    })), 'evaluate state 2');
  }
  uid = state.user && state.user.id;
  userToken = state.token;
  record('I00', '登录态就绪（已登录且已选组织）', !!(state.loggedIn && state.user && state.user.orgId != null && userToken),
    'uid=' + uid + ' org=' + (state.user && state.user.orgId));

  // ---- 1. 无效场景 -> 错误态 ----
  const errPage = await openBind('XXX-invalid-scene');
  const errData = await data(errPage, 'phase');
  const errTitle = (await data(errPage, 'errorTitle')) || '';
  record('I01', '无效场景展示错误态', errData === 'error' && /无效/.test(errTitle), 'title=' + errTitle);

  // ---- 2. 绑定确认（B 场景） ----
  const bindPage = await openBind(fixtures.bindSceneAssert);
  const bd = await data(bindPage, null);
  record('I02', 'B 场景渲染绑定确认卡片', bd.phase === 'confirm' && bd.mode === 'bind' && bd.confirmText === '确认绑定',
    'phase=' + bd.phase + ' mode=' + bd.mode);
  await cmd(() => bindPage.callMethod('handleConfirm'), 'callMethod handleConfirm bind');
  const bd2 = await waitFor(async () => {
    const d = await cmd(() => bindPage.data(), 'bind data after confirm', 1).catch(() => null);
    return d && d.phase === 'done' ? d : null;
  }, 15000, 400, 'bind done');
  record('I03', '确认绑定成功进入完成态', bd2.phase === 'done' && bd2.resultTitle === '已完成',
    'title=' + bd2.resultTitle);

  // ---- 3. 账号与绑定：列表 / 解绑 / 空态 ----
  await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine');
  const minePage = await waitPage('pages/mine/mine');
  let tapped = false;
  const menuItems = await cmd(() => minePage.$$('.menu-item'), '$$ .menu-item');
  for (const el of menuItems) {
    const t = await cmd(() => el.text(), 'menu text', 1).catch(() => '');
    if (/账号与绑定/.test(t)) {
      await cmd(() => el.tap(), 'tap 账号与绑定', 1);
      tapped = true;
      break;
    }
  }
  record('I04', 'mine 页存在「账号与绑定」入口并可进入', tapped);
  const accountPage = await waitPage('pages/account/account');
  const acc = await data(accountPage, null);
  record('I05', '身份列表展示绑定结果（wx_web 已验证、可解绑）',
    Array.isArray(acc.identities) && acc.identities.length === 1 &&
    acc.identities[0].provider === 'wx_web' && !acc.identities[0].isPrimary && !!acc.identities[0].verifiedAt,
    'count=' + (acc.identities ? acc.identities.length : 'none'));

  await cmd(() => mini.mockWxMethod('showModal', { confirm: true }), 'mock showModal confirm');
  const unbindEl = await waitFor(async () => cmd(() => accountPage.$('.identity-unbind'), '.identity-unbind', 1), 8000, 400, '.identity-unbind');
  await cmd(() => unbindEl.tap(), 'tap 解绑', 1);
  const acc2 = await waitFor(async () => {
    const d = await cmd(() => accountPage.data(), 'account data after unbind', 1).catch(() => null);
    return d && d.empty === true ? d : null;
  }, 15000, 500, 'account empty after unbind');
  record('I06', '解绑成功后列表进入空态', acc2.empty === true && (!acc2.identities || acc2.identities.length === 0),
    'empty=' + acc2.empty);

  // ---- 4. 登录确认：无授权用户被拒 ----
  const lScene1 = await createLoginScene();
  const denyPage = await openBind(lScene1);
  const dd = await data(denyPage, null);
  record('I07', 'L 场景渲染登录确认卡片', dd.phase === 'confirm' && dd.mode === 'login' && dd.confirmText === '确认登录',
    'phase=' + dd.phase + ' mode=' + dd.mode);
  await cmd(() => denyPage.callMethod('handleConfirm'), 'callMethod handleConfirm deny');
  const dd2 = await waitFor(async () => {
    const d = await cmd(() => denyPage.data(), 'bind data after deny', 1).catch(() => null);
    return d && d.phase === 'error' ? d : null;
  }, 15000, 400, 'deny error state');
  record('I08', '无后台权限确认被拒并展示原因', dd2.phase === 'error' && /未获授权/.test(dd2.errorTitle || ''),
    'title=' + dd2.errorTitle + ' desc=' + dd2.errorDesc);

  // ---- 5. 授权后确认成功（SUPER 经 API 授予/回收 operator 角色） ----
  if (!SUPER_TOKEN) throw new Error('缺少 SUPER_TOKEN 环境变量');
  const rolesRes = await api('GET', '/api/admin/roles', null, SUPER_TOKEN);
  const operator = (rolesRes.data.items || []).find((r) => r.code === 'operator');
  if (!operator) throw new Error('未找到 operator 角色');
  let g = await api('POST', '/api/admin/users/' + uid + '/roles', { role_ids: [operator.id] }, SUPER_TOKEN);
  record('I09', 'API 授予 operator 角色', g.status === 200, 'status=' + g.status);

  const lScene2 = await createLoginScene();
  const okPage = await openBind(lScene2);
  await waitFor(async () => {
    const d = await cmd(() => okPage.data(), 'okPage data', 1).catch(() => null);
    return d && d.phase === 'confirm' ? d : null;
  }, 10000, 400, 'okPage confirm');
  await cmd(() => okPage.callMethod('handleConfirm'), 'callMethod handleConfirm allow');
  const ok2 = await waitFor(async () => {
    const d = await cmd(() => okPage.data(), 'okPage data after allow', 1).catch(() => null);
    return d && d.phase === 'done' ? d : null;
  }, 15000, 400, 'allow done');
  record('I10', '有权限确认登录成功进入完成态', ok2.phase === 'done' && ok2.resultTitle === '已完成',
    'title=' + ok2.resultTitle);

  g = await api('POST', '/api/admin/users/' + uid + '/roles', { role_ids: [] }, SUPER_TOKEN);
  record('I11', 'API 回收角色（清理）', g.status === 200, 'status=' + g.status);

  // ---- 6. 未登录扫码 -> 登录页 redirect 返回 -> 取消路径 ----
  const lScene3 = await createLoginScene();
  const loginCode2 = 'identity-auto-' + Date.now();
  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) { /* ignore */ }
    return true;
  }), 'evaluate logout');
  await cmd(() => mini.mockWxMethod('login', { code: loginCode2 }), 'mockWxMethod login redirect');
  await cmd(() => mini.reLaunch('/pages/bind/bind?scene=' + encodeURIComponent(lScene3)).catch(() => null), 'reLaunch bind unlogged');
  await waitPage('pages/login/login');
  record('I12', '未登录扫码跳转登录页', true, 'path=pages/login/login');
  const loginPage2 = await waitPage('pages/login/login');
  await cmd(() => loginPage2.callMethod('doLogin', ''), 'callMethod doLogin redirect');
  const bindBack = await waitPage('pages/bind/bind');
  const backData = await waitFor(async () => {
    const d = await cmd(() => bindBack.data(), 'bindBack data', 1).catch(() => null);
    return d && d.phase === 'confirm' ? d : null;
  }, 15000, 400, 'bindBack confirm');
  record('I13', '登录后 redirect 返回扫码确认页', backData.phase === 'confirm' && backData.mode === 'login',
    'phase=' + backData.phase);
  await cmd(() => bindBack.callMethod('handleCancel'), 'callMethod handleCancel');
  const cancelData = await waitFor(async () => {
    const d = await cmd(() => bindBack.data(), 'bindBack data after cancel', 1).catch(() => null);
    return d && d.phase === 'done' ? d : null;
  }, 15000, 400, 'cancel done');
  record('I14', '取消操作进入已取消完成态', cancelData.phase === 'done' && cancelData.resultTitle === '已取消',
    'title=' + cancelData.resultTitle);

  const failed = results.filter((r) => !r.pass);
  console.log('== 结果：%d 通过 / %d 失败 ==', results.length - failed.length, failed.length);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ results: results }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

setTimeout(() => { console.log('WATCHDOG 超时退出'); process.exit(3); }, 420000);

main().catch((e) => {
  console.error('身份关联测试异常终止: ' + (e && e.message || e));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ error: String((e && e.message) || e), results: results }, null, 2));
  process.exit(2);
});
