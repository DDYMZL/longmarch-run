/**
 * 星空长征史诗风重构 E5 动画验证截图（进入动画序列 + 延安终点仪式）
 *   cd frontend/test/automator && node epic-anim-shots.cjs
 * 输出：frontend/test/images/epic-anim-*.png
 *
 * 每段独立连接（mini.screenshot 会退化自动化桥），connect 自愈内含重新武装。
 * 渲染数据注入口径同 epic-shots.cjs（后端不可达时的模拟器测试态验证）。
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

/** 进行中用户路线（同 epic-shots） */
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

/** 全程完成 + 待办仪式（finished + ceremonyPending，触发页内终点仪式） */
const FINALE_ROUTE = Object.assign({}, FAKE_ROUTE, {
  nodes: FAKE_ROUTE.nodes.map((n) => Object.assign({}, n, { status: 'completed', remain: 0 })),
  chapters: FAKE_ROUTE.chapters.map((c) => Object.assign({}, c, { litCount: c.totalCount, progress: 1, status: 'COMPLETED' })),
  currentSteps: 65000,
  litCount: 10,
  routeProgress: 1,
  currentChapterId: null,
  finished: true,
  ceremonyPending: true
});

/** 进 march 切星空模式并注入路线；intro 判定依赖「新内核实例」，故每次连接后重建 */
async function prepare(mini, route) {
  await mini.reLaunch('/pages/launch/launch');
  await sleep(800);
  await mini.evaluate(() => {
    getApp().globalData.loggedIn = true;
  });
  await mini.switchTab('/pages/march/march');
  await sleep(1200);
  const page = await mini.currentPage();
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
  }, route || FAKE_ROUTE);
  return page;
}

(async () => {
  // 段 1：进入动画中段（完整版只在新内核实例首次 setRoute 播放——切到实景再切回星空即新实例）
  // 350ms：星幕淡入中、路线尚未开始描画
  let mini = await connect();
  await prepare(mini, null);
  await sleep(350);
  await mini.screenshot({ path: path.join(IMG, 'epic-anim-01-intro-sky.png') });
  console.log('OK epic-anim-01-intro-sky.png（进入动画 350ms：星幕淡入）');
  mini.disconnect();

  // 段 2：1500ms：路线描画中、已完成节点依次亮起
  mini = await connect();
  await prepare(mini, null);
  await sleep(1500);
  await mini.screenshot({ path: path.join(IMG, 'epic-anim-02-intro-route.png') });
  console.log('OK epic-anim-02-intro-route.png（进入动画 1500ms：路线描画中）');
  mini.disconnect();

  // 段 3：延安终点仪式中段（注入 finished + ceremonyPending 后手动触发 maybeStartCeremony，
  // 1800ms：焦点已转向延安、金色逐段重亮、金粒子汇聚中）
  mini = await connect();
  const page = await prepare(mini, FINALE_ROUTE);
  await sleep(2400); // 等进入动画播完
  await mini.evaluate(() => {
    const p = getCurrentPages().pop();
    p.maybeStartCeremony(p.routeData);
  });
  await sleep(1800);
  await mini.screenshot({ path: path.join(IMG, 'epic-anim-03-finale.png') });
  console.log('OK epic-anim-03-finale.png（终点仪式 1800ms：重亮+汇聚中）');
  const finaleState = await mini.evaluate(() => {
    const p = getCurrentPages().pop();
    return { finale: !!p.hud.finale, particles: (p.hud.finaleParticles || []).length, finished: p.data.finished };
  }).catch(() => null);
  console.log('仪式状态:', JSON.stringify(finaleState));
  mini.disconnect();

  console.log('E5 动画截图验证完成');
})().catch((e) => {
  console.error('FAIL:', e && e.message);
  process.exit(1);
});
