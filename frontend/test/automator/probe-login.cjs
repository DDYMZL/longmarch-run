const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log('connected');
  mini.on('console', (m) => console.log('console:', m.type, JSON.stringify((m.args || []).map((a) => (typeof a === 'string' ? a.slice(0, 300) : JSON.stringify(a).slice(0, 300))))));
  mini.on('exception', (e) => console.log('exception:', e.message));

  await mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    wx.clearStorageSync();
    return true;
  });
  await mini.reLaunch('/pages/login/login');
  await sleep(2000);
  let page = await mini.currentPage();
  console.log('page:', page.path);

  await page.setData({ nickname: '自动化测试员' });
  await page.callMethod('doLogin', 'https://example.com/auto-avatar.png');
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    try {
      const top = await mini.currentPage();
      const d = await top.data();
      console.log(`t+${i + 1}s path=${top.path} loading=${d.loading} errorMsg=${JSON.stringify(d.errorMsg)}`);
      if (top.path !== 'pages/login/login') break;
    } catch (e) {
      console.log(`t+${i + 1}s err:`, e.message);
    }
  }
  await mini.disconnect();
  process.exit(0);
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
