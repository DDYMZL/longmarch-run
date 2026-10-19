/**
 * P1-5 星空长征模式升级（小程序侧）验收（断言先行，截图放末尾）
 *
 * 覆盖（需求 §13）：
 *   P1J-01 模式升级：按钮「星空长征」、切换后 canvas 就绪、观景变换与星尘初始化
 *   P1J-02 星空全景：捏合缩放（锚定+钳制 1~2.5）、拖动平移（边界钳制）
 *   P1J-03 双击复位 + 单指点击命中节点进详情（逆变换命中）
 *   P1J-04 点亮动画：粒子预生成限量（单节点≤14、字段齐备）、fx 超时自动清除、整帧绘制无异常
 * 末尾截图：27-march-starry.png
 *
 * 断言对象：星空绘制状态与方法全部在渲染内核 page.hud（utils/hudMap）上，页面只留手势转发。
 *
 *   node p1-starry-march.cjs
 *
 * 前置：后端 8010 运行；开发者工具自动化端口 9420 可用；模拟器已有有效登录态。
 */
const path = require('path');
const fs = require('fs');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const RESULTS_FILE = path.join(__dirname, 'results-p1j.json');
const SHOT_FILE = path.join(__dirname, '..', 'images', '27-march-starry.png');

const results = [];
let mini = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('命令超时(' + ms + 'ms): ' + label)), ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t));
}

async function cmd(fn, desc, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await withTimeout(fn(), 20000, desc); } catch (e) {
      if (i === retries) throw e;
      console.log('retry[' + (i + 1) + '] ' + desc + ': ' + (e && e.message));
      await sleep(1500);
    }
  }
}

function record(id, name, pass, detail) {
  results.push({ id, name, pass: !!pass, detail: String(detail == null ? '' : detail).slice(0, 400) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + (detail ? ' | ' + detail : ''));
}

async function waitPath(prefix, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const p = await withTimeout(mini.currentPage().catch(() => null), 8000, 'currentPage').catch(() => null);
    if (p && p.path && p.path.indexOf(prefix) === 0) return p;
    await sleep(400);
  }
  throw new Error('等待页面超时: ' + prefix);
}

async function waitFor(fn, timeout = 15000, interval = 400, desc = 'condition') {
  const start = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { /* retry */ }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('等待超时: ' + desc);
    await sleep(interval);
  }
}

async function connectMini() {
  for (let i = 0; i < 3; i++) {
    try { return await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect'); } catch (e) {
      console.log('connect 失败(' + (i + 1) + '/3): ' + e.message);
      await sleep(6000);
    }
  }
  throw new Error('无法连接自动化桥');
}

/**
 * 复用模拟器已有登录态。
 * 原 freshLogin（mock code 登录 + 强制选组织）已随两处变更失效：本地后端配了真实微信凭证，
 * 固定 mock code 会被 code2Session 拒（502）；V1.0 起登录后直接 switchTab 首页、组织改选填。
 * P1J 四项断言均不依赖步数，故不再注入步数（避免污染本地库真实用户数据）。
 */
async function ensureLoggedIn() {
  const st = await cmd(() => mini.evaluate(() => {
    const g = getApp().globalData;
    return { loggedIn: !!g.loggedIn, orgId: g.user && g.user.orgId ? g.user.orgId : null };
  }), 'login state', 2);
  if (!st || !st.loggedIn) throw new Error('模拟器无有效登录态：请先在开发者工具内登录后重跑');
  console.log('复用持久登录态 orgId=' + st.orgId);
}

/* 进入长征页并切到星空长征模式：返回 page（开场动画已跳过、canvas 已就绪） */
async function openStarry() {
  await cmd(() => mini.reLaunch('/pages/march/march'), 'reLaunch march', 2);
  const page = await waitPath('pages/march/march');
  await cmd(() => page.callMethod('skipIntro'), 'skipIntro', 1).catch(() => {});
  await cmd(() => page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } }), 'switchMode canvas', 2);
  await waitFor(async () => {
    const ok = await cmd(() => mini.evaluate(() => {
      const p = getCurrentPages().pop();
      return !!(p && p.hud && p.hud.view && p.hud.nodePts && p.hud.nodePts.length > 0);
    }), 'canvas ready');
    return ok ? true : null;
  }, 20000, 500, 'canvas ready');
  return page;
}

async function pageState() {
  return cmd(() => mini.evaluate(() => {
    const h = getCurrentPages().pop().hud;
    return {
      scale: h.view.scale, ox: h.view.ox, oy: h.view.oy,
      cw: h.cw, ch: h.ch,
      dust: (h.trailDust || []).length,
      nodePts: h.nodePts.map((q) => ({ x: q.x, y: q.y }))
    };
  }), 'read page state');
}

async function tap(page, x, y) {
  await cmd(() => page.callMethod('onMapTouchStart', { touches: [{ x, y }] }), 'touchstart', 1);
  await cmd(() => page.callMethod('onMapTouchEnd', { touches: [], changedTouches: [{ x, y }] }), 'touchend', 1);
}

(async () => {
  mini = await connectMini();
  await ensureLoggedIn();
  const page = await openStarry();

  /* P1J-01 模式升级 */
  const btns = await cmd(() => page.$$('.mode-btn'), 'mode btns');
  const label = btns && btns[1] ? await cmd(() => btns[1].text(), 'btn text') : '';
  const st1 = await pageState();
  record('P1J-01', '星空长征模式：按钮文案/canvas 就绪/view 与星尘初始化',
    label === '星空长征'
      && st1.scale === 1 && st1.ox === 0 && st1.oy === 0
      && st1.dust === 22 && st1.nodePts.length === 10,
    'label=' + label + ' view=' + JSON.stringify({ s: st1.scale, ox: st1.ox, oy: st1.oy }) + ' dust=' + st1.dust);

  /* P1J-02 捏合缩放 + 拖动平移 */
  try {
    await cmd(() => page.callMethod('onMapTouchStart', { touches: [{ x: 100, y: 200 }, { x: 140, y: 200 }] }), 'pinch start', 1);
    await cmd(() => page.callMethod('onMapTouchMove', { touches: [{ x: 60, y: 200 }, { x: 180, y: 200 }] }), 'pinch move', 1);
    await cmd(() => page.callMethod('onMapTouchEnd', { touches: [], changedTouches: [{ x: 60, y: 200 }, { x: 180, y: 200 }] }), 'pinch end', 1);
    const st2 = await pageState();
    const okZoom = st2.scale > 1.5 && st2.scale <= 2.5;
    await cmd(() => page.callMethod('onMapTouchStart', { touches: [{ x: 200, y: 200 }] }), 'pan start', 1);
    await cmd(() => page.callMethod('onMapTouchMove', { touches: [{ x: 160, y: 180 }] }), 'pan move', 1);
    await cmd(() => page.callMethod('onMapTouchEnd', { touches: [], changedTouches: [{ x: 160, y: 180 }] }), 'pan end', 1);
    const st3 = await pageState();
    const minOx = st3.cw * (1 - st3.scale);
    const minOy = st3.ch * (1 - st3.scale);
    const okPan = (st3.ox !== 0 || st3.oy !== 0)
      && st3.ox <= 0 && st3.ox >= minOx - 0.01
      && st3.oy <= 0 && st3.oy >= minOy - 0.01;
    record('P1J-02', '星空全景：捏合缩放（钳制 1~2.5）+ 拖动平移（边界钳制）',
      okZoom && okPan,
      'scale=' + st2.scale.toFixed(2) + ' pan=(' + st3.ox.toFixed(1) + ',' + st3.oy.toFixed(1) + ') clamp=[' + minOx.toFixed(1) + ',0]');
  } catch (e) { record('P1J-02', '星空全景手势', false, e.message); }

  /* P1J-03 双击复位 + 单击命中节点 */
  try {
    await tap(page, 5, 5);
    await sleep(120);
    await tap(page, 5, 5);
    await sleep(200);
    const st4 = await pageState();
    const okReset = st4.scale === 1 && st4.ox === 0 && st4.oy === 0;
    // 单击首节点（瑞金）屏幕坐标 → 跳转节点详情
    const np = st4.nodePts[0];
    await tap(page, Math.round(np.x), Math.round(np.y));
    await waitPath('pages/node-detail/node-detail', 8000);
    record('P1J-03', '双击复位 + 单击星星命中节点进详情',
      okReset,
      'reset=' + JSON.stringify({ s: st4.scale, ox: st4.ox, oy: st4.oy }) + ' tap=(' + Math.round(np.x) + ',' + Math.round(np.y) + ')');
  } catch (e) { record('P1J-03', '双击复位/命中', false, e.message); }

  /* P1J-04 点亮动画粒子与 fx 生命周期（确定性 evaluate-replay） */
  try {
    await cmd(() => mini.reLaunch('/pages/march/march'), 'reLaunch march 2', 2);
    await waitPath('pages/march/march');
    await openStarry();
    const fx = await cmd(() => mini.evaluate(() => {
      const p = getCurrentPages().pop();
      const h = p.hud;
      const id = p.routeData.nodes[0].id;
      const parts = h.makeArriveParticles([id]);
      // 超时 fx 自动清除
      h.arriveFx = { ids: [id], start: Date.now() - 3000, particles: parts };
      h.drawArriveFx();
      const cleared = h.arriveFx === null;
      // 活跃 fx 整帧绘制无异常
      h.arriveFx = { ids: [id], start: Date.now(), particles: parts };
      h.draw(Date.now() / 1000);
      return {
        count: parts.length,
        fieldsOk: parts.every((q) => ['x', 'y', 'vx', 'vy', 'r', 'delay'].every((k) => typeof q[k] === 'number')),
        cleared: cleared,
        drawOk: true
      };
    }), 'arrive fx replay');
    record('P1J-04', '点亮动画：粒子限量/字段齐备/fx 超时清除/整帧绘制无异常',
      fx.count >= 1 && fx.count <= 14 && fx.fieldsOk && fx.cleared && fx.drawOk,
      'particles=' + fx.count + ' cleared=' + fx.cleared);
  } catch (e) { record('P1J-04', '点亮粒子/fx 生命周期', false, e.message); }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log('\n== 共 ' + results.length + ' 用例，失败 ' + failed.length + ' ==');

  /* 截图与断言分离：mini.screenshot 会让自动化桥退化，故在结果落盘后单独补拍，失败不影响判定 */
  try {
    await cmd(() => mini.evaluate(() => { getCurrentPages().pop().hud.resetView(); return true; }), 'resetView', 1);
    await sleep(700);
    await withTimeout(mini.screenshot({ path: SHOT_FILE }), 25000, 'screenshot starry');
    console.log('SHOT 27-march-starry.png');
  } catch (e) { console.log('截图失败（不影响断言）: ' + e.message); }

  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FATAL: ' + (e && e.message));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  process.exit(2);
});
