/**
 * 情报 tab 双答题交互模式验收（情报1 即时判定 / 情报2 交卷看解析）
 *
 *   M1 情报 tab 模式切换：默认即时判定；切到情报2 后 data.mode=review 且高亮项切换
 *   M2 即时判定回归：提交后即时进入 feedback（对错/解析），进度点 right/wrong
 *   M3 交卷模式不揭示对错：每次提交无 feedback、选项无 right/wrong、静默推进 seq+1
 *   M4 交卷模式进度点为中性 done（无 right/wrong）
 *   M5 交卷模式 5 题全部提交后进入 submitted 交卷态
 *   M6 交卷模式「查看全部解析」→ quiz-result 逐题解析 5 条
 *
 *   node v2-quiz-modes.cjs
 *
 * 前置：后端 8010 运行；开发者工具自动化端口 9420；../v12-fixture.json（测试用户 token/题库答案）。
 * 结果：results-v2-quiz-modes.json
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => console.log('未处理 rejection: ' + (e && e.message ? e.message : e)));

const WS = 'ws://127.0.0.1:9420';
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'v12-fixture.json'), 'utf8'));
const RESULTS_FILE = path.join(__dirname, 'results-v2-quiz-modes.json');
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
const answerLabel = (id) => (FIXTURE.answers[id] || [])[0] || '';

async function connectMini() {
  for (let i = 0; i < 3; i++) {
    try { return await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect'); } catch (e) {
      console.log('connect 失败(' + (i + 1) + '/3): ' + e.message);
      await sleep(6000);
    }
  }
  throw new Error('无法连接自动化桥');
}

async function loginWithToken(expectPath) {
  await cmd(() => mini.evaluate((token) => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    wx.clearStorageSync();
    wx.setStorageSync('lm_auth_token', token);
    return true;
  }, FIXTURE.token), '注入 token', 2);
  await cmd(() => mini.reLaunch('/pages/launch/launch'), 'reLaunch launch', 2);
  const page = await waitPath(expectPath || 'pages/home/home', 30000);
  await sleep(1000);
  return page;
}

async function resetQuiz() {
  const r = await api('/quiz/reset', 'POST');
  if (r.status !== 200) throw new Error('重置今日答题失败 ' + r.status);
}

/** 打开答题页（可带 mode），等待进入 answering */
async function openAnswerPage(mode) {
  const url = '/pages/quiz-answer/quiz-answer' + (mode === 'review' ? '?mode=review' : '');
  await cmd(() => mini.navigateTo(url), 'open answer ' + (mode || 'instant'), 2);
  const page = await waitPath('pages/quiz-answer/quiz-answer');
  await waitFor(async () => ((await page.data()).phase === 'answering' ? true : null), 15000, 'question opened');
  return page;
}

/** 回到情报 tab 并切换模式 */
async function switchQuizTabMode(mode) {
  await cmd(() => mini.switchTab('/pages/quiz/quiz'), 'switchTab quiz', 2);
  const page = await waitPath('pages/quiz/quiz');
  await cmd(() => page.callMethod('handleModeChange', { currentTarget: { dataset: { mode } } }), 'mode ' + mode, 1);
  return page;
}

/** 断言页面处于不揭示对错的作答态 */
function leakFree(d) {
  const optStates = (d.options || []).map((o) => o.state);
  const badOpt = optStates.some((s) => s === 'right' || s === 'wrong');
  const badDot = (d.dots || []).some((x) => x.cls === 'right' || x.cls === 'wrong');
  return { ok: !badOpt && !badDot && !d.feedback, detail: 'optStates=' + optStates.join(',') + ' dots=' + (d.dots || []).map((x) => x.cls).join(',') + ' feedback=' + (d.feedback ? 'yes' : 'no') };
}

async function run() {
  mini = await connectMini();
  await loginWithToken();
  await resetQuiz();

  // ---------- M1 模式切换 ----------
  await check('M1', '情报 tab 模式切换（默认即时判定→情报2）', async () => {
    await cmd(() => mini.switchTab('/pages/quiz/quiz'), 'switchTab quiz', 2);
    let page = await waitPath('pages/quiz/quiz');
    const d0 = await page.data();
    const defaultInstant = d0.mode === 'instant';
    page = await switchQuizTabMode('review');
    await waitFor(async () => ((await page.data()).mode === 'review' ? true : null), 8000, 'mode review');
    const activeEl = await page.$('.mode-item.active');
    const activeText = activeEl ? await activeEl.text() : '';
    return { pass: defaultInstant && /交卷看解析/.test(activeText), detail: 'default=' + d0.mode + ' active=' + activeText };
  });

  // ---------- M2 即时判定回归 ----------
  await check('M2', '即时判定：提交后即时反馈对错/解析', async () => {
    await switchQuizTabMode('instant');
    await resetQuiz();
    await switchQuizTabMode('instant');
    const page = await openAnswerPage('instant');
    const d = await page.data();
    const label = answerLabel(d.question.id) || d.options[0].label;
    await cmd(() => page.callMethod('handleSelect', { currentTarget: { dataset: { label } } }), 'select', 1);
    await cmd(() => page.callMethod('handleSubmit'), 'submit', 1);
    const fb = await waitFor(async () => { const x = await page.data(); return x.phase === 'feedback' ? x : null; }, 10000, 'feedback');
    const hasVerdict = fb.feedback && typeof fb.feedback.correct === 'boolean';
    const hasMarked = (fb.options || []).some((o) => o.state === 'right' || o.state === 'wrong');
    const dotMarked = (fb.dots || []).some((x) => x.cls === 'right' || x.cls === 'wrong');
    return { pass: !!hasVerdict && hasMarked && dotMarked, detail: 'correct=' + (fb.feedback && fb.feedback.correct) + ' marked=' + hasMarked + ' dot=' + dotMarked };
  });

  // ---------- M3/M4 交卷模式不揭示 ----------
  await check('M3', '交卷模式：作答中提交不揭示对错、静默推进', async () => {
    await switchQuizTabMode('review');
    await resetQuiz();
    await switchQuizTabMode('review');
    const page = await openAnswerPage('review');
    let d = await page.data();
    const modeReview = d.mode === 'review';
    let clean = true;
    let detail = '';
    for (let i = 1; i <= 5; i++) {
      const before = await page.data();
      const lf = leakFree(before);
      if (!lf.ok) { clean = false; detail = 'q' + i + ' ' + lf.detail; break; }
      const label = answerLabel(before.question.id) || before.options[0].label;
      await cmd(() => page.callMethod('handleSelect', { currentTarget: { dataset: { label } } }), 'sel q' + i, 1);
      await cmd(() => page.callMethod('handleSubmit'), 'submit q' + i, 1);
      if (i < 5) {
        const nx = await waitFor(async () => { const x = await page.data(); return (x.phase === 'answering' && x.seq === i + 1) ? x : null; }, 15000, 'next q' + (i + 1));
        const lf2 = leakFree(nx);
        if (!lf2.ok) { clean = false; detail = 'q' + (i + 1) + ' ' + lf2.detail; break; }
      } else {
        const sb = await waitFor(async () => { const x = await page.data(); return x.phase === 'submitted' ? x : null; }, 15000, 'submitted');
        d = sb;
      }
    }
    return { pass: modeReview && clean, detail: modeReview ? detail || '5 题均无对错泄露' : 'mode=' + d.mode };
  });

  // ---------- M5 交卷态 + M4 进度点中性 ----------
  await check('M5', '交卷模式：5 题提交后进入交卷态，进度点全为 done', async () => {
    const page = await waitPath('pages/quiz-answer/quiz-answer');
    const d = await page.data();
    const submitted = d.phase === 'submitted';
    const card = (await page.$$('.feedback-card.submitted')).length;
    const cls = (d.dots || []).map((x) => x.cls);
    const allDone = cls.length === 5 && cls.every((c) => c === 'done');
    const noVerdict = (d.options || []).every((o) => o.state !== 'right' && o.state !== 'wrong');
    return { pass: submitted && card === 1 && allDone && noVerdict, detail: 'phase=' + d.phase + ' dots=' + cls.join(',') + ' card=' + card };
  });

  // ---------- M6 查看全部解析 ----------
  await check('M6', '交卷模式：查看全部解析 → 结果页逐题解析', async () => {
    const page = await waitPath('pages/quiz-answer/quiz-answer');
    await cmd(() => page.callMethod('handleViewResult'), 'view result', 1);
    const rp = await waitPath('pages/quiz-result/quiz-result');
    const d = await waitFor(async () => { const x = await rp.data(); return x.details && x.details.length ? x : null; }, 15000, 'result details');
    return { pass: d.details.length === 5, detail: 'details=' + d.details.length + ' correct=' + d.record.correctCount + '/' + d.record.totalCount };
  });

  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ time: new Date().toISOString(), results }, null, 2));
  const pass = results.filter((r) => r.pass).length;
  console.log('\n合计 ' + pass + '/' + results.length + ' 通过 → ' + RESULTS_FILE);
}

run().catch((e) => {
  console.log('运行异常: ' + (e && e.stack ? e.stack : e));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ time: new Date().toISOString(), error: String(e && e.message), results }, null, 2));
  process.exit(1);
});
