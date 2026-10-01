/**
 * 组织选择页截图（与断言流程分离）—— 首次登录采集微信昵称输入框的视觉证据。
 * 用法：node shots-orgselect.cjs
 */
const path = require('path');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', () => {});

const WS = 'ws://127.0.0.1:9420';
const IMAGES_DIR = path.join(__dirname, '..', 'images');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('超时:' + label)), ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t));
}

let mini = null;
let cmdChain = Promise.resolve();
function cmd(fn, desc, retries = 1) {
  const run = async () => {
    for (let i = 0; ; i++) {
      try { const r = await withTimeout(fn(), 12000, desc); await sleep(40); return r; }
      catch (e) { if (i >= retries) throw e; await sleep(1500); }
    }
  };
  const p = cmdChain.then(run, run);
  cmdChain = p.then(() => undefined, () => undefined);
  return p;
}

async function waitPath(prefix, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = await withTimeout(mini.currentPage().catch(() => null), 8000, 'currentPage').catch(() => null);
    if (p && p.path && p.path.indexOf(prefix) === 0) return p;
    await sleep(500);
  }
  throw new Error('等待页面超时: ' + prefix);
}

async function main() {
  mini = await withTimeout(automator.connect({ wsEndpoint: WS }), 30000, 'connect');
  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) {}
    return true;
  }), 'reset');
  // 登录（mock code 派生新用户）→ 组织选择页展示昵称采集
  const loginCode = 'shots-org-' + Date.now();
  await cmd(() => mini.mockWxMethod('login', { code: loginCode }), 'mock login', 2);
  await cmd(() => mini.reLaunch('/pages/login/login').catch(() => null), 'reLaunch login');
  const loginPage = await waitPath('pages/login/login');
  await cmd(() => loginPage.callMethod('doLogin', ''), 'doLogin', 2);
  await waitPath('pages/org-select/org-select');
  await sleep(2000);
  const shotFile = path.join(IMAGES_DIR, 'org-select-nickname.png');
  await withTimeout(mini.screenshot({ path: shotFile }), 15000, 'screenshot');
  console.log('截图已保存: ' + shotFile);
  try { await mini.disconnect(); } catch (e) { /* ignore */ }
  process.exit(0);
}

setTimeout(() => process.exit(3), 120000);
main().catch((e) => { console.error('截图失败: ' + (e && e.message || e)); process.exit(2); });
