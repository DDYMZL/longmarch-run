/**
 * 昵称功能截图（与断言流程分离）—— 复现 mine 页「已修改」状态补拍截图。
 * 复用 nickname-test.cjs 落盘的 loginCode（同一测试用户，已被改名）。
 * 用法：node shots-nickname.cjs
 */
const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', () => {});

const WS = 'ws://127.0.0.1:9420';
const RESULTS_FILE = path.join(__dirname, 'results-nickname.json');
const IMAGES_DIR = path.join(__dirname, '..', 'images');
const WECHAT_NAME = '微信昵称甲';

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
  const state = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  if (!state || !state.loginCode) throw new Error('缺少 loginCode，请先运行 nickname-test.cjs');

  mini = await withTimeout(automator.connect({ wsEndpoint: WS }), 30000, 'connect');
  // 桥就绪后 mock wx.login
  await waitPath('pages', 60000).catch(() => {});
  for (let i = 0; i < 5; i++) {
    await cmd(() => mini.mockWxMethod('login', { code: state.loginCode }), 'mock login', 0).catch(() => {});
    const got = await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.login({ success: (r) => resolve(r && r.code ? r.code : 'NO_CODE'), fail: () => resolve('FAIL') });
    })), 'verify mock', 0).catch(() => 'EVAL_ERR');
    if (got === state.loginCode) break;
    await sleep(2000);
  }

  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) {}
    return true;
  }), 'reset');
  await cmd(() => mini.reLaunch('/pages/login/login').catch(() => null), 'reLaunch login');
  const loginPage = await waitPath('pages/login/login');
  await cmd(() => loginPage.setData({ nickname: WECHAT_NAME }), 'setData nickname');
  await cmd(() => loginPage.callMethod('doLogin', ''), 'doLogin');
  await waitPath('pages/home/home');
  await sleep(800);
  await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine');
  const minePage = await waitPath('pages/mine/mine');
  await sleep(1500);
  const shotFile = path.join(IMAGES_DIR, 'mine-nickname-changed.png');
  await withTimeout(mini.screenshot({ path: shotFile }), 15000, 'screenshot');
  console.log('截图已保存: ' + shotFile);
  try { await mini.disconnect(); } catch (e) { /* ignore */ }
  process.exit(0);
}

setTimeout(() => process.exit(3), 240000);
main().catch((e) => { console.error('截图失败: ' + (e && e.message || e)); process.exit(2); });
