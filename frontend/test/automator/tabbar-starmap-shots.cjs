/**
 * tabBar 图标 + 星空地图闪烁 截图补拍（与 tabbar-starmap.cjs 断言分离；每状态以主动导航开头）
 *   cd frontend/test/automator && node tabbar-starmap-shots.cjs
 * 输出：frontend/test/images/tabbar-*.png、starmap-*.png
 */
const path = require('path');
const automator = require('miniprogram-automator');

const IMG = path.join(__dirname, '..', 'images');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATES = [
  ['tabbar-01-home.png', '/pages/home/home'],
  ['tabbar-02-quiz.png', '/pages/quiz/quiz'],
  ['tabbar-03-rank.png', '/pages/rank/rank'],
  ['tabbar-04-mine.png', '/pages/mine/mine'],
  ['starmap-01-twinkle-a.png', '/pages/march/march', true],
  ['starmap-02-twinkle-b.png', '/pages/march/march', true, 2500]
];

(async () => {
  const only = process.argv.slice(2);
  for (const [file, url, starry, delay] of STATES.filter((s) => !only.length || only.includes(s[0]))) {
    const mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    try {
      await mini.switchTab(url);
      await sleep(2500);
      if (starry) {
        const page = await mini.currentPage();
        await page.callMethod('skipIntro').catch(() => {});
        if ((await page.data('mode')) !== 'canvas') {
          await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } });
          await sleep(2500);
        }
        if (delay) await sleep(delay);
      }
      await mini.screenshot({ path: path.join(IMG, file) });
      console.log('OK', file);
    } catch (e) {
      console.log('FAIL', file, e.message);
    }
    mini.disconnect();
    await sleep(8000);
  }
  process.exit(0);
})();
