/**
 * P1-8 长征人物志 + 答题连续答对效果（小程序侧）验收（断言先行，截图放末尾）
 *
 * 覆盖（需求 §14/§15）：
 *   P1R-01 节点详情人物入口：飞夺泸定桥 persons 含王开湘/杨成武/廖大珠，人物 chip 渲染
 *   P1R-02 人物志详情：头像占位/名称/简介/相关历史事件（含历史时间），
 *         点击事件卡回跳节点详情（人物 → 节点双向）
 *   P1R-03 答题连胜反馈：选对 → 🔥连续1题；下一题选错 → 连胜清零并提示重新开始
 *   P1R-04 满分通关：5 题全对提交 → 结果页「今日情报完美通关」5 / 5 · 100 分 + 彩带
 * 末尾截图：30-person-detail.png / 31-quiz-streak.png / 32-quiz-perfect.png
 *
 *   node p1-persons-quiz.cjs
 *
 * 前置：后端 8010 运行（含 006_persons.sql）；开发者工具自动化端口 9420 可用。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const NICKNAME = 'P1人物';
const AVATAR = 'https://example.com/auto-avatar.png';
const RESULTS_FILE = path.join(__dirname, 'results-p1r.json');
const SHOT_PERSON = path.join(__dirname, '..', 'images', '30-person-detail.png');
const SHOT_STREAK = path.join(__dirname, '..', 'images', '31-quiz-streak.png');
const SHOT_PERFECT = path.join(__dirname, '..', 'images', '32-quiz-perfect.png');

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
  const code = 'automator-p1r-' + Date.now();
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

/** 用 /quiz/check 逐选项探测每题正确选项（测试构造用） */
async function probeAnswers(token, questions) {
  const map = {};
  for (const q of questions) {
    for (const opt of q.options) {
      const r = await api('/quiz/check', token, 'POST', { questionId: q.id, answer: [opt.label] });
      if (r.status === 200 && r.body && r.body.correct) { map[q.id] = opt.label; break; }
    }
  }
  return map;
}

(async () => {
  mini = await connectMini();
  const code = await freshLogin();
  const token = await apiToken(code);

  /* ===== 人物志（§14） ===== */
  await cmd(() => mini.reLaunch('/pages/node-detail/node-detail?id=6'), 'reLaunch node-detail 6', 2);
  const nodePage = await waitPath('pages/node-detail/node-detail');
  const nd = await waitFor(async () => {
    const dd = await cmd(() => nodePage.data(), 'node data');
    return dd && dd.node ? dd : null;
  }, 15000, 500, 'node detail ready');

  // P1R-01 节点详情人物入口
  const personNames = (nd.node.persons || []).map((p) => p.name);
  const chipEl = await cmd(() => nodePage.$('.figure-chip'), 'find figure chip', 1);
  record('P1R-01', '节点详情人物入口：泸定桥关联王开湘/杨成武/廖大珠，chip 渲染',
    ['王开湘', '杨成武', '廖大珠'].every((n) => personNames.indexOf(n) >= 0) && !!chipEl,
    'persons=' + personNames.join(',') + ' chip=' + !!chipEl);

  // P1R-02 人物志详情 + 回跳节点
  try {
    const first = nd.node.persons[0];
    await cmd(() => nodePage.callMethod('goPerson', { currentTarget: { dataset: { id: first.id } } }), 'go person', 2);
    personPage = await waitPath('pages/person/person');
    const pd = await waitFor(async () => {
      const dd = await cmd(() => personPage.data(), 'person data');
      return dd && dd.loading === false && dd.person ? dd : null;
    }, 15000, 500, 'person ready');
    const eventNames = (pd.person.nodes || []).map((n) => n.name);
    const eventEl = await cmd(() => personPage.$('.person-event'), 'find event card', 1);
    const okDetail = pd.person.name === first.name && !!pd.person.brief
      && eventNames.indexOf('飞夺泸定桥') >= 0
      && pd.person.nodes.every((n) => !!n.historicalTime)
      && pd.initial === first.name.slice(0, 1) && !!eventEl;
    // 回跳节点详情（人物 → 节点）
    await cmd(() => personPage.callMethod('goNode', { currentTarget: { dataset: { id: 6 } } }), 'person go node', 2);
    await waitPath('pages/node-detail/node-detail');
    record('P1R-02', '人物志详情：' + first.name + '简介/事件卡（含历史时间）+ 回跳节点详情',
      okDetail, 'events=' + eventNames.join(',') + ' initial=' + pd.initial);
  } catch (e) { record('P1R-02', '人物志详情', false, e.message); }

  /* ===== 答题连胜（§15） ===== */
  // 确保今日未答题
  await api('/quiz/reset', token, 'POST');
  const daily = await api('/quiz/daily', token);
  const questions = (daily.body && daily.body.questions) || [];
  if (questions.length === 0) throw new Error('今日无题目');
  const rightMap = await probeAnswers(token, questions);
  const wrongLabel = (q) => {
    const opt = q.options.find((o) => o.label !== rightMap[q.id]);
    return opt.label;
  };

  await cmd(() => mini.reLaunch('/pages/quiz-answer/quiz-answer'), 'reLaunch quiz-answer', 2);
  let answerPage = await waitPath('pages/quiz-answer/quiz-answer');
  await waitFor(async () => {
    const dd = await cmd(() => answerPage.data(), 'answer data');
    return dd && dd.current ? dd : null;
  }, 15000, 500, 'quiz answer ready');

  // P1R-03 连胜反馈：第 1 题选对 → 🔥连续1题；第 2 题选错 → 清零
  try {
    const q1 = questions[0];
    await cmd(() => answerPage.callMethod('handleSelect', { currentTarget: { dataset: { label: rightMap[q1.id] } } }), 'select q1 right', 2);
    const d1 = await waitFor(async () => {
      const dd = await cmd(() => answerPage.data(), 'after q1');
      return dd && dd.lastCheck ? dd : null;
    }, 10000, 300, 'q1 checked');
    const badgeEl = await cmd(() => answerPage.$('.streak-badge'), 'find streak badge', 1);

    await cmd(() => answerPage.callMethod('handleNext'), 'next to q2', 2);
    await sleep(400);
    const q2 = questions[1];
    await cmd(() => answerPage.callMethod('handleSelect', { currentTarget: { dataset: { label: wrongLabel(q2) } } }), 'select q2 wrong', 2);
    const d2 = await waitFor(async () => {
      const dd = await cmd(() => answerPage.data(), 'after q2');
      return dd && dd.lastCheck ? dd : null;
    }, 10000, 300, 'q2 checked');

    record('P1R-03', '答题连胜：选对连续1题（徽章渲染），选错清零并提示重新开始',
      d1.lastCheck === 'correct' && d1.streak === 1 && !!badgeEl
      && d2.lastCheck === 'wrong' && d2.streak === 0,
      'q1=' + d1.lastCheck + '/streak=' + d1.streak + ' q2=' + d2.lastCheck + '/streak=' + d2.streak);
  } catch (e) { record('P1R-03', '答题连胜反馈', false, e.message); }

  // P1R-04 满分通关：重置后 5 题全对提交 → 结果页完美通关
  // 注意：reset 会清题目缓存并重抽，必须重新拉取今日题目并重新探测答案
  try {
    await api('/quiz/reset', token, 'POST');
    const daily2 = await api('/quiz/daily', token);
    const questions2 = (daily2.body && daily2.body.questions) || [];
    const rightMap2 = await probeAnswers(token, questions2);
    await cmd(() => mini.reLaunch('/pages/quiz-answer/quiz-answer'), 'reLaunch quiz-answer again', 2);
    answerPage = await waitPath('pages/quiz-answer/quiz-answer');
    await waitFor(async () => {
      const dd = await cmd(() => answerPage.data(), 'answer data 2');
      return dd && dd.current ? dd : null;
    }, 15000, 500, 'quiz answer ready 2');

    for (let i = 0; i < questions2.length; i++) {
      const q = questions2[i];
      await cmd(() => answerPage.callMethod('handleSelect', { currentTarget: { dataset: { label: rightMap2[q.id] } } }), 'select right q' + (i + 1), 2);
      await waitFor(async () => {
        const dd = await cmd(() => answerPage.data(), 'checked q' + (i + 1));
        return dd && dd.lastCheck === 'correct' ? dd : null;
      }, 10000, 300, 'q' + (i + 1) + ' correct');
      await cmd(() => answerPage.callMethod('handleNext'), 'next q' + (i + 1), 2);
      await sleep(500);
    }

    const resultPage = await waitPath('pages/quiz-result/quiz-result');
    const rd = await waitFor(async () => {
      const dd = await cmd(() => resultPage.data(), 'result data');
      return dd && dd.record ? dd : null;
    }, 15000, 500, 'quiz result ready');
    record('P1R-04', '满分通关：今日情报完美通关 5 / 5 · 100 分 + 彩带',
      rd.isPerfect === true && rd.perfectLine === '5 / 5 · 100 分'
      && (rd.confetti || []).length > 0 && rd.record.score === 100,
      'perfectLine=' + rd.perfectLine + ' confetti=' + (rd.confetti || []).length);
  } catch (e) { record('P1R-04', '满分通关效果', false, e.message); }

  /* ===== 截图（断言全部落盘后；截图会使自动化桥退化，每个状态以主动导航起手） ===== */
  // 30 人物详情
  try {
    await cmd(() => mini.reLaunch('/pages/person/person?id=10'), 'reLaunch person shot', 1);
    const pp = await waitPath('pages/person/person');
    await waitFor(async () => {
      const dd = await cmd(() => pp.data(), 'person shot data', 1);
      return dd && dd.loading === false && dd.person ? dd : null;
    }, 15000, 500, 'person shot ready');
    await sleep(600);
    await withTimeout(mini.screenshot({ path: SHOT_PERSON }), 25000, 'screenshot person');
    console.log('SHOT 30-person-detail.png');
  } catch (e) { console.log('人物截图失败（不影响断言）: ' + e.message); }

  // 32 满分通关（P1R-04 已留 100 分记录）
  try {
    await cmd(() => mini.reLaunch('/pages/quiz-result/quiz-result'), 'reLaunch result shot', 1);
    const rp = await waitPath('pages/quiz-result/quiz-result');
    await waitFor(async () => {
      const dd = await cmd(() => rp.data(), 'result shot data', 1);
      return dd && dd.record ? dd : null;
    }, 15000, 500, 'result shot ready');
    await sleep(1200);
    await withTimeout(mini.screenshot({ path: SHOT_PERFECT }), 25000, 'screenshot perfect');
    console.log('SHOT 32-quiz-perfect.png');
  } catch (e) { console.log('满分截图失败（不影响断言）: ' + e.message); }

  // 31 连胜状态（重置后重答第 1 题选对；reset 会重抽题目，需重新探测答案）
  try {
    await api('/quiz/reset', token, 'POST');
    const daily3 = await api('/quiz/daily', token);
    const questions3 = (daily3.body && daily3.body.questions) || [];
    const rightMap3 = await probeAnswers(token, questions3);
    const q1 = questions3[0];
    await cmd(() => mini.reLaunch('/pages/quiz-answer/quiz-answer'), 'reLaunch streak shot', 1);
    const ap = await waitPath('pages/quiz-answer/quiz-answer');
    await waitFor(async () => {
      const dd = await cmd(() => ap.data(), 'streak shot data', 1);
      return dd && dd.current ? dd : null;
    }, 15000, 500, 'streak shot ready');
    await cmd(() => ap.callMethod('handleSelect', { currentTarget: { dataset: { label: rightMap3[q1.id] } } }), 'streak shot select', 1);
    await waitFor(async () => {
      const dd = await cmd(() => ap.data(), 'streak shot checked', 1);
      return dd && dd.streak === 1 ? dd : null;
    }, 10000, 300, 'streak=1');
    await sleep(400);
    await withTimeout(mini.screenshot({ path: SHOT_STREAK }), 25000, 'screenshot streak');
    console.log('SHOT 31-quiz-streak.png');
  } catch (e) { console.log('连胜截图失败（不影响断言）: ' + e.message); }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log('\n== 共 ' + results.length + ' 用例，失败 ' + failed.length + ' ==');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log('FATAL: ' + (e && e.message));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  process.exit(2);
});
