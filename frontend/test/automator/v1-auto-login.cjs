/**
 * V1.0 扫码入驻自动登录 · 开发者工具端到端校验（真实 wx.login + 本地后端）。
 * 前置：后端 8010 运行；IDE 以 `cli.bat auto --project D:/project/longmarch-run --auto-port 9420` 打开。
 * 运行（cwd=frontend/test/automator）：node v1-auto-login.cjs
 */
const fs = require('fs');
const path = require('path');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function waitPath(mini, target, timeoutMs) {
  const end = Date.now() + (timeoutMs || 15000);
  let last = '';
  while (Date.now() < end) {
    try {
      const page = await mini.currentPage();
      last = page ? page.path : '';
      if (last === target) return page;
    } catch (e) {
      last = 'err:' + e.message;
    }
    await sleep(500);
  }
  throw new Error('未到达 ' + target + '，当前 ' + last + ' 栈=' + (await mini.evaluate(() => getCurrentPages().map((x) => x.route).join(',')).catch(() => '?')));
}

const readState = (mini) =>
  mini.evaluate(() => ({
    token: wx.getStorageSync('lm_auth_token') || '',
    user: wx.getStorageSync('lm_login_user') || null,
    loggedOut: !!wx.getStorageSync('lm_logged_out'),
    loggedIn: getApp().globalData.loggedIn
  }));

/** 模拟冷启动：清空内存登录态后经启动页进入（Storage 保留，与真实重开小程序一致）。 */
async function coldStart(mini) {
  await mini.evaluate(() => {
    getApp().globalData.user = null;
    getApp().globalData.loggedIn = false;
    return true;
  });
  await mini.reLaunch('/pages/launch/launch?scene=src%3Donboard');
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail });
    console.log('PASS', name, '|', detail || '');
  } catch (e) {
    results.push({ name, pass: false, detail: e.message });
    console.log('FAIL', name, '|', e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const mask = (t) => (t ? t.slice(0, 8) + '…' + t.slice(-6) : '');

(async () => {
  const mini = await automator.connect({ wsEndpoint: WS });
  mini.on('exception', (e) => console.log('exception:', e.message));
  let first = null;

  await check('E1 新用户首次扫码（无本地数据）→ 自动登录直达首页，不跳组织选择', async () => {
    await mini.evaluate(() => { wx.clearStorageSync(); return true; });
    await coldStart(mini);
    const home = await waitPath(mini, 'pages/home/home', 20000);
    first = await readState(mini);
    assert(first.token && first.user && first.user.id && first.loggedIn, '未写入登录态');
    await sleep(2500);
    const d = await home.data();
    return 'userId=' + first.user.id + ' orgId=' + first.user.orgId + ' token=' + mask(first.token) + ' 组织引导卡=' + !!(d.orgChecked && !d.orgName);
  });

  await check('E2 重新打开（Token 有效）→ 后端校验通过直达首页，不换 Token', async () => {
    await coldStart(mini);
    await waitPath(mini, 'pages/home/home', 20000);
    const s = await readState(mini);
    assert(s.loggedIn && s.token === first.token && s.user.id === first.user.id, 'Token 不应变化');
    return 'token 未变 userId=' + s.user.id;
  });

  await check('E3 Token 过期/无效 → 启动页自动 wx.login 重登，复用同一用户', async () => {
    await mini.evaluate(() => { wx.setStorageSync('lm_auth_token', 'expired.invalid.token'); return true; });
    await coldStart(mini);
    await waitPath(mini, 'pages/home/home', 20000);
    const s = await readState(mini);
    assert(s.loggedIn && s.token && s.token !== 'expired.invalid.token' && s.user.id === first.user.id, '未换新 Token 或用户变化');
    first = s;
    return '新 token=' + mask(s.token) + ' userId 不变=' + s.user.id;
  });

  await check('E4 使用中 Token 失效 → 业务请求 401 静默重登并重试，停留当前页', async () => {
    const home = await mini.currentPage();
    await mini.evaluate(() => { wx.setStorageSync('lm_auth_token', 'expired.during.use'); return true; });
    await home.callMethod('refreshAll');
    await sleep(4000);
    const s = await readState(mini);
    const page = await mini.currentPage();
    assert(page.path === 'pages/home/home', '不应跳转，当前 ' + page.path);
    assert(s.loggedIn && s.token !== 'expired.during.use' && s.user.id === first.user.id, '未静默重登');
    return '停留首页 新 token=' + mask(s.token);
  });

  await check('E5 主动退出登录 → 重开小程序进入登录页，不被静默登录', async () => {
    await mini.evaluate(() => { getApp().logout(); return true; });
    await coldStart(mini);
    await waitPath(mini, 'pages/login/login', 15000);
    const s = await readState(mini);
    assert(!s.token && s.loggedOut && !s.loggedIn, '退出后不应有 Token');
    return '停留登录页 loggedOut=' + s.loggedOut;
  });

  await check('E6 登录页手动登录 → 同一用户、清除退出标记，此后重开恢复自动登录', async () => {
    const page = await mini.currentPage();
    await page.callMethod('doLogin', '');
    await waitPath(mini, 'pages/home/home', 20000);
    let s = await readState(mini);
    assert(s.loggedIn && s.user.id === first.user.id && !s.loggedOut, '手动登录失败');
    await coldStart(mini);
    await waitPath(mini, 'pages/home/home', 20000);
    s = await readState(mini);
    assert(s.loggedIn, '重开未自动登录');
    return 'userId=' + s.user.id;
  });

  const passed = results.filter((r) => r.pass).length;
  console.log('\n== V1.0 自动登录 E2E: ' + passed + '/' + results.length + ' 通过 ==');
  fs.writeFileSync(path.join(__dirname, 'results-v1-auto-login.json'), JSON.stringify(results, null, 2));
  await mini.disconnect();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error('E2E FAIL:', e.message);
  process.exit(1);
});
