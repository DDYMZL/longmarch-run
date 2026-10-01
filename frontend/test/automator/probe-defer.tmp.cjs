const automator = require('miniprogram-automator');
(async () => {
  const mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  mini.on('console', (m) => {
    const a = (m.args || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    console.log('APP>', a.slice(0, 160));
  });
  console.log('connected');
  await mini.evaluate(() => {
    const origRL = wx.reLaunch.bind(wx);
    wx.reLaunch = (opts) => {
      console.log('RELAUNCH-CALL', JSON.stringify(opts));
      return origRL(Object.assign({}, opts, {
        success: () => console.log('RELAUNCH-OK', JSON.stringify(opts)),
        fail: (e) => console.log('RELAUNCH-FAIL', JSON.stringify(opts), JSON.stringify(e))
      }));
    };
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) {}
    return true;
  });
  await mini.evaluate(() => wx.reLaunch({ url: '/pages/quiz-result/quiz-result' })).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  console.log('--- 发出延迟的 recovery reLaunch(login) ---');
  await mini.evaluate(() => wx.reLaunch({ url: '/pages/login/login' })).catch((e) => console.log('eval err:', e.message));
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 800));
    const stack = await mini.evaluate(() => getCurrentPages().map((p) => p.route)).catch(() => 'eval-fail');
    console.log('t' + ((i + 1) * 0.8).toFixed(1) + 's stack=', JSON.stringify(stack));
    if (stack[0] === 'pages/login/login' && stack.length === 1) break;
  }
  await mini.disconnect();
  process.exit(0);
})().catch((e) => { console.log('PROBE CRASH:', e.message); process.exit(2); });
