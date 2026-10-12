const automator = require('miniprogram-automator');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  try {
    await mini.evaluate(() => { wx.clearStorageSync(); const a = getApp(); a.globalData.user = null; a.globalData.loggedIn = false; });
    const page = await mini.reLaunch('/pages/onboard/onboard?invite=77choIoKvN56qEsY');
    await sleep(1500);
    await page.setData({ nickname: '回显测试', orgId: 1, orgName: '测试组织', orgFullName: '测试组织全称' });
    await page.callMethod('onSubmit');
    let cur;
    for (let i = 0; i < 20; i++) { await sleep(500); cur = await mini.currentPage(); if (cur && cur.path === 'pages/home/home') break; }
    console.log('after submit page =', cur && cur.path, '| errorMsg =', JSON.stringify((await page.data().catch(() => ({}))).errorMsg));
    const g = await mini.evaluate(() => getApp().globalData.user);
    console.log('globalData.user org =', g && g.orgId, g && g.orgFullName);
    const mine = await mini.switchTab('/pages/mine/mine');
    await sleep(2000);
    const d = await mine.data();
    console.log('mine user.orgFullName =', d.user && d.user.orgFullName);
    const t = await mine.$('.mine-org-text');
    console.log('mine org text =', t && (await t.text()));
  } finally { await mini.disconnect(); }
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
