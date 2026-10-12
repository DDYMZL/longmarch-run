/**
 * V1.2 我的页隐藏「账号与绑定」+ 答题提交后统一反馈（小程序侧）验收（断言先行，截图放末尾）
 *
 *   M01 我的页无「账号与绑定」入口，其余入口完整、无空白行
 *   A01 答题页 5 题，题目对象不含 answer / analysis
 *   A02 选择答案仅中性 selected 高亮，无对错样式 / 连胜徽章 / 判题提示，data 无判题字段
 *   A03 同题改选覆盖原选择
 *   A04 未选择不可进入下一题
 *   A05 「上一题」回看并回显已选答案
 *   A06 存在未作答题目时提交被拦截并定位到未答题，后端未生成记录
 *   A07 提交后结果页展示逐题详情（我的答案/正确答案/对错/每题得分）与 60 分统计
 * 截图：40-v12-mine.png / 41-v12-quiz-answering.png / 42-v12-quiz-result.png
 *
 *   node v12-mine-quiz.cjs
 *
 * 前置：后端 8010 运行；开发者工具自动化端口 9420；
 *       ../v12-fixture.json（userId/token/answers，由后端脚本生成，已被 .gitignore 忽略）。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'v12-fixture.json'), 'utf8'));
const RESULTS_FILE = path.join(__dirname, 'results-v12.json');
const IMAGES = path.join(__dirname, '..', 'images');
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

function api(path_, method, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const req = http.request({
      host: '127.0.0.1', port: 8010, path: '/api' + path_, method: method || 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + FIXTURE.token },
        body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {})
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

/** 注入测试用户 Token，经启动页 /auth/me 校验后进入首页 */
async function loginWithToken() {
  await cmd(() => mini.evaluate((token) => {
    const app = getApp();
    app.globalData.user = null;
    app.globalData.loggedIn = false;
    wx.clearStorageSync();
    wx.setStorageSync('lm_auth_token', token);
    return true;
  }, FIXTURE.token), 'inject token', 2);
  await cmd(() => mini.reLaunch('/pages/launch/launch'), 'reLaunch launch', 2);
  await waitPath('pages/home/home', 30000);
  await sleep(1000);
}

function rightLabel(q) { return FIXTURE.answers[q.id][0]; }
function wrongLabel(q) { return q.options.find((o) => o.label !== rightLabel(q)).label; }

async function optionEls(page) { return cmd(() => page.$$('.option'), 'options'); }

async function tapLabel(page, label) {
  const els = await optionEls(page);
  for (const el of els) {
    if ((await el.attribute('data-label')) === label) {
      await cmd(() => el.tap(), 'tap ' + label, 1);
      return;
    }
  }
  throw new Error('未找到选项 ' + label);
}

async function optionClasses(page) {
  const els = await optionEls(page);
  const out = [];
  for (const el of els) out.push(await el.attribute('class'));
  return out;
}

async function openAnswerPage() {
  await cmd(() => mini.navigateTo('/pages/quiz-answer/quiz-answer'), 'open quiz-answer', 2);
  const page = await waitPath('pages/quiz-answer/quiz-answer');
  await waitFor(async () => ((await page.data()).total === 5 ? true : null), 15000, 'quiz loaded');
  return page;
}

async function run() {
  mini = await connectMini();
  await loginWithToken();
  const reset = await api('/quiz/reset', 'POST');
  if (reset.status !== 200) throw new Error('重置今日答题失败 ' + reset.status);

  // M01
  await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine', 2);
  const mine = await waitPath('pages/mine/mine');
  await sleep(1200);
  const items = await cmd(() => mine.$$('.menu-item'), 'menu items');
  const texts = [];
  for (const el of items) texts.push((await el.text()).replace(/\s+/g, ''));
  record('M01', '我的页无「账号与绑定」入口', texts.length > 0 && !texts.some((t) => t.indexOf('账号与绑定') >= 0)
    && texts.every((t) => t.length > 0), 'menus=' + texts.join(','));

  // A01
  let page = await openAnswerPage();
  let d = await page.data();
  const daily = await api('/quiz/daily');
  const qs = daily.body.questions;
  const leaked = qs.filter((q) => 'answer' in q || 'analysis' in q).length
    + (('answer' in d.current) || ('analysis' in d.current) ? 1 : 0);
  record('A01', '答题页 5 题且题目不含答案/解析', d.total === 5 && d.current.id === qs[0].id && leaked === 0,
    'total=' + d.total + ' leaked=' + leaked);

  // A02
  const q0 = qs[0];
  await tapLabel(page, wrongLabel(q0));
  await sleep(500);
  d = await page.data();
  const cls = await optionClasses(page);
  const feedbackEls = (await page.$$('.streak-badge')).length + (await page.$$('.check-tip')).length
    + (await page.$$('.opt-correct')).length + (await page.$$('.opt-wrong')).length;
  const judgeKeys = ['streak', 'lastCheck', 'checkedLabel', 'correct'].filter((k) => k in d);
  record('A02', '选择后仅中性高亮、无对错/连胜反馈',
    d.selected === wrongLabel(q0) && cls.filter((c) => /\bselected\b/.test(c)).length === 1
    && feedbackEls === 0 && judgeKeys.length === 0, 'classes=' + cls.join('|') + ' judgeKeys=' + judgeKeys);

  // A03 改选为正确答案
  await tapLabel(page, rightLabel(q0));
  await sleep(400);
  d = await page.data();
  record('A03', '同题改选覆盖原选择', d.selected === rightLabel(q0), 'selected=' + d.selected);

  // A04 / A05
  await cmd(() => page.callMethod('handleNext'), 'next q1', 1);
  await sleep(600);
  d = await page.data();
  const movedTo1 = d.currentIndex === 1 && d.selected === '';
  await cmd(() => page.callMethod('handleNext'), 'next without select', 1);
  await sleep(600);
  d = await page.data();
  record('A04', '未选择不可进入下一题', movedTo1 && d.currentIndex === 1, 'index=' + d.currentIndex);

  const prevBtn = await page.$('.prev-btn');
  if (prevBtn) await cmd(() => prevBtn.tap(), 'tap prev', 1);
  await sleep(600);
  d = await page.data();
  record('A05', '「上一题」回看并回显已选答案', !!prevBtn && d.currentIndex === 0 && d.selected === rightLabel(q0),
    'prevBtn=' + !!prevBtn + ' index=' + d.currentIndex + ' selected=' + d.selected);

  // A06 只答第 1 题直接提交
  await cmd(() => page.callMethod('handleSubmit'), 'submit incomplete', 1);
  await sleep(800);
  d = await page.data();
  const still = await api('/quiz/daily');
  record('A06', '有未答题时提交被拦截并定位', d.currentIndex === 1 && still.body.completed === false
    && (await mini.currentPage()).path.indexOf('pages/quiz-answer') === 0, 'index=' + d.currentIndex + ' completed=' + still.body.completed);

  // A07 第 1-3 题答对、4-5 题答错后提交
  for (let i = 1; i < 5; i++) {
    page = await waitPath('pages/quiz-answer/quiz-answer');
    d = await page.data();
    if (d.currentIndex !== i) throw new Error('题序异常 ' + d.currentIndex + ' != ' + i);
    await tapLabel(page, i < 3 ? rightLabel(qs[i]) : wrongLabel(qs[i]));
    await sleep(400);
    await cmd(() => page.callMethod('handleNext'), 'next ' + i, 1);
    await sleep(700);
  }
  const result = await waitPath('pages/quiz-result/quiz-result', 20000);
  const rd = await waitFor(async () => {
    const x = await result.data();
    return x.record && x.details.length ? x : null;
  }, 15000, 'result loaded');
  const detailEls = await result.$$('.detail-item');
  const verdicts = [];
  for (const el of await result.$$('.detail-verdict')) verdicts.push((await el.text()).replace(/\s+/g, ''));
  const detailOk = rd.details.length === 5
    && rd.details.map((x) => x.correct).join() === 'true,true,true,false,false'
    && rd.details.map((x) => x.score).join() === '20,20,20,0,0'
    && rd.details.every((x, i) => x.correctAnswerText.indexOf(rightLabel(qs[i]) + '.') === 0)
    && rd.details[3].userAnswerText.indexOf(wrongLabel(qs[3]) + '.') === 0;
  record('A07', '结果页逐题详情与 60 分统计', rd.record.score === 60 && rd.record.correctCount === 3 && rd.wrongCount === 2
    && detailOk && detailEls.length === 5 && verdicts.length === 5 && verdicts[3].indexOf('错误') >= 0
    && verdicts[0].indexOf('正确') >= 0, 'score=' + rd.record.score + ' verdicts=' + verdicts.join('|'));

  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ results }, null, 2));

  // 截图（断言已落盘；每张以主动导航开头）
  await api('/quiz/reset', 'POST');
  page = await openAnswerPage();
  const sq = (await api('/quiz/daily')).body.questions;
  await tapLabel(page, rightLabel(sq[0]));
  await cmd(() => page.callMethod('handleNext'), 'shot next', 1);
  await sleep(600);
  await tapLabel(page, wrongLabel(sq[1]));
  await sleep(800);
  await cmd(() => mini.screenshot({ path: path.join(IMAGES, '41-v12-quiz-answering.png') }), 'shot answering', 1).catch((e) => console.log('截图失败 ' + e.message));

  await api('/quiz/submit', 'POST', { answers: sq.map((q, i) => ({ questionId: q.id, answer: [i < 3 ? rightLabel(q) : wrongLabel(q)] })) });
  await cmd(() => mini.reLaunch('/pages/quiz-result/quiz-result'), 'reLaunch result', 2);
  await waitPath('pages/quiz-result/quiz-result');
  await sleep(2500);
  await cmd(() => mini.screenshot({ path: path.join(IMAGES, '42-v12-quiz-result.png') }), 'shot result', 1).catch((e) => console.log('截图失败 ' + e.message));

  await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine shot', 2);
  await waitPath('pages/mine/mine');
  await sleep(1500);
  await cmd(() => mini.pageScrollTo(600), 'scroll mine', 1).catch(() => {});
  await sleep(800);
  await cmd(() => mini.screenshot({ path: path.join(IMAGES, '40-v12-mine.png') }), 'shot mine', 1).catch((e) => console.log('截图失败 ' + e.message));
}

run()
  .catch((e) => {
    console.log('ERROR ' + (e && e.stack ? e.stack : e));
    record('RUN', '脚本执行', false, e && e.message);
  })
  .finally(() => {
    fs.writeFileSync(RESULTS_FILE, JSON.stringify({ results }, null, 2));
    const passed = results.filter((r) => r.pass).length;
    console.log('\n== V1.2 我的页 + 答题反馈: ' + passed + '/' + results.length + ' 通过 ==');
    try { mini && mini.disconnect(); } catch (e) { /* ignore */ }
    process.exit(passed === results.length ? 0 : 1);
  });
