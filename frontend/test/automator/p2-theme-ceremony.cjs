/**
 * P2-2 区域氛围 + 长征完成仪式（小程序侧）验收（断言先行，截图放末尾）
 *
 * 覆盖（需求 §12/§20）：
 *   P2D-01 区域氛围：瑞金详情头部为主题渐变 + 氛围画布（themeKey=ruijin，环境描述非空）
 *   P2D-02 区域氛围：雪山节点主题为 snow（与瑞金不同区域不同氛围）
 *   P2D-03 星空长征：每节点按区域主题生成环境粒子（30 颗封顶、含 snow 类型）
 *   P2D-04 完成仪式：路线完成后进长征页自动跳仪式页（首次），跳过动画后数据卡齐备（10/10）
 *   P2D-05 仪式标记：确认后 ceremonyPending 消失；再进仪式页为「已完成长征」静态回顾态
 * 末尾截图：35-node-theme.png / 36-ceremony.png
 *
 *   node p2-theme-ceremony.cjs
 *
 * 前置：后端 8010 运行（含 008_route_ceremony.sql）；开发者工具自动化端口 9420 可用。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const NICKNAME = 'P2氛围仪式';
const AVATAR = 'https://example.com/auto-avatar.png';
const RESULTS_FILE = path.join(__dirname, 'results-p2d.json');
const SHOT_THEME = path.join(__dirname, '..', 'images', '35-node-theme.png');
const SHOT_CEREMONY = path.join(__dirname, '..', 'images', '36-ceremony.png');

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
  const code = 'automator-p2d-' + Date.now();
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

async function apiToken(code) {
  const login = await api('/auth/login', null, 'POST', { code, nickname: NICKNAME });
  const token = login.body && login.body.token;
  if (!token) throw new Error('API 登录失败');
  return token;
}

(async () => {
  mini = await connectMini();
  const code = await freshLogin();
  const token = await apiToken(code);

  /* ===== 区域氛围（§12） ===== */
  // P2D-01 瑞金：主题渐变 + 氛围画布
  try {
    await cmd(() => mini.reLaunch('/pages/node-detail/node-detail?id=1'), 'reLaunch node 1', 2);
    const p1 = await waitPath('pages/node-detail/node-detail');
    const d1 = await waitFor(async () => {
      const dd = await cmd(() => p1.data(), 'node 1 data');
      return dd && dd.node ? dd : null;
    }, 15000, 500, 'node 1 ready');
    const cv1 = await cmd(() => p1.$('#atmoCanvas'), 'find atmo canvas 1', 1);
    record('P2D-01', '区域氛围：瑞金详情主题渐变 + 氛围粒子画布',
      d1.themeKey === 'ruijin' && !!d1.themeEnv && d1.themeBgStyle.indexOf('linear-gradient') >= 0 && !!cv1,
      'theme=' + d1.themeKey + ' env=' + d1.themeEnv);
  } catch (e) { record('P2D-01', '区域氛围：瑞金', false, e.message); }

  // P2D-02 雪山：不同区域不同主题
  try {
    await cmd(() => mini.reLaunch('/pages/node-detail/node-detail?id=7'), 'reLaunch node 7', 2);
    const p7 = await waitPath('pages/node-detail/node-detail');
    const d7 = await waitFor(async () => {
      const dd = await cmd(() => p7.data(), 'node 7 data');
      return dd && dd.node ? dd : null;
    }, 15000, 500, 'node 7 ready');
    record('P2D-02', '区域氛围：雪山节点主题为 snow（与瑞金不同）',
      d7.themeKey === 'snow' && d7.themeEnv.indexOf('雪山') >= 0,
      'theme=' + d7.themeKey + ' env=' + d7.themeEnv);
  } catch (e) { record('P2D-02', '区域氛围：雪山', false, e.message); }

  // P2D-03 星空长征：区域环境粒子
  try {
    await cmd(() => mini.reLaunch('/pages/march/march'), 'reLaunch march', 2);
    const mp = await waitPath('pages/march/march');
    await sleep(1500);
    await cmd(() => mp.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } }), 'switch canvas', 2);
    const motes = await waitFor(async () => {
      const v = await cmd(() => mini.evaluate(() => {
        const pages = getCurrentPages();
        const p = pages[pages.length - 1];
        if (!p || !p.regionMotes || !p.regionMotes.length) return null;
        const types = {};
        p.regionMotes.forEach((m) => { types[m.type] = (types[m.type] || 0) + 1; });
        return { count: p.regionMotes.length, types };
      }), 'read regionMotes', 1);
      return v || null;
    }, 20000, 600, 'region motes ready');
    record('P2D-03', '星空长征：每节点按区域主题生成环境粒子（封顶 30、含 snow/mist/ember/star）',
      motes.count === 30 && motes.types.snow > 0 && motes.types.mist > 0 && motes.types.ember > 0 && motes.types.star > 0,
      'count=' + motes.count + ' types=' + JSON.stringify(motes.types));
  } catch (e) { record('P2D-03', '星空长征区域粒子', false, e.message); }

  /* ===== 长征完成仪式（§20） ===== */
  // 补足步数点亮全部节点（终点 65000），再进长征页触发首次仪式
  await api('/sport/add', token, 'POST', { delta: 70000 });
  const lit = await api('/march/light-up', token, 'POST');
  const litCount = ((lit.body && lit.body.newlyLit) || []).length;

  // P2D-04 首次完成：自动跳仪式页，数据卡齐备
  try {
    if (litCount === 0) throw new Error('light-up 未点亮任何节点，无法触发仪式');
    await cmd(() => mini.reLaunch('/pages/march/march'), 'reLaunch march for ceremony', 2);
    const cp = await waitPath('pages/ceremony/ceremony', 40000);
    const cd = await waitFor(async () => {
      const dd = await cmd(() => cp.data(), 'ceremony data');
      return dd && dd.ready && dd.stats ? dd : null;
    }, 15000, 500, 'ceremony ready');
    // 画布断言需在跳过后快照替换画布之前（收尾后画布被静态图替换）
    const cvs = await cmd(() => cp.$('#ceremonyCanvas'), 'find ceremony canvas', 1);
    // 跳过动画直接到数据卡（动画流程由截图侧验证）
    await cmd(() => cp.callMethod('skipAnim'), 'skip ceremony anim', 2);
    const cd2 = await waitFor(async () => {
      const dd = await cmd(() => cp.data(), 'ceremony done data');
      return dd && dd.showStats && dd.coverCanvas ? dd : null;
    }, 10000, 400, 'ceremony stats shown');
    record('P2D-04', '完成仪式：首次完成自动进仪式页，跳过后最终文字与完成数据齐备（路线 10/10）',
      cd.pending === true && cd2.showFinalText === true && cd2.showStats === true
      && cd2.stats.litCount === 10 && cd2.stats.totalCount === 10 && !!cvs,
      'lit=' + cd2.stats.litCount + '/' + cd2.stats.totalCount + ' medals=' + cd2.stats.medalOwned + '/' + cd2.stats.medalTotal + ' steps=' + cd2.stats.totalStepsText);

    // P2D-05 确认标记：pending 消失；再进为静态回顾态
    await cmd(() => cp.callMethod('handleConfirm'), 'confirm ceremony', 2);
    await waitPath('pages/march/march', 20000);
    const routeAfter = await api('/march/route', token);
    const pendingGone = routeAfter.body && routeAfter.body.ceremonyPending === false && routeAfter.body.finished === true;

    await cmd(() => mini.reLaunch('/pages/ceremony/ceremony'), 'reLaunch ceremony replay', 2);
    const rp = await waitPath('pages/ceremony/ceremony');
    const rd = await waitFor(async () => {
      const dd = await cmd(() => rp.data(), 'replay data');
      return dd && dd.ready ? dd : null;
    }, 15000, 500, 'replay ready');
    record('P2D-05', '仪式标记：确认后 ceremonyPending 消失，再进仪式页为「已完成长征」静态回顾态',
      pendingGone === true && rd.pending === false && rd.showStats === true && rd.phase === 'done',
      'apiPending=' + (routeAfter.body && routeAfter.body.ceremonyPending) + ' replayPending=' + rd.pending);
  } catch (e) { record('P2D-04', '完成仪式触发', false, e.message); record('P2D-05', '仪式标记与回顾态', false, '前置失败: ' + e.message); }

  /* ===== 截图（断言全部落盘后；截图会使自动化桥退化，每个状态以主动导航起手） ===== */
  // 35 雪山节点区域氛围
  try {
    await cmd(() => mini.reLaunch('/pages/node-detail/node-detail?id=7'), 'reLaunch node 7 shot', 1);
    const sp = await waitPath('pages/node-detail/node-detail');
    await waitFor(async () => {
      const dd = await cmd(() => sp.data(), 'node 7 shot data', 1);
      return dd && dd.node && dd.themeKey === 'snow' ? dd : null;
    }, 15000, 500, 'node 7 shot ready');
    await sleep(1500);
    await withTimeout(mini.screenshot({ path: SHOT_THEME }), 25000, 'screenshot theme');
    console.log('SHOT 35-node-theme.png');
  } catch (e) { console.log('氛围截图失败（不影响断言）: ' + e.message); }

  // 36 长征完成仪式（回顾态含完成数据）
  try {
    await cmd(() => mini.reLaunch('/pages/ceremony/ceremony'), 'reLaunch ceremony shot', 1);
    const cp2 = await waitPath('pages/ceremony/ceremony');
    await waitFor(async () => {
      const dd = await cmd(() => cp2.data(), 'ceremony shot data', 1);
      return dd && dd.showStats ? dd : null;
    }, 15000, 500, 'ceremony shot ready');
    await sleep(1200);
    await withTimeout(mini.screenshot({ path: SHOT_CEREMONY }), 25000, 'screenshot ceremony');
    console.log('SHOT 36-ceremony.png');
  } catch (e) { console.log('仪式截图失败（不影响断言）: ' + e.message); }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log('\n== 共 ' + results.length + ' 用例，失败 ' + failed.length + ' ==');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FATAL: ' + (e && e.message));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  process.exit(2);
});
