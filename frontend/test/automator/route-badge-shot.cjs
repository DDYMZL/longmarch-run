/**
 * route-badge 垂直居中排查截图：先取 .route-name / .route-badge 矩形数据，再滚动截图
 *   cd frontend/test/automator && node route-badge-shot.cjs
 * 输出：frontend/test/images/route-badge-*.png + 控制台输出矩形 JSON
 */
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
    await sleep(500);

    const rects = await mini.evaluate(() => new Promise((resolve) => {
      const q = wx.createSelectorQuery();
      q.selectAll('.route-name-row .route-name').boundingClientRect();
      q.selectAll('.route-name-row .route-badge').boundingClientRect();
      q.select('.route-list').boundingClientRect();
      q.exec((res) => resolve({ names: res[0], badges: res[1], list: res[2] }));
    }));
    console.log('RECTS', JSON.stringify(rects, null, 1));

    if (rects.list) {
      await mini.evaluate((top) => new Promise((r) => {
        wx.pageScrollTo({ scrollTop: Math.max(top - 20, 0), duration: 0, complete: r });
      }), rects.list.top + (await mini.evaluate(() => new Promise((r) => {
        wx.createSelectorQuery().selectViewport().scrollOffset((res) => r(res.scrollTop));
      }))));
      await sleep(600);
    }
    await mini.screenshot({ path: path.join(IMG, 'route-badge-01-before.png') });
    console.log('OK route-badge-01-before.png');
  } catch (e) {
    console.log('FAIL', e.message);
  }
  mini.disconnect();
  process.exit(0);
})();
