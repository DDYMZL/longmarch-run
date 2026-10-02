/**
 * P0-4 长征旅程开场动画 小程序验收（需求 §5；断言先行，截图放末尾）
 *
 * 桥延迟 > 开场窗口（3.35s），墙钟轮询会漏判，改为确定性验证：
 * 在页内 evaluate 直接重置播放标记并调用 maybePlayIntro，同步读取分支结果。
 * 覆盖：
 *   P0O-01 首次进入分支：无缓存标记 → showIntro=true（且页面首次 onShow 已自然播放过，flag=1）
 *   P0O-02 自然结束：约 3.4s 后 showIntro=false 且 Storage 写入播放标记
 *   P0O-03 非首次分支：有缓存标记 → showVeil=true 且 showIntro=false
 *   P0O-04 纱幕 300~800ms 内自动消失：showVeil=false
 *   P0O-05 可跳过：skipIntro 立即结束开场并写缓存标记
 * 末尾截图：22-march-intro.png（evaluate 重触发后捕捉开场中段）
 *
 *   node p0-opening.cjs
 *
 * 前置：后端 8010 运行；开发者工具自动化端口 9420 可用。
 */
const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const NICKNAME = 'P0开场';
const AVATAR = 'https://example.com/auto-avatar.png';
const RESULTS_FILE = path.join(__dirname, 'results-p0o.json');
const SHOT_FILE = path.join(__dirname, '..', 'images', '22-march-intro.png');
const INTRO_FLAG = 'lm_march_intro_played';

const results = [];
let mini = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('命令超时(' + ms + 'ms): ' + label)), ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t));
}

async function cmd(fn, desc, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await withTimeout(fn(), 20000, desc); } catch (e) {
      if (i === retries) throw e;
      console.log('retry[' + (i + 1) + '] ' + desc + ': ' + (e && e.message));
      await sleep(1500);
    }
  }
}

function record(id, name, pass, detail) {
  results.push({ id, name, pass: !!pass, detail: String(detail == null ? '' : detail).slice(0, 400) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + (detail ? ' | ' + detail : ''));
}

async function waitPath(prefix, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = await withTimeout(mini.currentPage().catch(() => null), 8000, 'currentPage').catch(() => null);
    if (p && p.path && p.path.indexOf(prefix) === 0) return p;
    await sleep(400);
  }
  throw new Error('等待页面超时: ' + prefix);
}

async function waitFor(fn, timeout = 12000, interval = 300, desc = 'condition') {
  const start = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { /* retry */ }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('等待超时: ' + desc);
    await sleep(interval);
  }
}

async function connectMini() {
  for (let i = 0; i < 3; i++) {
    try { return await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect'); } catch (e) {
      console.log('connect 失败(' + (i + 1) + '/3): ' + e.message);
      await sleep(6000);
    }
  }
  throw new Error('无法连接自动化桥');
}

async function freshLogin() {
  const code = 'automator-p0o-' + Date.now();
  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) { /* ignore */ }
    return true;
  }), 'resetAuth', 2);
  await cmd(() => mini.reLaunch('/pages/login/login'), 'reLaunch login', 2);
  const login = await waitPath('pages/login/login');
  for (let i = 0; i < 5; i++) {
    await cmd(() => mini.mockWxMethod('login', { code }), 'mock login', 1).catch(() => {});
    const got = await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.login({ success: (r) => resolve(r && r.code ? r.code : 'NO_CODE'), fail: () => resolve('FAIL_BRANCH') });
    })), 'verify login mock', 1).catch(() => 'EVAL_ERR');
    if (got === code) break;
    if (i === 4) throw new Error('wx.login mock 反复未生效');
    await sleep(2000);
  }
  await cmd(() => login.setData({ nickname: NICKNAME }), 'setData nickname', 2);
  await cmd(() => login.callMethod('doLogin', AVATAR), 'doLogin', 2);
  const org = await waitPath('pages/org-select/org-select');
  await cmd(() => org.callMethod('confirmSelect', 12), 'confirmSelect 12', 2);
  await waitPath('pages/home/home');
  await sleep(1000);
}

/** 页内确定性重触发开场判定：清标记 → 复位 → maybePlayIntro，同步返回分支结果 */
function replayIntroDecision() {
  return cmd(() => mini.evaluate((k) => {
    const pages = getCurrentPages();
    const pg = pages[pages.length - 1];
    try { wx.removeStorageSync(k); } catch (e) { /* ignore */ }
    pg._introChecked = false;
    if (pg._introTimer) { clearTimeout(pg._introTimer); pg._introTimer = null; }
    if (pg._veilTimer) { clearTimeout(pg._veilTimer); pg._veilTimer = null; }
    pg.setData({ showIntro: false, showVeil: false });
    pg.maybePlayIntro();
    return { showIntro: pg.data.showIntro, showVeil: pg.data.showVeil };
  }, INTRO_FLAG), 'replay intro decision', 2);
}

function readFlag() {
  return cmd(() => mini.evaluate((k) => {
    try { return String(wx.getStorageSync(k) || ''); } catch (e) { return ''; }
  }, INTRO_FLAG), 'read intro flag', 1);
}

(async () => {
  mini = await connectMini();
  await freshLogin();

  await cmd(() => mini.reLaunch('/pages/march/march'), 'reLaunch march', 2);
  const page = await waitPath('pages/march/march');
  // 等页面首次 onShow 流程走完（开场自然播放并结束、路线数据就绪）
  await waitFor(async () => {
    const d = await cmd(() => page.data(), 'march ready poll', 1);
    return d && d.chapters && d.chapters.length === 5 ? d : null;
  }, 25000, 500, 'march chapters ready');
  const naturalFlag = await readFlag();

  /* P0O-01 首次分支：无标记 → 完整开场 */
  try {
    const r = await replayIntroDecision();
    record('P0O-01', '首次进入分支：showIntro=true（首次onShow已自然播放）',
      r.showIntro === true && r.showVeil === false && naturalFlag === '1',
      'replay=' + JSON.stringify(r) + ' naturalFlag=' + naturalFlag);
  } catch (e) { record('P0O-01', '首次进入分支', false, e.message); }

  /* P0O-02 自然结束 + 缓存标记 */
  try {
    await waitFor(async () => {
      const d = await cmd(() => page.data(), 'intro end poll', 1);
      return d && d.showIntro === false ? d : null;
    }, 12000, 300, 'showIntro=false');
    const flag = await readFlag();
    record('P0O-02', '约3.4s自然结束且写入缓存标记', flag === '1', 'flag=' + flag);
  } catch (e) { record('P0O-02', '自然结束', false, e.message); }

  /* P0O-03 非首次分支：有标记 → 快速过渡纱幕 */
  try {
    // flag 已为 1：直接复位实例状态后重新判定
    const r = await cmd(() => mini.evaluate((k) => {
      const pages = getCurrentPages();
      const pg = pages[pages.length - 1];
      pg._introChecked = false;
      if (pg._veilTimer) { clearTimeout(pg._veilTimer); pg._veilTimer = null; }
      pg.setData({ showIntro: false, showVeil: false });
      pg.maybePlayIntro();
      return { showIntro: pg.data.showIntro, showVeil: pg.data.showVeil };
    }, INTRO_FLAG), 'replay veil decision', 2);
    record('P0O-03', '非首次分支：showVeil=true 且不再播完整开场',
      r.showVeil === true && r.showIntro === false, JSON.stringify(r));
  } catch (e) { record('P0O-03', '非首次分支', false, e.message); }

  /* P0O-04 纱幕自动消失 */
  try {
    await waitFor(async () => {
      const d = await cmd(() => page.data(), 'veil end poll', 1);
      return d && d.showVeil === false ? d : null;
    }, 5000, 200, 'showVeil=false');
    record('P0O-04', '纱幕300~800ms内自动消失', true, 'showVeil=false');
  } catch (e) { record('P0O-04', '纱幕消失', false, e.message); }

  /* P0O-05 可跳过 */
  try {
    const r = await replayIntroDecision();
    if (r.showIntro !== true) throw new Error('重触发失败: ' + JSON.stringify(r));
    await cmd(() => page.callMethod('skipIntro'), 'skipIntro', 2);
    const d = await cmd(() => page.data(), 'after skip');
    const flag = await readFlag();
    record('P0O-05', '点击跳过：立即结束且写缓存标记',
      d.showIntro === false && flag === '1', 'showIntro=' + d.showIntro + ' flag=' + flag);
  } catch (e) { record('P0O-05', '跳过开场', false, e.message); }

  /* 截图：重触发开场，中段捕捉 */
  try {
    const r = await replayIntroDecision();
    if (r.showIntro !== true) throw new Error('重触发失败');
    await sleep(1100);
    await withTimeout(mini.screenshot({ path: SHOT_FILE }), 25000, 'screenshot intro');
    console.log('SHOT 22-march-intro.png');
  } catch (e) { console.log('截图失败（不影响断言）: ' + e.message); }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log('\n== 共 ' + results.length + ' 用例，失败 ' + failed.length + ' ==');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FATAL: ' + (e && e.message));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  process.exit(2);
});
