const automator = require('miniprogram-automator');
(async () => {
  const mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  mini.on('console', (m) => {
    const a = (m.args || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    console.log('APP>', a.slice(0, 200));
  });
  console.log('connected');
  await mini.evaluate(() => {
    const wrap = (name) => {
      const orig = wx[name].bind(wx);
      wx[name] = (opts) => {
        const o2 = Object.assign({}, opts, {
          success: () => console.log(name + '-OK', JSON.stringify(opts)),
          fail: (e) => console.log(name + '-FAIL', JSON.stringify(opts), JSON.stringify(e))
        });
        return orig(o2);
      };
    };
    wrap('reLaunch'); wrap('switchTab'); wrap('redirectTo');
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) {}
    return true;
  });
  await mini.evaluate(() => wx.reLaunch({ url: '/pages/quiz-result/quiz-result' })).catch((e) => console.log('eval reLaunch err:', e.message));
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 800));
    const stack = await mini.evaluate(() => getCurrentPages().map((p) => p.route)).catch(() => 'eval-fail');
    console.log('t' + ((i + 1) * 0.8).toFixed(1) + 's stack=', JSON.stringify(stack));
  }
  await mini.disconnect();
  process.exit(0);
})().catch((e) => { console.log('PROBE CRASH:', e.message); process.exit(2); });
