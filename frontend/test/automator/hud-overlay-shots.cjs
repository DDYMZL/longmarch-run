/**
 * 星空长征 L7 实时数据叠加层 + L8 WS 飞线 截图补拍（与 hud-overlay.cjs 断言分离）
 *   cd frontend/test/automator && node hud-overlay-shots.cjs [文件名...]
 * 输出：frontend/test/images/overlay-*.png
 * 前置：后端 8010 在跑（config.js DEV_TARGET=local）、模拟器已登录、自动化端口 9420 可用。
 */
const path = require('path');
const automator = require('miniprogram-automator');

const IMG = path.join(__dirname, '..', 'images');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 进入星空模式并等待渲染内核就绪（已就绪则直接返回） */
async function ensureStarry(mini, page) {
  await page.callMethod('skipIntro').catch(() => {});
  if ((await page.data('mode')) !== 'canvas') {
    await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } });
  }
  const start = Date.now();
  for (;;) {
    const ready = await mini.evaluate(() => {
      const p = getCurrentPages().pop();
      getApp().__shot = p;
      return !!(p.hud && p.hud.nodePts && p.hud.path);
    }).catch(() => false);
    if (ready) return;
    if (Date.now() - start > 20000) throw new Error('等待星空画布超时');
    await sleep(400);
  }
}

/** 等待 L7 数据注入；缺失时主动触发一次 loadOverlay（前一轮截图可能把 stats 置空） */
async function waitStats(mini, timeout = 15000) {
  const start = Date.now();
  let kicked = false;
  while (Date.now() - start < timeout) {
    const ok = await mini.evaluate(() => !!getApp().__shot.hud.stats).catch(() => false);
    if (ok) return true;
    if (!kicked) {
      kicked = true;
      await mini.evaluate(() => { getApp().__shot.loadOverlay(); return true; }).catch(() => {});
    }
    await sleep(500);
  }
  return false;
}

const STATES = [
  // 1) 常态：L7 面板 + 进度仪表环 + 三态图例 + 底部操作提示
  ['overlay-01-hud.png', async (mini, page) => {
    await ensureStarry(mini, page);
    await waitStats(mini);
    await mini.evaluate(() => { getApp().__shot.hud.resetView(); return true; });
    await sleep(1200);
  }],
  // 2) L8 飞线：keeper 定时器把飞线钉在 44% 行程，保证截图落在飞行中
  ['overlay-02-flyline.png', async (mini, page) => {
    await ensureStarry(mini, page);
    await waitStats(mini);
    await mini.evaluate(() => {
      const p = getApp().__shot;
      const h = p.hud;
      const idx = h.nodeIndex[h.route.nodes[6].id];
      h.playFlyLine(h.route.nodes[6].id);
      getApp().__flyKeeper = setInterval(() => {
        if (p.hud) p.hud.flyLine = { idx: idx, start: Date.now() - 300 };
      }, 150);
      return true;
    });
    await sleep(500);
  }],
  // 3) 缩放 2 倍：已点亮/当前节点标签并入全员抵达人数徽标
  ['overlay-03-badge.png', async (mini, page) => {
    await ensureStarry(mini, page);
    await waitStats(mini);
    await mini.evaluate(() => {
      const h = getApp().__shot.hud;
      const p = h.nodePts[1]; // 遵义（已点亮，带徽标）
      h.view.scale = 2;
      h.view.ox = h.cw / 2 - p.x * 2;
      h.view.oy = h.ch / 2 - p.y * 2;
      h.clampView();
      return true;
    });
    await sleep(1200);
  }],
  // 4) 数据缺失降级：面板三行显示 --
  ['overlay-04-nodata.png', async (mini, page) => {
    await ensureStarry(mini, page);
    await waitStats(mini);
    await mini.evaluate(() => { getApp().__shot.hud.resetView(); getApp().__shot.hud.setStats(null); return true; });
    await sleep(900);
  }],
  // 5) 实景模式对照：叠加层随画布一起释放，DOM 提示条正常
  ['overlay-05-real.png', async (mini, page) => {
    await ensureStarry(mini, page);
    await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'real' } } });
    await sleep(2500);
  }]
];

(async () => {
  const only = process.argv.slice(2);
  for (const [file, setup] of STATES.filter((s) => !only.length || only.includes(s[0]))) {
    const mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    try {
      await mini.switchTab('/pages/march/march');
      await sleep(2500);
      const page = await mini.currentPage();
      await setup(mini, page);
      await mini.screenshot({ path: path.join(IMG, file) });
      console.log('OK', file);
    } catch (e) {
      console.log('FAIL', file, e.message);
    }
    await mini.evaluate(() => {
      if (getApp().__flyKeeper) { clearInterval(getApp().__flyKeeper); getApp().__flyKeeper = null; }
      delete getApp().__shot;
      return true;
    }).catch(() => {});
    mini.disconnect();
    await sleep(8000);
  }
  process.exit(0);
})();
