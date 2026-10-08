/**
 * 临时诊断脚本：深链 quiz-result 后 60 秒内观察跳转耗时（区分"不跳"与"跳得慢"）
 */
const fs = require('fs');
const path = require('path');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => console.log('未处理 rejection（忽略）: ' + (e && e.message)));

const CMD_TIMEOUT = 20000;
let cmdChain = Promise.resolve();
let mini = null;

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

async function main() {
  mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  const logs = [];
  mini.on('console', (msg) => { logs.push({ ts: Date.now(), text: (msg && msg.args && msg.args.join(' ')) || '' }); });

  // 确保未登录
  await cmd(() => mini.callWxMethod('removeStorageSync', 'lm_auth_token'), 'remove token');
  await cmd(() => mini.callWxMethod('removeStorageSync', 'lm_login_user'), 'remove user');
  console.log('token 已清除');

  const t0 = Date.now();
  console.log('t=0s reLaunch → quiz-result');
  await cmd(() => mini.evaluate(() => wx.reLaunch({ url: '/pages/quiz-result/quiz-result' })), 'reLaunch quiz-result', 2);

  const seen = [];
  let finalPath = '';
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const p = await cmd(() => mini.currentPage(), 'currentPage').catch(() => null);
    const pathNow = p && p.path;
    finalPath = pathNow;
    if (pathNow && seen[seen.length - 1] !== pathNow) {
      seen.push({ t: i + 1, path: pathNow });
      console.log('  t=' + (i + 1) + 's page=' + pathNow);
      if (pathNow === 'pages/login/login') break;
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('总耗时: ' + elapsed + 's, 最终页: ' + finalPath);
  console.log('--- console（异常）---');
  logs.filter((l) => /TypeError|Cannot read|Error/i.test(l.text)).slice(0, 6).forEach((l) => console.log('  ERR: ' + String(l.text).slice(0, 250)));

  const out = { seq: seen, elapsedSec: elapsed, finalPath, errLogs: logs.filter((l) => /TypeError|Cannot read/.test(l.text)).slice(0, 10) };
  fs.writeFileSync(path.join(__dirname, 'results-repro-t16a-timing.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('已落盘 results-repro-t16a-timing.json');
  mini.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.log('脚本异常: ' + (e && e.message));
  try { if (mini) mini.disconnect(); } catch (e2) {}
  process.exit(1);
});
