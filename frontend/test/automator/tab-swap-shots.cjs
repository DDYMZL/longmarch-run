/**
 * tab 换防视觉证据：node tab-swap-shots.cjs <home|aichat>（每次运行只截一张，跑下一张前需 cli auto 重新武装）
 */
const path = require('path');
const automator = require('miniprogram-automator');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = process.argv[2] || 'home';
const TARGET = STATE === 'aichat' ? '/pages/ai-chat/ai-chat' : '/pages/home/home';
(async () => {
  const mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  for (let i = 0; i < 8; i++) {
    try {
      const ok = await mini.evaluate(() => {
        const app = getApp();
        if (!app) return false;
        app.globalData.loggedIn = true;
        app.globalData.user = { id: 1, nickname: '换防验收', avatar: '' };
        wx.request = function (opt) {
          if (opt && typeof opt.fail === 'function') opt.fail({ errMsg: 'request:fail stubbed' });
          return { abort() {} };
        };
        return true;
      });
      if (ok) break;
    } catch (e) { /* retry */ }
    await sleep(1000);
  }
  await mini.switchTab(TARGET);
  await sleep(2500);
  const file = path.join(__dirname, '..', 'images', 'tab-swap-' + STATE + '.png');
  await mini.screenshot({ path: file });
  console.log('SHOT ' + file);
  await mini.close();
  process.exit(0);
})().catch((e) => { console.log('SHOT ERR: ' + (e && e.message ? e.message : e)); process.exit(1); });
