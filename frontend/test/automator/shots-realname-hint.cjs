/**
 * 真实姓名提示改造截图（与断言流程分离，每状态独立连接 + 主动导航起手）：
 *   A. org-select 首次登录姓名采集块（提示语在输入框旁侧，不占 placeholder）
 *   B. mine 页修改昵称弹窗（content 提示真实姓名，输入框内无 placeholderText）
 * 用法：node shots-realname-hint.cjs
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

/** 全新 mock 用户登录：清登录态 → mock code → login 页 doLogin → 落在 org-select */
async function freshLogin(code) {
  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) {}
    return true;
  }), 'reset');
  await cmd(() => mini.mockWxMethod('login', { code }), 'mock login', 2);
  await cmd(() => mini.reLaunch('/pages/login/login').catch(() => null), 'reLaunch login');
  const loginPage = await waitPath('pages/login/login');
  await cmd(() => loginPage.callMethod('doLogin', ''), 'doLogin', 2);
  await waitPath('pages/org-select/org-select');
}

async function shotOrgSelect() {
  mini = await withTimeout(automator.connect({ wsEndpoint: WS }), 30000, 'connect');
  await freshLogin('shots-realname-a-' + Date.now());
  await sleep(2000);
  const file = path.join(IMAGES_DIR, 'realname-org-select.png');
  await withTimeout(mini.screenshot({ path: file }), 15000, 'screenshot');
  console.log('截图已保存: ' + file);
  try { await mini.disconnect(); } catch (e) { /* ignore */ }
}

async function shotMineModal() {
  mini = await withTimeout(automator.connect({ wsEndpoint: WS }), 30000, 'connect');
  await freshLogin('shots-realname-b-' + Date.now());
  // 主动导航起手（截图后桥退化，本状态独立连接 + switchTab 唤醒）
  await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine');
  const minePage = await waitPath('pages/mine/mine');
  await sleep(2000);
  await cmd(() => minePage.callMethod('handleEditNickname'), 'handleEditNickname', 2);
  await sleep(1200);
  const file = path.join(IMAGES_DIR, 'realname-mine-modal.png');
  await withTimeout(mini.screenshot({ path: file }), 15000, 'screenshot');
  console.log('截图已保存: ' + file);
  try { await mini.disconnect(); } catch (e) { /* ignore */ }
}

async function main() {
  const only = process.argv[2];
  if (!only || only === 'a') {
    await shotOrgSelect();
    await sleep(15000); // 状态间冷却，避免上一截图把桥打死
  }
  if (!only || only === 'b') {
    await shotMineModal();
  }
  process.exit(0);
}

setTimeout(() => process.exit(3), 240000);
main().catch((e) => { console.error('截图失败: ' + (e && e.message || e)); process.exit(2); });
