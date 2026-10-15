/**
 * V2.0 小程序验收（断言先行，截图放末尾；每个截图状态以主动导航开头）
 *
 *   R01 排行榜：前三领奖台 + 4~10 精英卡 + 11 名起列表，与 /rank/points 同口径，「我的名次」一致
 *   R02 排行榜上拉加载第 2 页（追加且不重复）
 *   P01 「我的」积分卡：总/步行/答题/排名 与 /points 一致，入口「积分明细」
 *   P02 积分明细页：汇总 + 规则（来自后端 rules）+ 按日明细条数与 /points/daily 一致
 *   H01 「我的长征」荣誉卡：总积分/步行/答题/排名 与 /profile/summary 一致
 *   Q01 答题开题：90 秒服务器倒计时、第 1 题、进度点
 *   Q02 答对即时反馈 +2；同题重复提交被后端拒绝
 *   Q03 答错反馈 0 分并展示正确答案
 *   Q04 倒计时归零进入超时态；后端拒绝超时提交
 *   Q05 完成后结果页：答对数 / 正确率 / 答题积分 / 超时数 / 逐题结果
 *   Q06 答题积分进入积分台账（/points todayQuiz）并与排行榜 me.points 一致
 *   O01 未选组织可选择；选定后再进入为只读锁定页，二次选择后端 403
 *   A01 活动结束且关闭查看：启动后进入活动状态页（结束标题/文案/时间），查看接口 403 + X-Activity-Status
 *   A02 活动结束可查看：首页展示「已结束」横幅，参与接口（开题）被拒
 * 截图：50-v2-rank.png / 51-v2-mine-points.png / 52-v2-points-detail.png / 53-v2-profile-honor.png /
 *       54-v2-quiz-answering.png / 55-v2-quiz-feedback.png / 56-v2-quiz-result.png / 57-v2-org-locked.png /
 *       58-v2-activity-ended.png / 59-v2-home-ended-banner.png
 *
 *   node v2-miniprogram.cjs            # 全量（含 90 秒超时用例）
 *
 * 前置：后端 8010 运行；开发者工具自动化端口 9420；
 *       ../v12-fixture.json（测试用户 token/题库答案）与临时目录 admin_login.json（管理员 token），均不入库。
 * 活动设置在用例中临时修改，结束时（含异常）恢复为原配置。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'v12-fixture.json'), 'utf8'));
const ADMIN_TOKEN = JSON.parse(fs.readFileSync(
  process.env.LM_ADMIN_LOGIN || path.join(os.tmpdir(), 'lm', 'admin_login.json'), 'utf8')).token;
const RESULTS_FILE = path.join(__dirname, 'results-v2.json');
const IMAGES = path.join(__dirname, '..', 'images');
const SKIP_TIMEOUT = process.argv.includes('--skip-timeout');
// 截图与断言分离：--shots-only 只补拍（不覆盖断言结果），--shots-from=57 从指定编号续拍，--no-shots 只跑断言
const SHOTS_ONLY = process.argv.includes('--shots-only');
const NO_SHOTS = process.argv.includes('--no-shots');
const SHOTS_FROM = (process.argv.find((a) => a.indexOf('--shots-from=') === 0) || '').split('=')[1] || '';
const results = [];
let mini = null;
let originalActivity = null;

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
  results.push({ id, name, pass: !!pass, detail: String(detail == null ? '' : detail).slice(0, 500) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + (detail ? ' | ' + detail : ''));
}

async function check(id, name, fn) {
  try {
    const out = await fn();
    record(id, name, out.pass, out.detail);
  } catch (e) {
    record(id, name, false, 'ERROR ' + (e && e.message));
  }
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

async function waitFor(fn, timeout = 15000, desc = 'condition') {
  const start = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { /* retry */ }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('等待超时: ' + desc);
    await sleep(400);
  }
}

function http_(token, path_, method, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const req = http.request({
      host: '127.0.0.1', port: 8010, path: '/api' + path_, method: method || 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + token },
        body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {})
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const api = (p, m, d) => http_(FIXTURE.token, p, m, d);
const adminApi = (p, m, d) => http_(ADMIN_TOKEN, p, m, d);

async function connectMini() {
  for (let i = 0; i < 3; i++) {
    try { return await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect'); } catch (e) {
      console.log('connect 失败(' + (i + 1) + '/3): ' + e.message);
      await sleep(6000);
    }
  }
  throw new Error('无法连接自动化桥');
}

/** 注入测试用户 Token，经启动页校验后进入 expectPath（默认首页） */
async function loginWithToken(expectPath) {
  await cmd(() => mini.evaluate((token) => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    wx.clearStorageSync();
    wx.setStorageSync('lm_auth_token', token);
    return true;
  }, FIXTURE.token), 'inject token', 2);
  await cmd(() => mini.reLaunch('/pages/launch/launch'), 'reLaunch launch', 2);
  const page = await waitPath(expectPath || 'pages/home/home', 30000);
  await sleep(1000);
  return page;
}

function rightLabel(q) { return (FIXTURE.answers[q.id] || [])[0]; }
function wrongLabel(q) { return q.options.find((o) => o.label !== rightLabel(q)).label; }

/** 活动配置（北京时间分钟精度）：以原配置为底按需覆盖 */
function activityPayload(over) {
  const o = originalActivity;
  return Object.assign({
    name: o.name,
    startAt: o.start_at.slice(0, 16),
    endAt: o.end_at.slice(0, 16),
    restrictEnabled: o.restrict_enabled,
    allowViewAfterEnd: o.allow_view_after_end,
    endTitle: o.end_title,
    endMessage: o.end_message
  }, over);
}

function toSnake(obj) {
  const out = {};
  Object.keys(obj).forEach((k) => { out[k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())] = obj[k]; });
  return out;
}

async function setActivity(over) {
  const res = await adminApi('/admin/activity', 'PUT', toSnake(activityPayload(over)));
  if (res.status !== 200) throw new Error('保存活动设置失败 ' + res.status + ' ' + JSON.stringify(res.body));
  return res.body;
}

async function restoreActivity() {
  if (!originalActivity) return;
  const res = await adminApi('/admin/activity', 'PUT', toSnake(activityPayload({})));
  console.log('活动设置已恢复: ' + res.status + ' ' + (res.body && res.body.status));
}

/** 结束时间设为「1 天前」（开始再早 30 天），即已结束 */
function endedWindow() {
  const fmt = (d) => new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16);
  const now = Date.now();
  return { startAt: fmt(new Date(now - 31 * 86400000)), endAt: fmt(new Date(now - 86400000)) };
}

async function openAnswerPage() {
  await cmd(() => mini.navigateTo('/pages/quiz-answer/quiz-answer'), 'open quiz-answer', 2);
  const page = await waitPath('pages/quiz-answer/quiz-answer');
  await waitFor(async () => ((await page.data()).phase === 'answering' ? true : null), 15000, 'question opened');
  return page;
}

async function answerOnPage(page, label) {
  await cmd(() => page.callMethod('handleSelect', { currentTarget: { dataset: { label } } }), 'select ' + label, 1);
  await cmd(() => page.callMethod('handleSubmit'), 'submit', 1);
  return waitFor(async () => {
    const d = await page.data();
    return d.phase === 'feedback' ? d : null;
  }, 10000, 'feedback');
}

async function nextQuestion(expectSeq) {
  const page = await waitPath('pages/quiz-answer/quiz-answer');
  await cmd(() => page.callMethod('handleNext'), 'next', 1);
  return waitFor(async () => {
    const p = await mini.currentPage();
    if (p.path.indexOf('pages/quiz-result') === 0) return p;
    const d = await p.data();
    return d.phase === 'answering' && d.seq === expectSeq ? p : null;
  }, 15000, 'next question ' + expectSeq);
}

async function run() {
  originalActivity = (await adminApi('/admin/activity')).body;
  if (!originalActivity || !originalActivity.configured) throw new Error('活动设置读取失败');
  if (originalActivity.status !== 'ongoing') throw new Error('前置条件：活动需为进行中，当前 ' + originalActivity.status);

  mini = await connectMini();
  if (SHOTS_ONLY) {
    await takeShots();
    return;
  }
  await loginWithToken();
  const reset = await api('/quiz/reset', 'POST');
  if (reset.status !== 200) throw new Error('重置今日答题失败 ' + reset.status);

  // ---------- 排行榜 ----------
  await check('R01', '排行榜领奖台/精英卡/列表与后端同口径', async () => {
    await cmd(() => mini.switchTab('/pages/rank/rank'), 'switchTab rank', 2);
    const page = await waitPath('pages/rank/rank');
    const d = await waitFor(async () => { const x = await page.data(); return x.podium && x.podium.length ? x : null; }, 15000, 'rank loaded');
    const apiRank = (await api('/rank/points?page=1&page_size=20')).body;
    const podiumRanks = d.podium.map((p) => p.rank).join(',');
    const topIds = apiRank.top.map((t) => t.userId).join(',');
    const pageIds = d.podium.slice().sort((a, b) => a.rank - b.rank).concat(d.elite).map((t) => t.userId).join(',');
    const podiumEls = (await page.$$('.podium-col')).length;
    const eliteEls = (await page.$$('.elite-card')).length;
    const pass = podiumRanks === '2,1,3' && pageIds === topIds && d.elite.length === Math.max(0, apiRank.top.length - 3)
      && d.list.length === apiRank.list.length && (d.list[0] ? d.list[0].rank === 11 : true)
      && d.me && d.me.rank === apiRank.me.rank && d.me.points === apiRank.me.points
      && podiumEls === 3 && eliteEls === d.elite.length;
    return { pass, detail: 'podium=' + podiumRanks + ' elite=' + d.elite.length + ' list=' + d.list.length + ' me=' + (d.me && d.me.rank) + ' total=' + d.total };
  });

  await check('R02', '排行榜上拉加载第 2 页', async () => {
    const page = await waitPath('pages/rank/rank');
    const before = await page.data();
    if (!before.hasMore) return { pass: true, detail: '仅 1 页（total=' + before.total + '），无需分页' };
    await cmd(() => page.callMethod('onReachBottom'), 'reach bottom', 1);
    const d = await waitFor(async () => { const x = await page.data(); return x.list.length > before.list.length ? x : null; }, 15000, 'page 2');
    const ranks = d.list.map((x) => x.rank);
    const contiguous = ranks.every((r, i) => r === 11 + i);
    return { pass: contiguous, detail: 'list ' + before.list.length + '→' + d.list.length + ' last=' + ranks[ranks.length - 1] };
  });

  // ---------- 积分 ----------
  const pts0 = (await api('/points')).body;
  await check('P01', '「我的」积分卡与 /points 一致', async () => {
    await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine', 2);
    const page = await waitPath('pages/mine/mine');
    const d = await waitFor(async () => { const x = await page.data(); return x.points ? x : null; }, 15000, 'mine points');
    const menus = [];
    for (const el of await page.$$('.menu-item')) menus.push((await el.text()).replace(/\s+/g, ''));
    const p = d.points;
    // 已选组织的用户重新登录后，组织行须以后端全称回显（本地缓存无 orgFullName 时由 /profile/summary 回填）
    const orgMine = (await api('/org/mine')).body;
    const orgText = ((await (await page.$('.mine-org-text')).text()) || '').trim();
    const orgOk = orgMine.orgId ? orgText === orgMine.fullName : orgText === '点击选择组织架构';
    const pass = p.total === pts0.total && p.walk === pts0.walk && p.quiz === pts0.quiz && p.rank === pts0.rank
      && p.total === p.walk + p.quiz && menus[0] === '积分明细›' && orgOk;
    return { pass, detail: JSON.stringify(p) + ' menus0=' + menus[0] + ' org=' + orgText };
  });

  await check('P02', '积分明细页汇总/规则/按日明细', async () => {
    await cmd(() => mini.navigateTo('/pages/points/points'), 'open points', 2);
    const page = await waitPath('pages/points/points');
    const d = await waitFor(async () => { const x = await page.data(); return !x.loading ? x : null; }, 15000, 'points loaded');
    const daily = (await api('/points/daily?page=1&page_size=20')).body;
    const ruleText = [];
    for (const el of await page.$$('.rule-line')) ruleText.push(await el.text());
    const pass = d.summary.total === pts0.total && d.rules.walkStepsPerPoint === 1000 && d.rules.quizPerCorrect === 2
      && d.items.length === daily.items.length && ruleText.length === 4 && ruleText[0].indexOf('1000') >= 0;
    return { pass, detail: 'total=' + d.summary.total + ' items=' + d.items.length + '/' + daily.total + ' rule0=' + ruleText[0] };
  });

  await check('H01', '「我的长征」荣誉卡与 /profile/summary 一致', async () => {
    await cmd(() => mini.navigateTo('/pages/profile/profile'), 'open profile', 2);
    const page = await waitPath('pages/profile/profile');
    const d = await waitFor(async () => { const x = await page.data(); return !x.loading ? x : null; }, 15000, 'profile loaded');
    const s = (await api('/profile/summary')).body;
    const card = await page.$('.honor-card');
    const total = card ? (await (await page.$('.honor-total')).text()).trim() : '';
    const pass = !!card && Number(total) === s.points.total && d.summary.points.rank === s.points.rank
      && d.summary.points.walk === s.points.walk && d.summary.points.quiz === s.points.quiz;
    return { pass, detail: 'honorTotal=' + total + ' api=' + JSON.stringify(s.points) };
  });

  // ---------- 答题（逐题 90 秒） ----------
  await cmd(() => mini.switchTab('/pages/quiz/quiz'), 'switchTab quiz', 2);
  await waitPath('pages/quiz/quiz');
  let page = null;
  await check('Q01', '开题：90 秒服务器倒计时、第 1 题、进度点', async () => {
    page = await openAnswerPage();
    const d = await page.data();
    const dots = d.dots.map((x) => x.cls).join(',');
    const pass = d.seq === 1 && d.total === 5 && d.timeLimit === 90 && d.remainSec <= 90 && d.remainSec >= 85
      && dots === 'answering,pending,pending,pending,pending' && !('answer' in d.question) && !!d.ring;
    return { pass, detail: 'seq=' + d.seq + ' remain=' + d.remainSec + ' dots=' + dots };
  });

  await check('Q02', '答对即时反馈 +2，重复提交被拒', async () => {
    const d0 = await page.data();
    const d = await answerOnPage(page, rightLabel(d0.question));
    const dup = await api('/quiz/answer', 'POST', { questionId: d0.question.id, answer: [rightLabel(d0.question)] });
    const pass = d.feedback.correct === true && d.feedback.points === 2 && d.feedback.todayPoints === 2
      && d.dots[0].cls === 'right' && dup.status === 400 && String(dup.body.detail).indexOf('重复') >= 0;
    return { pass, detail: 'fb=' + JSON.stringify(d.feedback).slice(0, 120) + ' dup=' + dup.status + ' ' + (dup.body && dup.body.detail) };
  });

  await check('Q03', '答错反馈 0 分并展示正确答案', async () => {
    page = await nextQuestion(2);
    const d0 = await page.data();
    const d = await answerOnPage(page, wrongLabel(d0.question));
    const wrongOpt = d.options.find((o) => o.state === 'wrong');
    const rightOpt = d.options.find((o) => o.state === 'right');
    const pass = d.feedback.correct === false && d.feedback.points === 0 && !!wrongOpt && !!rightOpt
      && rightOpt.label === rightLabel(d0.question) && d.dots[1].cls === 'wrong';
    return { pass, detail: 'right=' + (rightOpt && rightOpt.label) + ' wrong=' + (wrongOpt && wrongOpt.label) };
  });

  await check('Q04', '倒计时归零进入超时态，后端拒绝超时提交', async () => {
    page = await nextQuestion(3);
    const d0 = await page.data();
    if (SKIP_TIMEOUT) return { pass: true, detail: '已跳过（--skip-timeout）' };
    console.log('等待第 3 题倒计时归零（约 ' + d0.remainSec + ' 秒）…');
    const d = await waitFor(async () => { const x = await page.data(); return x.phase === 'timeout' ? x : null; }, (d0.remainSec + 15) * 1000, 'timeout phase');
    // 后端截止后有 QUIZ_ANSWER_GRACE_SECONDS=2 秒网络宽限，迟交须越过宽限才应被拒
    await sleep(3500);
    const late = await api('/quiz/answer', 'POST', { questionId: d0.question.id, answer: [rightLabel(d0.question)] });
    const pass = d.dots[2].cls === 'timeout' && d.remainSec === 0 && late.status === 400
      && String(late.body.detail).indexOf('超时') >= 0;
    return { pass, detail: 'dots3=' + d.dots[2].cls + ' late=' + late.status + ' ' + (late.body && late.body.detail) };
  });

  await check('Q05', '结果页：答对数/正确率/答题积分/超时/逐题结果', async () => {
    for (const seq of [4, 5]) {
      page = await nextQuestion(seq);
      const d0 = await page.data();
      await answerOnPage(page, rightLabel(d0.question));
    }
    await cmd(() => page.callMethod('handleNext'), 'to result', 1);
    const result = await waitPath('pages/quiz-result/quiz-result', 20000);
    const rd0 = await waitFor(async () => { const x = await result.data(); return x.record && x.details.length ? x : null; }, 15000, 'result');
    await sleep(1500);
    const rd = Object.assign({}, rd0, { displayAccuracy: (await result.data()).displayAccuracy });
    const r = rd.record;
    const verdicts = rd.details.map((x) => x.verdict).join(',');
    const timeoutCount = SKIP_TIMEOUT ? 0 : 1;
    const correct = SKIP_TIMEOUT ? r.correctCount : 3;
    const pass = r.correctCount === correct && r.points === correct * 2 && r.timeoutCount === timeoutCount
      && r.accuracy === Math.round((correct / 5) * 100) && rd.details.length === 5
      && (SKIP_TIMEOUT || verdicts === 'right,wrong,timeout,right,right') && rd.displayAccuracy === r.accuracy;
    return { pass, detail: 'correct=' + r.correctCount + ' points=' + r.points + ' acc=' + r.accuracy + ' timeout=' + r.timeoutCount + ' verdicts=' + verdicts };
  });

  await check('Q06', '答题积分入台账并与排行榜一致', async () => {
    const p = (await api('/points')).body;
    const rk = (await api('/rank/points?page=1&page_size=20')).body;
    const quizRec = (await api('/quiz/daily')).body;
    const pass = p.todayQuiz === quizRec.points && p.total === p.walk + p.quiz && rk.me.points === p.total
      && p.total - pts0.total === p.todayQuiz - pts0.todayQuiz;
    return { pass, detail: 'todayQuiz=' + p.todayQuiz + ' total=' + p.total + ' rankMe=' + rk.me.points + ' (before ' + pts0.total + ')' };
  });

  // ---------- 组织锁定 ----------
  await check('O01', '首次选定后锁定只读，二次选择 403', async () => {
    const mine0 = (await api('/org/mine')).body;
    let selectedVia = 'pre-locked';
    if (!mine0.locked) {
      await cmd(() => mini.navigateTo('/pages/org-select/org-select?from=mine'), 'open org-select', 2);
      const sel = await waitPath('pages/org-select/org-select');
      const d = await waitFor(async () => { const x = await sel.data(); return x.list && x.list.length ? x : null; }, 15000, 'org list');
      if (d.locked) throw new Error('未锁定用户却展示锁定页');
      await cmd(() => sel.callMethod('confirmSelect', d.list[0].id), 'confirm select', 1);
      await waitFor(async () => ((await api('/org/mine')).body.locked ? true : null), 10000, 'org locked');
      selectedVia = 'ui:' + d.list[0].name;
      await sleep(1500);
    }
    await cmd(() => mini.navigateTo('/pages/org-select/org-select?from=mine'), 'reopen org-select', 2);
    const sel2 = await waitPath('pages/org-select/org-select');
    const d2 = await waitFor(async () => { const x = await sel2.data(); return x.locked ? x : null; }, 15000, 'locked view');
    const tip = await sel2.$('.locked-tip');
    const again = await api('/org/select', 'POST', { orgId: (await api('/org/mine')).body.orgId });
    const pass = d2.locked && !!d2.lockedName && !!tip && again.status === 403;
    return { pass, detail: selectedVia + ' locked=' + d2.lockedName + ' again=' + again.status + ' ' + (again.body && again.body.detail) };
  });

  // ---------- 活动时间控制 ----------
  await check('A01', '活动结束且关闭查看：进入活动状态页，查看接口 403', async () => {
    await setActivity(Object.assign(endedWindow(), { allowViewAfterEnd: false }));
    const page = await loginWithToken('pages/activity/activity');
    const d = await waitFor(async () => { const x = await page.data(); return x.status ? x : null; }, 15000, 'activity status');
    const blocked = await api('/points');
    const pass = d.status.status === 'ended' && d.status.allowView === false && d.title === originalActivity.end_title
      && !!d.rangeText && blocked.status === 403 && blocked.headers['x-activity-status'] === 'ended';
    return { pass, detail: 'title=' + d.title + ' range=' + d.rangeText + ' points=' + blocked.status + '/' + blocked.headers['x-activity-status'] };
  });

  await check('A02', '活动结束可查看：首页横幅，参与接口被拒', async () => {
    await setActivity(Object.assign(endedWindow(), { allowViewAfterEnd: true }));
    const home = await loginWithToken('pages/home/home');
    const d = await waitFor(async () => { const x = await home.data(); return x.activityBanner ? x : null; }, 15000, 'banner');
    const start = await api('/quiz/start', 'POST');
    const pass = d.activityBanner.tag === '已结束' && start.status === 403 && start.headers['x-activity-status'] === 'ended';
    return { pass, detail: 'banner=' + JSON.stringify(d.activityBanner) + ' start=' + start.status };
  });
  await restoreActivity();

  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ results }, null, 2));
  console.log('断言已落盘' + (NO_SHOTS ? '（--no-shots 跳过截图）' : '，开始截图'));
  if (!NO_SHOTS) await takeShots();
}

async function shot(name) {
  await sleep(1200);
  await cmd(() => mini.screenshot({ path: path.join(IMAGES, name) }), 'shot ' + name, 1)
    .catch((e) => console.log('截图失败 ' + name + ': ' + e.message));
}

async function takeShots() {
  const steps = [
    ['50-v2-rank.png', async () => {
      await cmd(() => mini.switchTab('/pages/rank/rank'), 'shot rank', 2);
      await waitPath('pages/rank/rank');
    }],
    ['51-v2-mine-points.png', async () => {
      await cmd(() => mini.switchTab('/pages/mine/mine'), 'shot mine', 2);
      await waitPath('pages/mine/mine');
    }],
    ['52-v2-points-detail.png', async () => {
      await cmd(() => mini.navigateTo('/pages/points/points'), 'shot points', 2);
      await waitPath('pages/points/points');
    }],
    ['53-v2-profile-honor.png', async () => {
      await cmd(() => mini.reLaunch('/pages/profile/profile'), 'shot profile', 2);
      await waitPath('pages/profile/profile');
    }],
    ['55-v2-quiz-feedback.png', async () => {
      await api('/quiz/reset', 'POST');
      const page = await openAnswerPage();
      const d0 = await page.data();
      await answerOnPage(page, rightLabel(d0.question));
    }],
    ['54-v2-quiz-answering.png', async () => {
      const page = await openAnswerPage();
      const d0 = await page.data();
      await cmd(() => page.callMethod('handleSelect', { currentTarget: { dataset: { label: rightLabel(d0.question) } } }), 'shot select', 1);
    }],
    ['56-v2-quiz-result.png', async () => {
      for (let i = 0; i < 4; i++) {
        const st = (await api('/quiz/start', 'POST')).body;
        if (!st.current) break;
        const q = st.current.question;
        await api('/quiz/answer', 'POST', { questionId: q.id, answer: [i === 0 ? wrongLabel(q) : rightLabel(q)] });
      }
      await cmd(() => mini.reLaunch('/pages/quiz-result/quiz-result'), 'shot result', 2);
      await waitPath('pages/quiz-result/quiz-result');
      await sleep(2500);
    }],
    ['57-v2-org-locked.png', async () => {
      await cmd(() => mini.reLaunch('/pages/org-select/org-select?from=mine'), 'shot org', 2);
      await waitPath('pages/org-select/org-select');
    }],
    ['58-v2-activity-ended.png', async () => {
      await setActivity(Object.assign(endedWindow(), { allowViewAfterEnd: false }));
      await cmd(() => mini.reLaunch('/pages/activity/activity'), 'shot activity', 2);
      await waitPath('pages/activity/activity');
    }],
    ['59-v2-home-ended-banner.png', async () => {
      await setActivity(Object.assign(endedWindow(), { allowViewAfterEnd: true }));
      await cmd(() => mini.reLaunch('/pages/home/home'), 'shot home', 2);
      await waitPath('pages/home/home');
      await sleep(1500);
    }]
  ];
  await loginWithToken();
  for (const [name, prepare] of steps) {
    if (SHOTS_FROM && name.slice(0, 2) < SHOTS_FROM) continue;
    await prepare();
    await shot(name);
  }
  await restoreActivity();
}

run()
  .catch((e) => {
    console.log('ERROR ' + (e && e.stack ? e.stack : e));
    record('RUN', '脚本执行', false, e && e.message);
  })
  .finally(async () => {
    await restoreActivity().catch((e) => console.log('恢复活动设置失败: ' + e.message));
    if (!SHOTS_ONLY) fs.writeFileSync(RESULTS_FILE, JSON.stringify({ results }, null, 2));
    const passed = results.filter((r) => r.pass).length;
    console.log('\n== V2.0 小程序验收: ' + passed + '/' + results.length + ' 通过 ==');
    try { mini && mini.disconnect(); } catch (e) { /* ignore */ }
    process.exit(passed === results.length ? 0 : 1);
  });
