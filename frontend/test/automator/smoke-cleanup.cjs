/**
 * 死代码清理回归冒烟（轻量，不重启 IDE）：
 *   验证 util.js / store.js / request.js / app.js 精简后，登录 → 选组织 → 四个 tab 页全链路无运行时报错。
 *   重点监听 console 中 is not a function / undefined 之类引用已删函数的错误。
 * 用法：cd frontend/test/automator && node smoke-cleanup.cjs
 */
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const RESULTS = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function record(id, name, ok, detail) {
  RESULTS.push({ id, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' ' + name + (detail ? ' | ' + String(detail).slice(0, 160) : ''));
}

let mini;
const pageErrors = [];

async function waitPath(path, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = await mini.currentPage().catch(() => null);
    if (p && p.path === path) return p;
    await sleep(400);
  }
  throw new Error('等待页面超时: ' + path);
}

async function main() {
  mini = await automator.connect({ wsEndpoint: WS });
  mini.on('console', (msg) => {
    const text = (msg && msg.items ? msg.items : []).map((i) => (i && i.text) || '').join(' ');
    if (/not a function|is not defined|undefined is not|Cannot read/i.test(text)) {
      pageErrors.push(text.slice(0, 200));
    }
  });

  // 1) 重置登录态 + mock 登录码
  await mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) {}
    return true;
  });
  await mini.mockWxMethod('login', { code: 'smoke-cleanup-' + Date.now() });
  await mini.reLaunch('/pages/login/login').catch(() => null);
  const loginPage = await waitPath('pages/login/login');
  await loginPage.callMethod('doLogin', '');
  const orgPage = await waitPath('pages/org-select/org-select');
  record('C1', '登录链路正常（app.js/request.js/store.js 精简后）', true);

  // 2) 选定组织 → 首页
  await sleep(1500);
  await orgPage.callMethod('confirmSelect', 1);
  await waitPath('pages/home/home', 20000).catch(() => null);
  const home = await mini.currentPage();
  record('C2', '选定组织后进入首页', home && home.path === 'pages/home/home', home && home.path);

  // 3) 四个 tab 逐个唤醒渲染
  for (const tab of ['march', 'quiz', 'mine']) {
    await mini.switchTab('/pages/' + tab + '/' + tab).catch(() => null);
    await sleep(1500);
    const p = await mini.currentPage().catch(() => null);
    record('C3-' + tab, 'tab ' + tab + ' 渲染', p && p.path === 'pages/' + tab + '/' + tab, p && p.path);
  }

  // 4) 登出路径（app.logout 已不再调 store.clearCache）
  const minePage = await mini.currentPage();
  await minePage.callMethod('handleLogout').catch(() => null);
  await sleep(500);
  // showModal 需确认：直接调 confirm 回调不可达则改为清登录态验证 logout 本身
  await mini.evaluate(() => {
    const app = getApp();
    if (app.globalData.loggedIn) app.logout();
    return true;
  });
  await sleep(800);
  const after = await mini.evaluate(() => getApp().globalData.loggedIn);
  record('C4', '登出后 loggedIn=false（logout 无 clearCache 依赖）', after === false, String(after));

  record('C5', '全程无「已删函数」运行时报错', pageErrors.length === 0, pageErrors[0] || '');

  const failed = RESULTS.filter((r) => !r.ok);
  console.log('\n== 清理回归冒烟：' + (RESULTS.length - failed.length) + '/' + RESULTS.length + ' 通过 ==');
  try { await mini.disconnect(); } catch (e) { /* ignore */ }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.log('FATAL', e && e.message);
  process.exit(1);
});
