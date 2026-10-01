const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log('connected');
  const r = await mini.evaluate(() => new Promise((resolve) => {
    wx.login({
      success: (res) => resolve({ ok: true, code: res.code }),
      fail: (err) => resolve({ ok: false, err: JSON.stringify(err) }),
      complete: () => console.log('wx.login complete')
    });
  }));
  console.log('wx.login result:', JSON.stringify(r));

  // 直接走后端请求验证网络可达
  const r2 = await mini.evaluate(() => new Promise((resolve) => {
    wx.request({
      url: 'http://127.0.0.1:8010/api/auth/me',
      method: 'GET',
      timeout: 8000,
      success: (res) => resolve({ ok: true, status: res.statusCode }),
      fail: (err) => resolve({ ok: false, err: JSON.stringify(err) })
    });
  }));
  console.log('wx.request /auth/me:', JSON.stringify(r2));

  await mini.disconnect();
  process.exit(0);
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
