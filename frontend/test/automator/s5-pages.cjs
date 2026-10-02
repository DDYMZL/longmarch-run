/**
 * S5 小程序页面升级验收（断言专用，不截图 —— 截图由 s5-shots.cjs 分离补拍）
 *
 * 覆盖：home 重组（播报/连续行军/期号/记忆/勋章行）、profile 档案、calendar 行军日历、
 *       quiz 情报化（期号 + 知识画像）、medals 分类墙 + 详情、node-detail 历史事件卡、
 *       march 到达动画数据链路（light-up 幂等 + 模式切换）、mine 新入口。
 *
 *   node s5-pages.cjs
 *
 * 前置：后端 http://127.0.0.1:8010 已运行；开发者工具自动化端口 9420 可用。
 * 登录：优先复用 IDE 持久登录态；失效则按 ui-test.cjs 同法（mock wx.login code）重登。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const CLI = 'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const PROJECT = 'D:/project/longmarch-run';
const NICKNAME = '自动化测试员';
const AVATAR = 'https://example.com/auto-avatar.png';
const RESULTS_FILE = path.join(__dirname, 'results-s5.json');

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

function rearmBridge() {
  console.log('--- 重启自动化桥 ---');
  spawnSync('cmd.exe', ['/c', CLI, 'auto', '--project', PROJECT, '--auto-port', '9420'], { stdio: 'ignore', timeout: 60000 });
}

async function connectMini() {
  for (let i = 0; i < 3; i++) {
    try { return await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect'); } catch (e) {
      console.log('connect 失败(' + (i + 1) + '/3): ' + e.message);
      await sleep(6000);
    }
  }
  rearmBridge();
  await sleep(25000);
  return await withTimeout(automator.connect({ wsEndpoint: WS }), 25000, 'connect-final');
}

function tourLoginCode() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
    if (s && s.loginCode) return s.loginCode;
  } catch (e) { /* ignore */ }
  return 'automator-s5-' + Date.now();
}

async function ensureLoginMock() {
  const code = tourLoginCode();
  for (let i = 0; i < 5; i++) {
    await cmd(() => mini.mockWxMethod('login', { code }), 'mock login', 1).catch(() => {});
    const got = await cmd(() => mini.evaluate(() => new Promise((resolve) => {
      wx.login({ success: (r) => resolve(r && r.code ? r.code : 'NO_CODE'), fail: () => resolve('FAIL_BRANCH') });
    })), 'verify login mock', 1).catch(() => 'EVAL_ERR');
    if (got === code) return;
    console.log('wx.login mock 未生效(' + (i + 1) + '/5): got=' + got);
    await sleep(2000);
  }
  throw new Error('wx.login mock 反复未生效');
}

/** 已登录（含组织）返回 true；否则走完整登录 + 选组织流程 */
async function ensureLoggedIn() {
  const state = await cmd(() => mini.evaluate(() => {
    const g = getApp().globalData;
    return { loggedIn: !!g.loggedIn, orgId: g.user && g.user.orgId ? g.user.orgId : null };
  }), 'evaluate login state', 2).catch(() => null);
  if (state && state.loggedIn && state.orgId) {
    console.log('复用持久登录态 orgId=' + state.orgId);
    return;
  }
  console.log('登录态缺失，执行登录流程');
  await cmd(() => mini.evaluate(() => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    try { wx.clearStorageSync(); } catch (e) { /* ignore */ }
    return true;
  }), 'resetAuth', 2);
  await cmd(() => mini.reLaunch('/pages/login/login'), 'reLaunch login', 2);
  const login = await waitPath('pages/login/login');
  await ensureLoginMock();
  await cmd(() => login.setData({ nickname: NICKNAME }), 'setData nickname', 2);
  await cmd(() => login.callMethod('doLogin', AVATAR), 'doLogin', 2);
  const org = await waitPath('pages/org-select/org-select');
  await cmd(() => org.callMethod('confirmSelect', 12), 'confirmSelect 12', 2);
  await waitPath('pages/home/home');
  await sleep(1500);
}

(async () => {
  mini = await connectMini();
  await ensureLoggedIn();

  /* ---------- S5-01 首页重组 ---------- */
  try {
    await cmd(() => mini.switchTab('/pages/home/home'), 'switchTab home', 2);
    const home = await waitPath('pages/home/home');
    await waitFor(async () => {
      const d = await cmd(() => home.data(), 'home data');
      return d && d.routeLoading === false ? d : null;
    }, 20000, 500, 'home.routeLoading=false');
    const d = await cmd(() => home.data(), 'home data final');
    const ok =
      typeof d.beatPercent === 'number' &&
      typeof d.issueNo === 'number' && d.issueNo >= 1 &&
      Array.isArray(d.medalPreview) &&
      typeof d.currentStreak === 'number' &&
      d.streakGoal === 5000 &&
      Object.prototype.hasOwnProperty.call(d, 'memory') &&
      Array.isArray(d.routeNodesPreview) && d.routeNodesPreview.length > 0;
    record('S5-01', '首页重组：播报/期号/连续行军/勋章行/记忆卡字段齐备', ok,
      'beatPercent=' + d.beatPercent + ' issueNo=' + d.issueNo + ' streak=' + d.currentStreak +
      ' medals=' + d.medalPreview.length + ' memory=' + (d.memory ? d.memory.title : 'null'));
  } catch (e) { record('S5-01', '首页重组', false, e.message); }

  /* ---------- S5-02 我的长征档案页 ---------- */
  try {
    await cmd(() => mini.navigateTo('/pages/profile/profile'), 'navigateTo profile', 2);
    const profile = await waitPath('pages/profile/profile');
    await waitFor(async () => {
      const d = await cmd(() => profile.data(), 'profile data');
      return d && d.loading === false && d.summary ? d : null;
    }, 20000, 500, 'profile.loading=false');
    const d = await cmd(() => profile.data(), 'profile data final');
    const s = d.summary;
    const ok = s && s.user && s.user.joinDays >= 1 && s.stats && typeof s.stats.totalSteps === 'number' &&
      s.stats.totalCount > 0 && d.stage.length > 0 && Array.isArray(d.timeline);
    record('S5-02', '档案页：summary 聚合 + 阶段称号 + 足迹时间轴', ok,
      'joinDays=' + s.user.joinDays + ' stage=' + d.stage + ' progress=' + s.stats.progress +
      ' timeline=' + d.timeline.length);
    await cmd(() => mini.navigateBack(), 'back from profile', 2);
    await sleep(800);
  } catch (e) { record('S5-02', '档案页', false, e.message); }

  /* ---------- S5-03 行军日历 ---------- */
  try {
    await cmd(() => mini.navigateTo('/pages/calendar/calendar'), 'navigateTo calendar', 2);
    const cal = await waitPath('pages/calendar/calendar');
    await waitFor(async () => {
      const d = await cmd(() => cal.data(), 'calendar data');
      return d && d.loading === false && d.cells.length > 0 ? d : null;
    }, 20000, 500, 'calendar.loading=false');
    const d = await cmd(() => cal.data(), 'calendar data final');
    const dayCells = d.cells.filter((c) => !c.blank);
    const ok = dayCells.length >= 28 && d.stats && typeof d.stats.monthSteps === 'number' &&
      d.monthTitle.indexOf('年') > 0;
    record('S5-03', '行军日历：月历格子 + 月统计条', ok,
      'days=' + dayCells.length + ' monthSteps=' + d.stats.monthSteps + ' title=' + d.monthTitle);
  } catch (e) { record('S5-03', '行军日历', false, e.message); }

  /* ---------- S5-04 日历日期详情弹层 ---------- */
  try {
    const cal = await waitPath('pages/calendar/calendar');
    const d = await cmd(() => cal.data(), 'calendar cells');
    const cell = d.cells.find((c) => !c.blank);
    await cmd(() => cal.callMethod('handleDayTap', { currentTarget: { dataset: { cell } } }), 'handleDayTap', 2);
    await waitFor(async () => {
      const dd = await cmd(() => cal.data('selected'), 'calendar selected');
      return dd ? dd : null;
    }, 8000, 300, 'calendar.selected');
    const sel = await cmd(() => cal.data('selected'), 'calendar selected final');
    await cmd(() => cal.callMethod('closeDetail'), 'closeDetail', 2);
    record('S5-04', '日历点击日期弹当日详情', !!sel && sel.date === cell.date, 'date=' + (sel && sel.date));
    await cmd(() => mini.navigateBack(), 'back from calendar', 2);
    await sleep(800);
  } catch (e) { record('S5-04', '日历日期详情', false, e.message); }

  /* ---------- S5-05 今日长征情报（期号 + 知识画像） ---------- */
  try {
    await cmd(() => mini.switchTab('/pages/quiz/quiz'), 'switchTab quiz', 2);
    const quiz = await waitPath('pages/quiz/quiz');
    await waitFor(async () => {
      const d = await cmd(() => quiz.data(), 'quiz data');
      return d && d.loading === false ? d : null;
    }, 20000, 500, 'quiz.loading=false');
    const d = await cmd(() => quiz.data(), 'quiz data final');
    const cats = d.knowledge && d.knowledge.categories ? d.knowledge.categories : [];
    const keys = cats.map((c) => c.key).sort().join(',');
    const ok = d.issueNo >= 1 && cats.length === 3 && keys === 'event,figure,route' &&
      typeof d.knowledge.overallRate === 'number';
    record('S5-05', '情报页：第 N 期 + 知识画像三分类', ok,
      'issueNo=' + d.issueNo + ' cats=' + keys + ' overallRate=' + (d.knowledge && d.knowledge.overallRate));
  } catch (e) { record('S5-05', '情报页', false, e.message); }

  /* ---------- S5-06 勋章墙分类分组 + 详情 ---------- */
  try {
    await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine for medals', 2);
    const mine = await waitPath('pages/mine/mine');
    await cmd(() => mine.callMethod('goMedals'), 'goMedals', 2);
    const medals = await waitPath('pages/medals/medals');
    await waitFor(async () => {
      const d = await cmd(() => medals.data(), 'medals data');
      return d && d.groups.length > 0 ? d : null;
    }, 20000, 500, 'medals.groups');
    const d = await cmd(() => medals.data(), 'medals data final');
    const first = d.groups[0].medals[0];
    const ok = d.groups.length >= 3 && d.totalCount > 0 && first.icon && first.name;
    record('S5-06', '勋章墙：分类分组 + 隐藏态 + 计数', ok,
      'groups=' + d.groups.map((g) => g.name + '(' + g.medals.length + ')').join('/') + ' owned=' + d.ownedCount);

    await cmd(() => medals.callMethod('handleMedalTap', { currentTarget: { dataset: { item: first } } }), 'handleMedalTap', 2);
    await waitFor(async () => cmd(() => medals.data('selected'), 'medal selected'), 8000, 300, 'medals.selected');
    const sel = await cmd(() => medals.data('selected'), 'medal selected final');
    await cmd(() => medals.callMethod('closeDetail'), 'medal closeDetail', 2);
    record('S5-07', '勋章详情弹层（名称/条件/获得时间）', !!sel && sel.id === first.id && !!sel.desc,
      'name=' + (sel && sel.name) + ' desc=' + (sel && sel.desc));
    await cmd(() => mini.navigateBack(), 'back from medals', 2);
    await sleep(800);
  } catch (e) { record('S5-06', '勋章墙', false, e.message); }

  /* ---------- S5-08 节点详情历史事件卡 ---------- */
  try {
    await cmd(() => mini.navigateTo('/pages/node-detail/node-detail?id=1'), 'navigateTo node-detail', 2);
    const nd = await waitPath('pages/node-detail/node-detail');
    await waitFor(async () => {
      const d = await cmd(() => nd.data(), 'node-detail data');
      return d && d.node ? d : null;
    }, 20000, 500, 'node-detail.node');
    const d = await cmd(() => nd.data(), 'node-detail data final');
    const n = d.node;
    const ok = n.brief.length > 0 && n.location.length > 0 && n.significance.length > 0 &&
      n.figures.length > 0 && d.keywordList.length > 0 && d.markers.length === 1;
    record('S5-08', '节点详情：简介/时间地点/历史意义/人物/关键词/小地图', ok,
      'brief=' + n.brief.slice(0, 18) + '… keywords=' + d.keywordList.join(','));
    await cmd(() => mini.navigateBack(), 'back from node-detail', 2);
    await sleep(800);
  } catch (e) { record('S5-08', '节点详情', false, e.message); }

  /* ---------- S5-09 长征路线页（light-up 幂等 + 模式切换） ---------- */
  try {
    await cmd(() => mini.switchTab('/pages/march/march'), 'switchTab march', 2);
    const march = await waitPath('pages/march/march');
    await waitFor(async () => {
      const d = await cmd(() => march.data(), 'march data');
      return d && d.nodes.length > 0 ? d : null;
    }, 25000, 500, 'march.nodes');
    const d = await cmd(() => march.data(), 'march data final');
    record('S5-09', '长征页：refresh 内 light-up 幂等（无重复点亮弹层）', d.litPopup === null,
      'nodes=' + d.nodes.length + ' lit=' + d.litCount + '/' + d.totalCount + ' litPopup=' + d.litPopup);

    await cmd(() => march.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } }), 'switchMode canvas', 2);
    await waitFor(async () => {
      const dd = await cmd(() => march.data('mode'), 'march mode');
      return dd === 'canvas' ? true : null;
    }, 8000, 300, 'march.mode=canvas');
    await sleep(2500); // canvas 初始化 + 入场动画
    record('S5-10', '长征页：插画地图模式切换（到达动画画布就绪）', true, 'mode=canvas');
  } catch (e) { record('S5-09', '长征页', false, e.message); }

  /* ---------- S5-11 mine 新入口（我的长征/行军日历） ---------- */
  try {
    await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine', 2);
    const mine = await waitPath('pages/mine/mine');
    await waitFor(async () => {
      const d = await cmd(() => mine.data(), 'mine data');
      return d && d.totalCount > 0 ? d : null;
    }, 20000, 500, 'mine data');
    await cmd(() => mine.callMethod('goCalendar'), 'mine goCalendar', 2);
    await waitPath('pages/calendar/calendar');
    await cmd(() => mini.navigateBack(), 'back from mine-calendar', 2);
    await sleep(600);
    const mine2 = await waitPath('pages/mine/mine');
    await cmd(() => mine2.callMethod('goProfile'), 'mine goProfile', 2);
    await waitPath('pages/profile/profile');
    await cmd(() => mini.navigateBack(), 'back from mine-profile', 2);
    await sleep(600);
    record('S5-11', '我的：数据引 profile 口径 + 我的长征/行军日历入口', true, 'goCalendar/goProfile 均到达目标页');
  } catch (e) { record('S5-11', '我的入口', false, e.message); }

  /* ---------- 落盘 ---------- */
  const passed = results.filter((r) => r.pass).length;
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ passed, total: results.length, results }, null, 2));
  console.log('===== S5 DONE ===== 通过 ' + passed + '/' + results.length);
  try { await withTimeout(mini.disconnect(), 6000, 'disconnect'); } catch (e) { /* ignore */ }
  process.exit(passed === results.length ? 0 : 1);
})().catch(async (e) => {
  console.log('S5 CRASH: ' + e.message);
  const passed = results.filter((r) => r.pass).length;
  try { fs.writeFileSync(RESULTS_FILE, JSON.stringify({ passed, total: results.length, crash: e.message, results }, null, 2)); } catch (x) { /* ignore */ }
  try { if (mini) await withTimeout(mini.disconnect(), 6000, 'disconnect'); } catch (x) { /* ignore */ }
  process.exit(2);
});
