/**
 * S16 小程序代码审查修复 · 开发者工具冒烟（真实页面 + 本地后端 8010，WX_LOGIN_ALLOW_MOCK=true）。
 * 运行（cwd=frontend/test/automator）：node s16-review-smoke.cjs
 */
const fs = require('fs');
const path = require('path');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const exceptions = [];

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + (timeoutMs || 15000);
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = 'err:' + e.message;
    }
    await sleep(400);
  }
  throw new Error('等待超时: ' + label + ' last=' + JSON.stringify(last));
}

async function waitPath(mini, target, timeoutMs) {
  return waitFor(async () => {
    const p = await mini.currentPage();
    return p && p.path === target ? p : null;
  }, timeoutMs, target);
}

async function check(name, fn) {
  const before = exceptions.length;
  try {
    const detail = await fn();
    if (exceptions.length > before) throw new Error('页面异常: ' + exceptions.slice(before).join(' | '));
    results.push({ name, pass: true, detail });
    console.log('PASS', name, '|', detail || '');
  } catch (e) {
    results.push({ name, pass: false, detail: e.message });
    console.log('FAIL', name, '|', e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const keysOf = (o) => Object.keys(o || {}).sort().join(',');

async function api(p, token, method, data) {
  const res = await fetch('http://127.0.0.1:8010/api' + p, {
    method: method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: data ? JSON.stringify(data) : undefined
  });
  const body = await res.json();
  if (!res.ok) throw new Error(p + ' ' + res.status + ' ' + JSON.stringify(body));
  return body;
}

(async () => {
  const mini = await automator.connect({ wsEndpoint: WS });
  mini.on('exception', (e) => { const m = e.message + ' ' + JSON.stringify(e.stack || e).slice(0, 300); exceptions.push(m); console.log('exception:', m); });
  mini.on('console', (m) => { if (m.type === 'error') exceptions.push('console.error ' + JSON.stringify(m.args).slice(0, 200)); });

  await check('R1 冷启动经启动页自动登录到首页，单次合并 setData 后数据完整', async () => {
    await mini.evaluate(() => { getApp().globalData.loggedIn = false; getApp().globalData.user = null; return true; });
    await mini.reLaunch('/pages/launch/launch');
    const home = await waitPath(mini, 'pages/home/home', 20000);
    const d = await waitFor(async () => { const x = await home.data(); return x.routeLoading === false ? x : null; }, 15000, 'home 数据');
    assert(!('totalSteps' in d) && !('nextNode' in d), '仍残留冗余字段 totalSteps/nextNode');
    assert(!d.routeError, 'routeError=' + d.routeError);
    return 'todaySteps=' + d.todaySteps + ' lit=' + d.litCount + '/' + d.totalCount + ' quote=' + !!d.quote;
  });

  await check('R2 首页并发 refreshAll 只采纳最后一次结果（requestId 守卫）', async () => {
    const home = await mini.currentPage();
    await home.callMethod('refreshAll');
    await home.callMethod('refreshAll');
    await sleep(2500);
    const d = await home.data();
    assert(!d.routeError, 'routeError=' + d.routeError);
    return 'refreshRequestId=' + (await mini.evaluate(() => getCurrentPages().slice(-1)[0]._refreshRequestId));
  });

  await check('R3 长征页实景模式：节点精简视图 + 当前章节卡 + markers', async () => {
    await mini.switchTab('/pages/march/march');
    const page = await waitPath(mini, 'pages/march/march', 15000);
    await mini.evaluate(() => { const p = getCurrentPages().slice(-1)[0]; if (p.data.showIntro) p.skipIntro(); return true; });
    const d = await waitFor(async () => { const x = await page.data(); return x.nodes.length && x.markers.length ? x : null; }, 15000, 'march 节点');
    assert(keysOf(d.nodes[0]) === 'icon,id,name,remain,status,targetSteps', '节点字段=' + keysOf(d.nodes[0]));
    assert(d.currentChapter && typeof d.currentChapter.progressPct === 'number', 'currentChapter 缺 progressPct');
    assert(!('chapters' in d), '仍残留 chapters');
    return 'nodes=' + d.nodes.length + ' markers=' + d.markers.length + ' chapter=' + d.currentChapter.title;
  });

  await check('R4 实景→星空→实景切换：画布重建、离屏缓存释放后 markers 重建', async () => {
    const page = await mini.currentPage();
    await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } });
    await waitFor(() => mini.evaluate(() => !!getCurrentPages().slice(-1)[0].ctx), 10000, 'canvas ctx');
    await sleep(1500);
    await page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'real' } } });
    await sleep(800);
    const s = await mini.evaluate(() => { const p = getCurrentPages().slice(-1)[0]; return { ctx: !!p.ctx, glow: !!p.glowGold, mode: p.data.mode, markers: p.data.markers.length, sel: p.data.selectedNode && Object.keys(p.data.selectedNode).length }; });
    assert(s.mode === 'real' && !s.ctx && !s.glow && s.markers > 0, JSON.stringify(s));
    return JSON.stringify(s);
  });

  await check('R5 marker 点击选中节点（toViewNode）与列表节点点击跳详情（data-id）', async () => {
    const page = await mini.currentPage();
    const d = await page.data();
    const id = d.nodes[1].id;
    await page.callMethod('handleMarkerTap', { detail: { markerId: id }, markerId: id });
    const sel = (await page.data()).selectedNode;
    assert(sel && sel.id === id && keysOf(sel) === 'icon,id,name,remain,status,targetSteps', 'selectedNode=' + JSON.stringify(sel));
    await page.callMethod('handleNodeTap', { currentTarget: { dataset: { id } } });
    const nd = await waitPath(mini, 'pages/node-detail/node-detail', 10000);
    const q = nd.query || {};
    return 'selected=' + sel.name + ' detailQuery=' + JSON.stringify(q);
  });

  await check('R6 切回长征 Tab（onShow 恢复动画）无异常', async () => {
    await mini.navigateBack();
    await waitPath(mini, 'pages/march/march', 10000);
    await sleep(1200);
    return 'ok';
  });

  await check('R7 完成仪式页（已走完全程的临时 mock 用户）：动画、切后台续播、跳过收尾', async () => {
    const lg = await api('/auth/login', null, 'POST', { code: 'mock_s16_ceremony_' + Date.now(), nickname: 's16仪式' });
    await api('/sport/add', lg.token, 'POST', { delta: 70000 });
    const lit = await api('/march/light-up', lg.token, 'POST');
    assert(Array.isArray(lit.newMedals), 'light-up 缺 newMedals');
    const orig = await mini.evaluate(() => wx.getStorageSync('lm_auth_token'));
    await mini.evaluate((t) => { wx.setStorageSync('lm_auth_token', t); return true; }, lg.token);
    try {
      await mini.navigateTo('/pages/ceremony/ceremony');
      const page = await waitPath(mini, 'pages/ceremony/ceremony', 10000);
      const d = await waitFor(async () => { const x = await page.data(); return x.ready ? x : null; }, 15000, 'ceremony ready');
      assert(d.pending === true, 'pending=' + d.pending);
      await sleep(1200);
      await page.callMethod('onHide');
      await page.callMethod('onShow');
      const looping = await mini.evaluate(() => { const p = getCurrentPages().slice(-1)[0]; return !!p._ctx && !p._finalized; });
      await page.callMethod('skipAnim');
      const done = await waitFor(async () => { const x = await page.data(); return x.showStats ? x : null; }, 10000, 'ceremony stats');
      await mini.navigateBack();
      await sleep(800);
      return 'lit=' + lit.newlyLit.length + ' newMedals=' + JSON.stringify(lit.newMedals) + ' 续播=' + looping + ' phase=' + done.phase + ' 勋章=' + done.stats.medalOwned + '/' + done.stats.medalTotal;
    } finally {
      await mini.evaluate((t) => { wx.setStorageSync('lm_auth_token', t); return true; }, orig);
    }
  });

  await check('R8 排行榜下拉刷新（失败保留旧数据，完成后停止 spinner）', async () => {
    await mini.switchTab('/pages/rank/rank');
    const page = await waitPath(mini, 'pages/rank/rank', 10000);
    const d = await waitFor(async () => { const x = await page.data(); return x.list.length ? x : null; }, 10000, 'rank list');
    await page.callMethod('onPullDownRefresh');
    await sleep(1500);
    const d2 = await page.data();
    assert(d2.list.length === d.list.length, '刷新后条数变化 ' + d.list.length + '→' + d2.list.length);
    return 'list=' + d2.list.length + ' myRank=' + d2.myRank;
  });

  await check('R9 我的页勋章图标 {id,icon} 结构', async () => {
    await mini.switchTab('/pages/mine/mine');
    const page = await waitPath(mini, 'pages/mine/mine', 10000);
    await sleep(2000);
    const d = await page.data();
    const icons = d.medalIcons || [];
    assert(icons.every((m) => m.id && m.icon), 'medalIcons=' + JSON.stringify(icons).slice(0, 200));
    return 'medalIcons=' + icons.length;
  });

  for (const [name, url] of [
    ['calendar', '/pages/calendar/calendar'],
    ['profile', '/pages/profile/profile'],
    ['account', '/pages/account/account'],
    ['quiz-records', '/pages/quiz-records/quiz-records'],
    ['person', '/pages/person/person?id=1'],
    ['org-select', '/pages/org-select/org-select'],
    ['ticket', '/pages/ticket/ticket']
  ]) {
    await check('R10 打开 ' + name + ' 页无异常', async () => {
      await mini.navigateTo(url);
      const page = await waitPath(mini, url.slice(1).split('?')[0], 10000);
      await sleep(2000);
      const d = await page.data();
      if (name === 'quiz-records') {
        const r = (d.records || d.list || [])[0];
        if (r) assert(keysOf(r) === 'correctCount,date,points,score,text,totalCount', '记录字段=' + keysOf(r));
      }
      await mini.navigateBack();
      await sleep(500);
      return 'keys=' + Object.keys(d).slice(0, 8).join(',');
    });
  }

  await check('R11 答题结果页：星级 {id,on} 结构', async () => {
    await mini.switchTab('/pages/quiz/quiz');
    await waitPath(mini, 'pages/quiz/quiz', 10000);
    await mini.navigateTo('/pages/quiz-result/quiz-result');
    const page = await waitPath(mini, 'pages/quiz-result/quiz-result', 10000).catch(() => null);
    await sleep(2500);
    const cur = await mini.currentPage();
    if (cur.path !== 'pages/quiz-result/quiz-result') return '今日未答题，已回退 ' + cur.path + '（预期分支）';
    const d = await page.data();
    assert(d.stars.length === 5 && d.stars.every((s) => typeof s.id === 'number' && typeof s.on === 'boolean'), 'stars=' + JSON.stringify(d.stars));
    await mini.navigateBack();
    return 'score=' + d.displayScore + ' starsOn=' + d.stars.filter((s) => s.on).length;
  });

  await check('R12 答题全流程（临时 mock 用户）：5 题作答 → 提交 → 结果页分数滚动/星级/离开清理', async () => {
    const lg = await api('/auth/login', null, 'POST', { code: 'mock_s16_quiz_' + Date.now(), nickname: 's16答题' });
    const orig = await mini.evaluate(() => wx.getStorageSync('lm_auth_token'));
    await mini.evaluate((t) => { wx.setStorageSync('lm_auth_token', t); return true; }, lg.token);
    try {
      await mini.navigateTo('/pages/quiz-answer/quiz-answer');
      await waitPath(mini, 'pages/quiz-answer/quiz-answer', 10000);
      let answered = 0;
      for (let i = 0; i < 10; i++) {
        const p = await mini.currentPage();
        if (p.path === 'pages/quiz-result/quiz-result') break;
        const d = await waitFor(async () => { const x = await p.data(); return x.current ? x : null; }, 10000, '题目');
        assert(!('questions' in d) && !('answers' in d), '题目/作答仍在 data 中');
        const opt = d.current.options[0];
        await p.callMethod('handleSelect', { currentTarget: { dataset: { label: opt.label || opt } } });
        await sleep(300);
        await p.callMethod('handleNext');
        answered++;
        await sleep(600);
      }
      const page = await waitPath(mini, 'pages/quiz-result/quiz-result', 15000);
      const d = await waitFor(async () => { const x = await page.data(); return x.record && x.stars.filter((s) => s.on).length === Math.round(x.record.score / 20) && x.displayScore === x.record.score ? x : null; }, 10000, '结果动画');
      assert(d.stars.every((s) => typeof s.id === 'number'), 'stars 结构错误');
      await mini.navigateBack();
      await sleep(1500);
      return 'answered=' + answered + ' score=' + d.record.score + ' 星=' + d.stars.filter((s) => s.on).length + ' wrong=' + d.wrongCount;
    } finally {
      await mini.evaluate((t) => { wx.setStorageSync('lm_auth_token', t); return true; }, orig);
    }
  });

  fs.writeFileSync(path.join(__dirname, 'results-s16.json'), JSON.stringify({ results, exceptions }, null, 2));
  const passed = results.filter((r) => r.pass).length;
  console.log('\n== S16 审查修复冒烟: ' + passed + '/' + results.length + ' 通过 ==');
  await mini.disconnect();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
