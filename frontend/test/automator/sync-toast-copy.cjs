/**
 * 核对首页 / 长征页同步成功提示不再出现「近7天」。
 * 用法：node sync-toast-copy.cjs
 * 前置：开发者工具自动化端口 9420；已有登录态时才会走到成功提示。
 */
const path = require('path');
const { spawnSync } = require('child_process');
const automator = require('miniprogram-automator');

const SHOT = path.join(__dirname, '..', 'images', 'sync-toast-success.png');

const WS = 'ws://127.0.0.1:9420';
const CLI = 'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const PROJECT = 'D:/project/longmarch-run';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function rearm() {
  console.log('重启自动化桥');
  spawnSync('cmd.exe', ['/c', CLI, 'auto', '--project', PROJECT, '--auto-port', '9420'], {
    stdio: 'inherit',
    timeout: 90000
  });
}

async function connect() {
  try {
    return await automator.connect({ wsEndpoint: WS });
  } catch (e) {
    console.log('首次连接失败: ' + e.message);
    rearm();
    await sleep(20000);
    return automator.connect({ wsEndpoint: WS });
  }
}

async function hookToast(mini) {
  await mini.evaluate(() => {
    const app = getApp();
    app.globalData.__toasts = [];
    if (!wx.__toastOrig) wx.__toastOrig = wx.showToast.bind(wx);
    wx.showToast = function (opts) {
      const current = getApp();
      if (!current.globalData.__toasts) current.globalData.__toasts = [];
      current.globalData.__toasts.push((opts && opts.title) || '');
      return wx.__toastOrig(opts);
    };
  });
}

async function readToasts(mini) {
  return mini.evaluate(() => (getApp().globalData.__toasts || []).slice());
}

(async () => {
  const mini = await connect();
  const results = [];
  try {
    for (const target of ['pages/march/march', 'pages/home/home']) {
      await mini.reLaunch('/' + target);
      await sleep(2500);
      const page = await mini.currentPage();
      if (!page || page.path !== target) {
        results.push({ page: target, ok: false, detail: '未进入页面 ' + (page && page.path) });
        continue;
      }
      await hookToast(mini);
      const before = (await readToasts(mini)).length;
      await page.callMethod('handleSyncSteps');
      let titles = [];
      let syncError = '';
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        titles = await readToasts(mini);
        const cur = await mini.currentPage();
        const data = cur ? await cur.data() : {};
        syncError = data.syncError || '';
        if (titles.length > before || syncError) break;
      }
      const fresh = titles.slice(before);
      const bad = fresh.filter((t) => t.indexOf('近7') >= 0 || t.indexOf('七天') >= 0);
      const ok = fresh.some((t) => t === '同步成功') && bad.length === 0;
      if (target === 'pages/home/home' && fresh.indexOf('同步成功') >= 0) {
        await mini.screenshot({ path: SHOT });
        console.log('screenshot ' + SHOT);
      }
      results.push({
        page: target,
        ok: ok,
        titles: fresh,
        syncError: syncError
      });
      console.log(JSON.stringify(results[results.length - 1]));
    }
  } finally {
    await mini.disconnect();
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('FAIL ' + JSON.stringify(failed));
    process.exit(1);
  }
  console.log('PASS');
})().catch((e) => {
  console.error('FATAL ' + e.message);
  process.exit(2);
});
