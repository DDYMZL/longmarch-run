/** route-badge 修复后视觉截图（最小动作：导航→滚动→截图） */
const path = require('path');
const automator = require('miniprogram-automator');
const IMG = path.join(__dirname, '..', 'images');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  try {
    await mini.switchTab('/pages/march/march');
    await sleep(2500);
    const page = await mini.currentPage();
    await page.callMethod('skipIntro').catch(() => {});
    await mini.evaluate(() => new Promise((r) => {
      wx.pageScrollTo({ scrollTop: 620, duration: 0, complete: r });
    }));
    await sleep(800);
    await mini.screenshot({ path: path.join(IMG, 'route-badge-02-after.png') });
    console.log('OK route-badge-02-after.png');
  } catch (e) {
    console.log('FAIL', e.message);
  }
  mini.disconnect();
  process.exit(0);
})();
