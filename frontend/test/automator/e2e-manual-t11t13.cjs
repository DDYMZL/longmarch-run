/**
 * 临时补验脚本：ui-test.cjs 阶段 4 的 T11-T13（运动记录/答题记录/勋章墙）
 * 原因：mine 页菜单在 P1 迭代新增「我的档案」「组织选择」两项后索引前移，
 *       ui-test.cjs phase4 仍按旧索引 menuItems[1..3] 取菜单，T11 起导航错页。
 *       本脚本不改动 ui-test.cjs，按当前页面实际菜单顺序（3/4/5）补验。
 * 运行：node e2e-manual-t11t13.cjs（cwd=frontend/test/automator，IDE 已开 9420）
 */
const fs = require('fs');
const path = require('path');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => console.log('未处理 rejection（忽略）: ' + (e && e.message)));

const CMD_TIMEOUT = 20000;
let cmdChain = Promise.resolve();
let mini = null;
const results = [];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function withTimeout(p, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('命令超时: ' + label)), ms); if (timer.unref) timer.unref(); });
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
}
function cmd(fn, desc, retries = 2) {
  const run = async () => {
    for (let n = 0; ; n++) {
      try { const r = await withTimeout(fn(), CMD_TIMEOUT, desc); await sleep(40); return r; }
      catch (e) {
        const retriable = /timeout|超时|ETIMEDOUT|socket|ECONN|disconnect/i.test(e && e.message || String(e));
        if (!retriable || n >= retries) throw e;
        console.log('retry[' + (n + 1) + '] ' + desc + ': ' + e.message);
        await sleep(1500);
      }
    }
  };
  const p = cmdChain.then(run, run);
  cmdChain = p.then(() => undefined, () => undefined);
  return p;
}
async function waitPage(pathPrefix, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    let p = null;
    try { p = await withTimeout(mini.currentPage(), 8000, 'currentPage@' + pathPrefix); } catch (e) { p = null; }
    if (p && p.path && p.path.indexOf(pathPrefix) === 0) return p;
    if (Date.now() - start > timeout) throw new Error('等待页面超时: ' + pathPrefix + ' 当前: ' + (p && p.path));
    await sleep(300);
  }
}
async function waitFor(fn, timeout = 12000, interval = 400, desc = 'condition') {
  const start = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { /* retry */ }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('等待超时: ' + desc);
    await sleep(interval);
  }
}
function record(id, name, pass, detail) {
  results.push({ id, name, pass: !!pass, detail: String(detail == null ? '' : detail).slice(0, 500) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + (detail ? ' | ' + detail : ''));
}

async function tapMenu(page, idx, expectPath, desc) {
  const items = await cmd(() => page.$$('.menu-item'), '$$ .menu-item');
  const el = items[idx];
  if (!el) throw new Error('menu-item[' + idx + '] 不存在');
  await cmd(() => el.tap(), 'tap ' + desc, 1);
  const ok = await (async () => {
    const start = Date.now();
    for (;;) {
      const p = await cmd(() => mini.currentPage(), 'currentPage after ' + desc).catch(() => null);
      if (p && p.path && p.path.indexOf(expectPath) === 0) return true;
      if (Date.now() - start > 3000) return false;
      await sleep(300);
    }
  })();
  return ok;
}

async function main() {
  mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  await cmd(() => mini.switchTab('/pages/mine/mine'), 'switchTab mine');
  let minePage = await waitPage('pages/mine/mine');

  // T11 运动记录（实际索引 3）
  let ok = await tapMenu(minePage, 3, 'pages/sport-records/sport-records', 'menu 运动记录');
  if (ok) {
    const sportPage = await waitPage('pages/sport-records/sport-records');
    const sTotal = await (async () => {
      const start = Date.now();
      for (;;) {
        const d = await cmd(() => sportPage.data('totalSteps'), 'sport totalSteps').catch(() => null);
        if (d) return d;
        if (Date.now() - start > 10000) return null;
        await sleep(400);
      }
    })();
    record('T11', '运动记录页（索引 3）', sTotal !== null, 'totalSteps=' + sTotal);
    await cmd(() => mini.navigateBack(), 'back to mine');
    minePage = await waitPage('pages/mine/mine');
  } else {
    record('T11', '运动记录页（索引 3）', false, 'tap 后未进入 sport-records');
  }

  // T12 答题记录（实际索引 4）
  ok = await tapMenu(minePage, 4, 'pages/quiz-records/quiz-records', 'menu 答题记录');
  if (ok) {
    const qrecPage = await waitPage('pages/quiz-records/quiz-records');
    const qrecs = await waitFor(async () => {
      const r = await cmd(() => qrecPage.data('records'), 'quiz records').catch(() => null);
      return Array.isArray(r) ? r : null;
    }, 10000, 400, 'quiz records');
    record('T12', '答题记录页（索引 4）', qrecs.length >= 1, 'records=' + qrecs.map((r) => (r.date || '?') + ':' + r.score + '分').join(', '));
    await cmd(() => mini.navigateBack(), 'back to mine 2');
    minePage = await waitPage('pages/mine/mine');
  } else {
    record('T12', '答题记录页（索引 4）', false, 'tap 后未进入 quiz-records');
  }

  // T13 我的勋章（实际索引 5；页面 data 结构为 groups[]，P2 分组化后 ui-test.cjs 的 medals[] 断言已过期）
  ok = await tapMenu(minePage, 5, 'pages/medals/medals', 'menu 我的勋章');
  if (ok) {
    const medalPage = await waitPage('pages/medals/medals');
    const mdAll = await waitFor(async () => {
      const d = await cmd(() => medalPage.data(), 'medals data').catch(() => null);
      return d && Array.isArray(d.groups) ? d : null;
    }, 10000, 400, 'medals groups');
    const flat = (mdAll.groups || []).flatMap((g) => g.medals || []);
    const ownedIds = flat.filter((m) => m.owned).map((m) => m.id);
    record('T13', '勋章墙（索引 5，groups 分组）', flat.length >= 6 && mdAll.ownedCount >= 1 && ownedIds.indexOf('first-step') >= 0,
      'owned=' + mdAll.ownedCount + '/' + mdAll.totalCount + ' flat=' + flat.length + ' [' + ownedIds.join(',') + ']');
  } else {
    record('T13', '勋章墙（索引 5）', false, 'tap 后未进入 medals');
  }

  const out = { suite: 'e2e-manual-t11t13', results };
  fs.writeFileSync(path.join(__dirname, 'results-manual-t11t13.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('结果已落盘 results-manual-t11t13.json: ' + results.filter((r) => r.pass).length + '/' + results.length + ' 通过');
  mini.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.log('脚本异常: ' + (e && e.message));
  try { fs.writeFileSync(path.join(__dirname, 'results-manual-t11t13.json'), JSON.stringify({ suite: 'e2e-manual-t11t13', error: String(e && e.message), results }, null, 2), 'utf8'); } catch (e2) {}
  try { if (mini) mini.disconnect(); } catch (e3) {}
  process.exit(1);
});
