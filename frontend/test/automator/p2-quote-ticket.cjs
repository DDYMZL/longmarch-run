/**
 * P2-1 每日寄语 + 节点纪念票（小程序侧）验收（断言先行，截图放末尾）
 *
 * 覆盖（需求 §16/§19）：
 *   P2B-01 今日寄语卡：首页展示寄语（内容/出处/日期非空，日期不晚于今天），卡片渲染
 *   P2B-02 寄语跳节点：点击寄语卡跳转关联节点详情
 *   P2B-03 纪念票：已点亮节点详情显示「生成纪念票」入口 → 票面就绪（canvas + 点亮日期/当日步数）
 *   P2B-04 未点亮节点直接进纪念票页显示「尚未点亮」错误态
 * 末尾截图：33-home-quote.png / 34-ticket.png
 *
 *   node p2-quote-ticket.cjs
 *
 * 前置：后端 8010 运行（含 007_daily_quotes.sql 与寄语种子）；开发者工具自动化端口 9420 可用。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const NICKNAME = 'P2寄语票';
const AVATAR = 'https://example.com/auto-avatar.png';
const RESULTS_FILE = path.join(__dirname, 'results-p2b.json');
const SHOT_QUOTE = path.join(__dirname, '..', 'images', '33-home-quote.png');
const SHOT_TICKET = path.join(__dirname, '..', 'images', '34-ticket.png');

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
  const code = 'automator-p2b-' + Date.now();
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
  const today = new Date().toISOString().slice(0, 10);

  /* ===== 今日寄语（§16） ===== */
  await cmd(() => mini.reLaunch('/pages/home/home'), 'reLaunch home', 2);
  const home = await waitPath('pages/home/home');
  const hd = await waitFor(async () => {
    const dd = await cmd(() => home.data(), 'home data');
    return dd && dd.quote ? dd : null;
  }, 20000, 500, 'home quote ready');

  // P2B-01 寄语卡字段
  const cardEl = await cmd(() => home.$('.quote-card'), 'find quote card', 1);
  const q = hd.quote;
  record('P2B-01', '今日寄语卡：内容/出处/日期非空，日期不晚于今天，卡片渲染',
    !!q.content && !!q.source && !!q.date && q.date <= today && !!cardEl,
    'date=' + q.date + ' source=' + q.source + ' node=' + (q.node ? q.node.name : '无'));

  // P2B-02 寄语卡 -> 关联节点详情
  try {
    if (!q.node) {
      record('P2B-02', '寄语跳节点：今日寄语无关联节点（跳过跳转断言）', true, 'node=null');
    } else {
      await cmd(() => home.callMethod('goQuoteNode'), 'tap quote card', 2);
      const nodePage = await waitPath('pages/node-detail/node-detail');
      const nd = await waitFor(async () => {
        const dd = await cmd(() => nodePage.data(), 'quote node data');
        return dd && dd.node ? dd : null;
      }, 15000, 500, 'quote node ready');
      record('P2B-02', '寄语跳节点：点击寄语卡跳转关联节点「' + q.node.name + '」详情',
        nd.node.id === q.node.id && nd.node.name === q.node.name,
        'landed=' + nd.node.name);
    }
  } catch (e) { record('P2B-02', '寄语跳节点', false, e.message); }

  /* ===== 节点纪念票（§19） ===== */
  // 补 2000 步并触发点亮 -> 瑞金产生点亮记录（纪念票数据来自点亮足迹）
  await api('/sport/add', token, 'POST', { delta: 2000 });
  const lit = await api('/march/light-up', token, 'POST');
  const fp = await api('/march/footprints', token);
  const fpRuijin = ((fp.body && fp.body.nodes) || []).find((n) => n.id === 1);
  if (!fpRuijin) throw new Error('点亮足迹缺少瑞金（id=1），无法构造纪念票');

  // P2B-03 已点亮节点：详情页入口 + 票面就绪
  try {
    await cmd(() => mini.reLaunch('/pages/node-detail/node-detail?id=1'), 'reLaunch node-detail 1', 2);
    const nodePage = await waitPath('pages/node-detail/node-detail');
    await waitFor(async () => {
      const dd = await cmd(() => nodePage.data(), 'node 1 data');
      return dd && dd.node && dd.node.status === 'completed' ? dd : null;
    }, 15000, 500, 'node 1 completed');
    const btnEl = await cmd(() => nodePage.$('.ticket-btn'), 'find ticket btn', 1);

    await cmd(() => nodePage.callMethod('goTicket'), 'go ticket', 2);
    const ticketPage = await waitPath('pages/ticket/ticket');
    const td = await waitFor(async () => {
      const dd = await cmd(() => ticketPage.data(), 'ticket data');
      return dd && dd.ready ? dd : null;
    }, 15000, 500, 'ticket ready');
    const canvasEl = await cmd(() => ticketPage.$('#ticketCanvas'), 'find ticket canvas', 1);
    record('P2B-03', '纪念票：瑞金详情显示「生成纪念票」入口，票面就绪（canvas 渲染，点亮数据齐备）',
      !!btnEl && td.ready === true && td.nodeName === '瑞金' && !!canvasEl
      && !!fpRuijin.litDate && fpRuijin.daySteps === 2000,
      'node=' + td.nodeName + ' litDate=' + fpRuijin.litDate + ' daySteps=' + fpRuijin.daySteps);
  } catch (e) { record('P2B-03', '纪念票生成', false, e.message); }

  // P2B-04 未点亮节点进纪念票页 -> 错误态（遵义 5000 步未达成）
  try {
    await cmd(() => mini.reLaunch('/pages/ticket/ticket?id=2'), 'reLaunch ticket 2', 2);
    const ticketPage2 = await waitPath('pages/ticket/ticket');
    const td2 = await waitFor(async () => {
      const dd = await cmd(() => ticketPage2.data(), 'ticket 2 data');
      return dd && dd.error ? dd : null;
    }, 15000, 500, 'ticket error ready');
    record('P2B-04', '未点亮节点进纪念票页显示「尚未点亮」错误态',
      td2.ready === false && td2.error.indexOf('尚未点亮') >= 0,
      'error=' + td2.error);
  } catch (e) { record('P2B-04', '未点亮错误态', false, e.message); }

  /* ===== 截图（断言全部落盘后；截图会使自动化桥退化，每个状态以主动导航起手） ===== */
  // 33 首页今日寄语卡
  try {
    await cmd(() => mini.reLaunch('/pages/home/home'), 'reLaunch home shot', 1);
    const hp = await waitPath('pages/home/home');
    await waitFor(async () => {
      const dd = await cmd(() => hp.data(), 'home shot data', 1);
      return dd && dd.quote && dd.routeLoading === false ? dd : null;
    }, 20000, 500, 'home shot ready');
    await sleep(1200);
    await withTimeout(mini.screenshot({ path: SHOT_QUOTE }), 25000, 'screenshot quote');
    console.log('SHOT 33-home-quote.png');
  } catch (e) { console.log('寄语截图失败（不影响断言）: ' + e.message); }

  // 34 瑞金纪念票
  try {
    await cmd(() => mini.reLaunch('/pages/ticket/ticket?id=1'), 'reLaunch ticket shot', 1);
    const tp = await waitPath('pages/ticket/ticket');
    await waitFor(async () => {
      const dd = await cmd(() => tp.data(), 'ticket shot data', 1);
      return dd && dd.ready ? dd : null;
    }, 15000, 500, 'ticket shot ready');
    await sleep(1200);
    await withTimeout(mini.screenshot({ path: SHOT_TICKET }), 25000, 'screenshot ticket');
    console.log('SHOT 34-ticket.png');
  } catch (e) { console.log('纪念票截图失败（不影响断言）: ' + e.message); }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log('\n== 共 ' + results.length + ' 用例，失败 ' + failed.length + ' ==');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FATAL: ' + (e && e.message));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  process.exit(2);
});
