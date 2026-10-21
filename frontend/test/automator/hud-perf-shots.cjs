/**
 * 星空长征帧率自适应降级（S5）截图补拍（与 hud-perf.cjs 断言分离）
 *   cd frontend/test/automator && node hud-perf-shots.cjs [文件名...]
 * 输出：frontend/test/images/perf-*.png
 *
 * 两张图刻意冻结在**同一个合成时间戳** T=4.5s（SCAN_S=9 的一半，扫描带正好在画面中部），
 * 且都在 playArrive 后 450ms 抓帧（粒子 delay 0.2~0.4s 已全部可见），
 * 因此常态与降级两图逐像素可比：差异只应是「水平扫描带消失 + 金色粒子消失」，
 * 雷达扇形、L5 金色流光、六边环节点、L7 面板/仪表环/图例、底部提示必须完全一致。
 *
 * 前置：后端 8010 + openGauss 5118 在跑（config.js DEV_TARGET=local）、模拟器已登录、端口 9420 已武装。
 */
const path = require('path');
const { spawnSync } = require('child_process');
const automator = require('miniprogram-automator');

const IMG = path.join(__dirname, '..', 'images');
const CLI = 'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const T_FIXED = 4.5; // 合成时间戳（秒）：扫描带位于画面中部
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

/** 进入星空模式并等待渲染内核与 L7 数据就绪 */
async function ensureStarry(mini, page) {
  await page.callMethod('skipIntro').catch(() => {});
  if ((await page.data('mode')) !== 'canvas') {
    await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } });
  }
  const t0 = Date.now();
  for (;;) {
    const ready = await mini.evaluate(() => {
      const p = getCurrentPages().pop();
      getApp().__shot = p;
      return !!(p.hud && p.hud.nodePts && p.hud.nodePts.length && p.hud.path);
    }).catch(() => false);
    if (ready) break;
    if (Date.now() - t0 > 25000) throw new Error('等待星空画布超时');
    await sleep(400);
  }
  // L7 数据（独立预算）：上一轮截图可能把 stats 置空，故主动补一次 loadOverlay
  const t1 = Date.now();
  let kicked = false;
  while (Date.now() - t1 < 15000) {
    const ok = await mini.evaluate(() => !!getApp().__shot.hud.stats).catch(() => false);
    if (ok) return;
    if (!kicked) {
      kicked = true;
      await mini.evaluate(() => { getApp().__shot.loadOverlay(); return true; }).catch(() => {});
    }
    await sleep(600);
  }
  console.log('  （L7 数据未就绪，叠加层按缺失态截图）');
}

/**
 * 冻结一帧：停掉页面 rAF，触发点亮动画，等到粒子全部可见后按合成时间戳单帧绘制。
 * @param {boolean} lowPerf 是否处于降级态
 */
async function freezeFrame(mini, lowPerf) {
  await mini.evaluate(() => {
    const p = getApp().__shot;
    p.stopAnim();
    p.hud.resetView();
    p.hud.playArrive([p.routeData.nodes[0].id]);
    return true;
  });
  await sleep(450); // 粒子 delay 0.2~0.4s，此时全部可见；fx 总时长 2.4s
  return mini.evaluate((o) => {
    const h = getApp().__shot.hud;
    h.lowPerf = o.lowPerf;
    // 清空采样窗口：否则遗留样本会在这一帧立刻把 lowPerf 重新置真（「不自动恢复」语义）
    h._perfN = 0; h._perfI = 0; h._perfSum = 0; h._perfLast = 0; h._perfAvg = 0;
    h.draw(o.t);
    return {
      lowPerf: h.lowPerf,
      particles: h.arriveFx && h.arriveFx.particles ? h.arriveFx.particles.length : 0,
      stats: !!h.stats
    };
  }, { lowPerf: lowPerf, t: T_FIXED });
}

const STATES = [
  // 1) 常态：L4 水平扫描带在画面中部 + 点亮粒子扩散，全部九层齐备
  ['perf-01-normal.png', async (mini, page) => {
    await ensureStarry(mini, page);
    const s = await freezeFrame(mini, false);
    console.log('  常态帧', JSON.stringify(s));
  }],
  // 2) 降级：同一时间戳同一视角，扫描带与粒子被关闭，叙事与数据层完整保留
  ['perf-02-degraded.png', async (mini, page) => {
    await ensureStarry(mini, page);
    const s = await freezeFrame(mini, true);
    console.log('  降级帧', JSON.stringify(s));
  }]
];

(async () => {
  const only = process.argv.slice(2);
  for (const [file, setup] of STATES.filter((s) => !only.length || only.includes(s[0]))) {
    let mini = null;
    try {
      mini = await connect();
      await mini.switchTab('/pages/march/march');
      await sleep(2500);
      const page = await mini.currentPage();
      await setup(mini, page);
      await mini.screenshot({ path: path.join(IMG, file) });
      console.log('OK', file);
    } catch (e) {
      console.log('FAIL', file, e.message);
    }
    if (mini) {
      await mini.evaluate(() => { delete getApp().__shot; return true; }).catch(() => {});
      mini.disconnect();
    }
    await sleep(8000);
  }
  process.exit(0);
})();
