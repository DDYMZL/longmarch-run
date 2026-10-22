/**
 * 星空长征史诗风重构（E2+）验证截图
 *   cd frontend/test/automator && node epic-shots.cjs
 * 输出：frontend/test/images/epic-*.png
 *
 * 前置：微信开发者工具已开、自动化端口 9420 已武装。
 * 说明：远程后端不可达时本脚本走「渲染数据注入」验证——仅向模拟器内的渲染内核
 * 注入种子节点几何/状态（节点坐标与累计步数取后端 seed.py 真实配置），
 * 不改业务数据、不动登录链路；业务联动验证待后端恢复后回归。
 */
const path = require('path');
const { spawnSync } = require('child_process');
const automator = require('miniprogram-automator');

const IMG = path.join(__dirname, '..', 'images');
const CLI = 'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一次 cli auto 武装只够一条连接：连接失败时重新武装后自愈重试一次 */
async function connect() {
  try {
    return await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  } catch (e) {
    console.log('  重新武装自动化端口…');
    spawnSync(CLI, ['auto', '--project', 'D:/project/longmarch-run', '--auto-port', '9420'], { stdio: 'ignore' });
    await sleep(30000);
    return automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  }
}

/** 测试态路线数据：节点几何/步数取 backend seed.py 真实配置，状态模拟行进到第 7 节点的用户 */
const FAKE_ROUTE = {
  nodes: [
    { id: 1, name: '瑞金', icon: '🚩', status: 'completed', targetSteps: 0, remain: 0, latitude: 25.885, longitude: 116.027 },
    { id: 2, name: '遵义', icon: '🏛️', status: 'completed', targetSteps: 5000, remain: 0, latitude: 27.72, longitude: 106.93 },
    { id: 3, name: '四渡赤水', icon: '🌊', status: 'completed', targetSteps: 10000, remain: 0, latitude: 28.3, longitude: 106.42 },
    { id: 4, name: '巧渡金沙江', icon: '⛵', status: 'completed', targetSteps: 15000, remain: 0, latitude: 26.28, longitude: 102.47 },
    { id: 5, name: '强渡大渡河', icon: '⚔️', status: 'completed', targetSteps: 20000, remain: 0, latitude: 29.25, longitude: 102.3 },
    { id: 6, name: '飞夺泸定桥', icon: '🌉', status: 'completed', targetSteps: 25000, remain: 0, latitude: 29.91, longitude: 102.24 },
    { id: 7, name: '翻越雪山', icon: '🏔️', status: 'current', targetSteps: 35000, remain: 7500, latitude: 30.75, longitude: 102.65 },
    { id: 8, name: '过草地', icon: '🌾', status: 'unlocked', targetSteps: 45000, remain: 17500, latitude: 33.58, longitude: 102.96 },
    { id: 9, name: '吴起镇', icon: '🎺', status: 'unlocked', targetSteps: 55000, remain: 27500, latitude: 36.92, longitude: 108.18 },
    { id: 10, name: '延安', icon: '⭐', status: 'unlocked', targetSteps: 65000, remain: 37500, latitude: 36.6, longitude: 109.49 }
  ],
  chapters: [
    { id: 1, name: '出发', title: '第一章 · 出发', nodeIds: [1, 2], litCount: 2, totalCount: 2, progress: 1, status: 'COMPLETED', intro: '' },
    { id: 2, name: '转折', title: '第二章 · 转折', nodeIds: [3, 4], litCount: 2, totalCount: 2, progress: 1, status: 'COMPLETED', intro: '' },
    { id: 3, name: '突围', title: '第三章 · 突围', nodeIds: [5, 6], litCount: 2, totalCount: 2, progress: 1, status: 'COMPLETED', intro: '' },
    { id: 4, name: '翻越', title: '第四章 · 翻越', nodeIds: [7, 8], litCount: 0, totalCount: 2, progress: 0, status: 'ACTIVE', intro: '' },
    { id: 5, name: '会师', title: '第五章 · 会师', nodeIds: [9, 10], litCount: 0, totalCount: 2, progress: 0, status: 'LOCKED', intro: '' }
  ],
  currentSteps: 27500,
  totalSteps: 65000,
  litCount: 6,
  totalCount: 10,
  routeProgress: 27500 / 65000,
  currentChapterId: 4,
  finished: false,
  ceremonyPending: false
};

/** 进 march 切星空模式并注入测试路线（截图退化桥后重连，也走同一流程恢复状态） */
async function prepare(mini) {
  await mini.reLaunch('/pages/launch/launch');
  await sleep(800);
  await mini.evaluate(() => {
    getApp().globalData.loggedIn = true;
  });
  // launch 的异步登录重定向可能把页面顶回 home：进入 march 允许有限重试
  let page = null;
  for (let i = 0; i < 3; i++) {
    await mini.switchTab('/pages/march/march');
    await sleep(1500);
    page = await mini.currentPage();
    if (page.path === 'pages/march/march') break;
    if (i === 2) throw new Error('未进入 march 页: ' + page.path);
  }

  await page.callMethod('skipIntro').catch(() => {});
  if ((await page.data('mode')) !== 'canvas') {
    await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } });
  }
  // 等内核实例就绪（无路线数据时 nodePts 为 null，只等 hud 与画布）
  const t0 = Date.now();
  for (;;) {
    const ready = await mini.evaluate(() => {
      const p = getCurrentPages().pop();
      return !!(p.hud && p.canvas);
    }).catch(() => false);
    if (ready) break;
    if (Date.now() - t0 > 20000) throw new Error('等待星空画布超时');
    await sleep(400);
  }
  // 注入测试路线（走页面 renderRoute 入口，WXML 列表/章节卡同步渲染，与真实链路同路径）
  await mini.evaluate((route) => {
    const p = getCurrentPages().pop();
    p.renderRoute(route);
  }, FAKE_ROUTE);
  return page;
}

(async () => {
  const mini = await connect();
  await prepare(mini);

  // 等入场描画播完（INTRO_MS=1600 + 余量）
  await sleep(2600);
  await mini.screenshot({ path: path.join(IMG, 'epic-01-overview.png') });
  console.log('OK epic-01-overview.png（星空全景：星幕/红金路线/节点三态）');

  // 内核状态断言：层级数据齐备、静态层烘焙成功（截图会退化桥，状态读取须在截图前完成——
  // 此处借助重连后的第二段完成；第一段截图后立即断开）
  await mini.disconnect();

  // 第二段：重连（截图已退化桥；connect 自愈内含重新武装），重新 prepare 恢复状态后做断言与缩放截图
  const mini2 = await connect();
  await prepare(mini2);
  await sleep(2600);
  const state = await mini2.evaluate(() => {
    const p = getCurrentPages().pop();
    const h = p.hud;
    return {
      lowPerf: h.lowPerf,
      perfAvg: Math.round(h._perfAvg * 10) / 10,
      farStars: (h.farStars || []).length,
      midStars: (h.midStars || []).length,
      nearStars: (h.nearStars || []).length,
      nebulas: (h.nebulas || []).length,
      chapterZones: (h.chapterZones || []).length,
      envMotes: (h.envMotes || []).length,
      staticLayer: !!h.staticLayer,
      routeNodes: (h.route && h.route.nodes || []).length
    };
  });
  console.log('内核状态:', JSON.stringify(state));
  if (!state.staticLayer) throw new Error('静态层烘焙失败');
  if (state.routeNodes !== 10) throw new Error('路线节点数异常: ' + state.routeNodes);
  if (state.chapterZones !== 5) throw new Error('章节区段数异常: ' + state.chapterZones);

  // 捏合缩放视图（验证观景变换与钳制不回归）
  await mini2.evaluate(() => {
    const p = getCurrentPages().pop();
    p.hud.view.scale = 1.8;
    p.hud.view.ox = -120;
    p.hud.view.oy = -100;
    p.hud.clampView();
  });
  await sleep(500);
  await mini2.screenshot({ path: path.join(IMG, 'epic-02-zoom.png') });
  console.log('OK epic-02-zoom.png（1.8x 缩放视图）');

  await mini2.disconnect();

  // 第三段：突围章特写（峡谷剪影 + 泸定桥节点图标；F1 起铁索垂弧装饰已移除），视角对准节点 6
  const mini3 = await connect();
  await prepare(mini3);
  await sleep(2000);
  await mini3.evaluate(() => {
    const p = getCurrentPages().pop();
    const h = p.hud;
    const pt = h.nodePts[h.nodeIndex[6]];
    h.view.scale = 2.5;
    h.view.ox = h.cw / 2 - pt.x * 2.5;
    h.view.oy = h.ch / 2 - pt.y * 2.5;
    h.clampView();
  });
  await sleep(500);
  await mini3.screenshot({ path: path.join(IMG, 'epic-03-breakthrough.png') });
  console.log('OK epic-03-breakthrough.png（突围章特写：峡谷剪影/泸定桥图标）');
  await mini3.disconnect();

  // 第四段：会师章特写（地平线天光 + 延安关键节点刻度 + 图标），视角对准节点 10
  const mini4 = await connect();
  await prepare(mini4);
  await sleep(2000);
  await mini4.evaluate(() => {
    const p = getCurrentPages().pop();
    const h = p.hud;
    const pt = h.nodePts[h.nodeIndex[10]];
    h.view.scale = 2.5;
    h.view.ox = h.cw / 2 - pt.x * 2.5;
    h.view.oy = h.ch / 2 - pt.y * 2.5;
    h.clampView();
  });
  await sleep(500);
  await mini4.screenshot({ path: path.join(IMG, 'epic-04-victory.png') });
  console.log('OK epic-04-victory.png（会师章特写：天光/延安节点图标与刻度）');
  await mini4.disconnect();
  console.log('E2~E4 截图验证完成');
})().catch((e) => {
  console.error('FAIL:', e && e.message);
  process.exit(1);
});
