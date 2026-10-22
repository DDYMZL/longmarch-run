/**
 * 星空长征节点详情弹框验证截图（E6 建面板、F1 改页面级全屏遮罩 + 居中对话框）
 *   cd frontend/test/automator && node epic-panel-shots.cjs
 * 输出：frontend/test/images/epic-05-node-panel.png / epic-06-panel-closed.png
 *
 * 每段独立连接（mini.screenshot 会退化自动化桥），connect 自愈内含重新武装。
 * 渲染数据注入口径同 epic-shots.cjs（后端不可达时的模拟器测试态验证）；
 * 详情接口同样不可达，弹框史料字段用 mergePanelNode 直接注入（验证弹框渲染与交互，
 * 接口契约由 node-detail 页既有功能覆盖）。
 */
const path = require('path');
const { spawnSync } = require('child_process');
const automator = require('miniprogram-automator');

const IMG = path.join(__dirname, '..', 'images');
const CLI = 'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(1200);
    page = await mini.currentPage();
    if (page.path === 'pages/march/march') break;
    if (i === 2) throw new Error('未进入 march 页: ' + page.path);
  }
  await page.callMethod('skipIntro').catch(() => {});
  if ((await page.data('mode')) !== 'canvas') {
    await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } });
  }
  const t0 = Date.now();
  for (;;) {
    const ready = await mini.evaluate(() => {
      const p = getCurrentPages().pop();
      return !!(p.hud && p.canvas);
    }).catch(() => false);
    if (ready) break;
    if (Date.now() - t0 > 20000) throw new Error('等待星空画布超时');
    await sleep(300);
  }
  await mini.evaluate((r) => {
    getCurrentPages().pop().renderRoute(r);
  }, FAKE_ROUTE);
  await sleep(2600); // 等进入动画播完，避免聚焦补间与 intro 时间线叠加
  return page;
}

(async () => {
  // 段 1：打开泸定桥面板（聚焦 → 快照 → 滑入），注入史料后截完整面板
  let mini = await connect();
  let page = await prepare(mini);
  await mini.evaluate(() => {
    getCurrentPages().pop().openNodePanel(6);
  });
  await sleep(700); // 聚焦 420ms + 快照 + 面板滑入
  // 详情接口不可达：直接注入史料字段（mergePanelNode 即详情回包走的同一入口）
  await mini.evaluate(() => {
    getCurrentPages().pop().mergePanelNode({
      historicalTime: '1935年5月29日',
      location: '四川省泸定县',
      brief: '红四团二十二位勇士冒着枪林弹雨，攀踏悬空铁索夺下泸定桥，打通北上通道。',
      description: '大渡河水流湍急，两岸高山峻岭。泸定桥由十三根铁索组成，桥板被敌军抽去。红军勇士攀索突击，创造了战争史上的奇迹。这场战斗粉碎了敌军围歼红军于大渡河以南的企图。',
      keywordList: ['泸定桥', '大渡河', '铁索']
    }, { detailReady: true, loadFail: false });
  });
  await sleep(300);
  const panelState = await mini.evaluate(() => {
    const p = getCurrentPages().pop();
    return {
      open: !!p.data.nodePanel,
      coverCanvas: p.data.coverCanvas,
      shot: !!p.data.sceneShot,
      name: p.data.nodePanel && p.data.nodePanel.node.name,
      chapter: p.data.nodePanel && p.data.nodePanel.node.chapterTitle,
      status: p.data.nodePanel && p.data.nodePanel.node.status,
      ready: p.data.nodePanel && p.data.nodePanel.detailReady,
      focusScale: p.hud ? null : undefined // hud 已在 coverCanvas 前停帧，view 在 _prePanelView
    };
  });
  console.log('面板状态:', JSON.stringify(panelState));
  if (!panelState.open || !panelState.coverCanvas || !panelState.shot) throw new Error('面板未正确打开或画布未快照顶替');
  if (panelState.name !== '飞夺泸定桥' || panelState.chapter !== '第三章 · 突围') throw new Error('面板节点/章节不正确');

  // F1 几何断言：页面级居中对话框（水平/垂直居中于页面），底部按钮完整露出不被裁切。
  // SelectorQuery 用回调把结果挂到 app 实例——evaluate 返回 Promise 会打死自动化桥。
  await mini.evaluate(() => {
    const app = getApp();
    app._rects = {};
    wx.createSelectorQuery()
      .select('.node-panel').boundingClientRect((r) => { app._rects.panel = r; })
      .select('.node-panel-actions').boundingClientRect((r) => { app._rects.actions = r; })
      .select('.node-panel-mask').boundingClientRect((r) => { app._rects.mask = r; })
      .exec();
  });
  await sleep(300);
  const geo = await mini.evaluate(() => {
    const app = getApp();
    const sys = wx.getSystemInfoSync();
    return { rects: app._rects, winW: sys.windowWidth, winH: sys.windowHeight };
  });
  console.log('几何断言:', JSON.stringify(geo));
  const { panel, actions, mask } = geo.rects;
  if (!panel || !actions || !mask) throw new Error('弹框/按钮/遮罩矩形未取到');
  if (Math.abs(mask.top) > 1) throw new Error('遮罩未从页面顶开始（不是页面级）: top=' + mask.top);
  if (mask.height >= geo.winH) throw new Error('遮罩不应盖住原生 tabBar: mask.height=' + mask.height + ' winH=' + geo.winH);
  const panelCx = panel.left + panel.width / 2;
  if (Math.abs(panelCx - geo.winW / 2) > 20) throw new Error('弹框未水平居中: cx=' + panelCx + ' winW/2=' + geo.winW / 2);
  // 垂直居中参照遮罩（页面可视区，不含原生 tabBar），而非含 tabBar 的 windowHeight
  const maskCy = (mask.top + mask.bottom) / 2;
  const panelCy = panel.top + panel.height / 2;
  if (Math.abs(panelCy - maskCy) > 40) throw new Error('弹框未垂直居中: cy=' + panelCy + ' maskCy=' + maskCy);
  if (actions.bottom > panel.bottom + 1 || actions.bottom > mask.bottom) throw new Error('按钮被裁切: actions.bottom=' + actions.bottom + ' panel.bottom=' + panel.bottom);
  if (actions.top < panel.top) throw new Error('按钮越出弹框顶部');

  await mini.screenshot({ path: path.join(IMG, 'epic-05-node-panel.png') });
  console.log('OK epic-05-node-panel.png（页面级居中详情弹框：泸定桥完整态）');
  mini.disconnect();

  // 段 2：打开面板 → 关闭 → 断言画布重建、观景变换恢复、入场动画不重播
  mini = await connect();
  page = await prepare(mini);
  await mini.evaluate(() => {
    getCurrentPages().pop().openNodePanel(1);
  });
  await sleep(700);
  const preClose = await mini.evaluate(() => {
    const p = getCurrentPages().pop();
    return { open: !!p.data.nodePanel, savedScale: p._prePanelView && p._prePanelView.scale };
  });
  console.log('关闭前:', JSON.stringify(preClose));
  if (!preClose.open) throw new Error('段2面板未打开');
  await mini.evaluate(() => {
    getCurrentPages().pop().closeNodePanel();
  });
  // 等画布重建（initCanvas 为 SelectorQuery 异步；轮询须以 running 判定，
  // 否则旧内核实例在重建完成前也满足 hud && canvas 条件而提前 break）
  const t0 = Date.now();
  let restored = null;
  for (;;) {
    restored = await mini.evaluate(() => {
      const p = getCurrentPages().pop();
      if (!p.hud || !p.canvas || p.data.coverCanvas || !p.running) return null;
      return {
        coverCanvas: p.data.coverCanvas,
        introSkipped: p.hud.introStart === 0,
        scale: Math.round(p.hud.view.scale * 100) / 100,
        running: !!p.running
      };
    }).catch(() => null);
    if (restored) break;
    if (Date.now() - t0 > 15000) throw new Error('画布重建超时');
    await sleep(300);
  }
  console.log('恢复状态:', JSON.stringify(restored));
  if (!restored.introSkipped) throw new Error('关闭面板后入场动画被重播');
  if (restored.scale < 1.7) throw new Error('观景变换未恢复（被重置为 1）');
  if (!restored.running) throw new Error('动画循环未恢复');
  await sleep(400);
  await mini.screenshot({ path: path.join(IMG, 'epic-06-panel-closed.png') });
  console.log('OK epic-06-panel-closed.png（面板关闭：画布恢复、聚焦保留）');
  mini.disconnect();

  console.log('E6 面板截图验证完成');
})().catch((e) => {
  console.error('FAIL:', e && e.message);
  process.exit(1);
});
