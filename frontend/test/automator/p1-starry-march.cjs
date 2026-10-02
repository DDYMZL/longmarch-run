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
 *   node p1-starry-march.cjs
 *
 * 前置：后端 8010 运行；开发者工具自动化端口 9420 可用。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const NICKNAME = 'P1星空';
const AVATAR = 'https://example.com/auto-avatar.png';
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

function api(path_, token, method, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const req = http.request({
      host: '127.0.0.1', port: 8010, path: '/api' + path_, method: method || 'GET',
      headers: Object.assign(
        token ? { Authorization: 'Bearer ' + token } : {},
        body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}
      )
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); }
        catch (e) { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
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

async function freshLogin() {
  const code = 'automator-p1j-' + Date.now();
  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) { /* ignore */ }
    return true;
  }), 'resetAuth', 2);
  await cmd(() => mini.reLaunch('/pages/login/login'), 'reLaunch login', 2);
  const login = await waitPath('pages/login/login');
  for (let i = 0; i < 5; i++) {
    await cmd(() => mini.mockWxMethod('login', { code }), 'mock login', 1).catch(() => {});
    const got = await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.login({ success: (r) => resolve(r && r.code ? r.code : 'NO_CODE'), fail: () => resolve('FAIL_BRANCH') });
    })), 'verify login mock', 1).catch(() => 'EVAL_ERR');
    if (got === code) break;
    if (i === 4) throw new Error('wx.login mock 反复未生效');
    await sleep(2000);
  }
  await cmd(() => login.callMethod('doLogin', AVATAR), 'doLogin', 2);
  const org = await waitPath('pages/org-select/org-select');
  await cmd(() => org.setData({ nickname: NICKNAME }), 'setData org nickname', 2);
  await cmd(() => org.callMethod('confirmSelect', 11), 'confirmSelect 11', 2);
  await waitPath('pages/home/home');
  await sleep(1200);
  return code;
}

async function apiAddSteps(code, delta) {
  const login = await api('/auth/login', null, 'POST', { code, nickname: NICKNAME });
  const token = login.body && login.body.token;
  if (!token) throw new Error('API 登录失败');
  const r = await api('/sport/add', token, 'POST', { delta });
  if (r.status !== 200) throw new Error('API 补步数失败: ' + r.status);
  return r.body;
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
      return !!(p && p.ctx && p.view && p.nodePts && p.nodePts.length > 0);
    }), 'canvas ready');
    return ok ? true : null;
  }, 20000, 500, 'canvas ready');
  return page;
}

async function pageState() {
  return cmd(() => mini.evaluate(() => {
    const p = getCurrentPages().pop();
    return {
      scale: p.view.scale, ox: p.view.ox, oy: p.view.oy,
      cw: p.cw, ch: p.ch,
      dust: (p.trailDust || []).length,
      nodePts: p.nodePts.map((q) => ({ x: q.x, y: q.y }))
    };
  }), 'read page state');
}

async function tap(page, x, y) {
  await cmd(() => page.callMethod('onMapTouchStart', { touches: [{ x, y }] }), 'touchstart', 1);
  await cmd(() => page.callMethod('onMapTouchEnd', { touches: [], changedTouches: [{ x, y }] }), 'touchend', 1);
}

(async () => {
  mini = await connectMini();
  const code = await freshLogin();
  await apiAddSteps(code, 8000); // 点亮瑞金/遵义，当前四渡赤水（星空三态齐备）
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
    const page2 = await openStarry();
    const fx = await cmd(() => mini.evaluate(() => {
      const p = getCurrentPages().pop();
      const id = p.routeData.nodes[0].id;
      const parts = p.makeArriveParticles([id]);
      const sample = parts[0] || {};
      // 超时 fx 自动清除
      p.arriveFx = { ids: [id], start: Date.now() - 3000, particles: parts };
      p.drawArriveFx();
      const cleared = p.arriveFx === null;
      // 活跃 fx 整帧绘制无异常
      p.arriveFx = { ids: [id], start: Date.now(), particles: parts };
      p.draw(Date.now() / 1000);
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
    /* 截图：星空长征模式（复位视角） */
    await cmd(() => page2.callMethod('resetView'), 'resetView', 1).catch(() => {});
    await sleep(700);
    await withTimeout(mini.screenshot({ path: SHOT_FILE }), 25000, 'screenshot starry');
    console.log('SHOT 27-march-starry.png');
  } catch (e) { record('P1J-04', '点亮粒子/fx 生命周期', false, e.message); }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log('\n== 共 ' + results.length + ' 用例，失败 ' + failed.length + ' ==');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FATAL: ' + (e && e.message));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  process.exit(2);
});
