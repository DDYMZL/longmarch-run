/**
 * 临时诊断脚本：包装 wx.request 记录请求/响应，深链 quiz-result 观察 401→reLaunch 链路
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

  await cmd(() => mini.callWxMethod('removeStorageSync', 'lm_auth_token'), 'remove token');
  await cmd(() => mini.callWxMethod('removeStorageSync', 'lm_login_user'), 'remove user');

  // 包装 wx.request（在 appservice 全局生效）
  await cmd(() => mini.evaluate(() => {
    if (!wx.__wrapped) {
      const orig = wx.request;
      wx.request = function (opts) {
        console.log('[REQ] ' + (opts.method || 'GET') + ' ' + (opts.url || ''));
        const os = opts.success, of = opts.fail;
        opts.success = function (res) {
          console.log('[RES] ' + (opts.url || '') + ' -> ' + res.statusCode);
          if (os) os(res);
        };
        opts.fail = function (err) {
          console.log('[FAIL] ' + (opts.url || '') + ' ' + JSON.stringify(err));
          if (of) of(err);
        };
        return orig.call(this, opts);
      };
      wx.__wrapped = true;
      const origRel = wx.reLaunch;
      wx.reLaunch = function (opts) {
        console.log('[RELAUNCH] ' + (opts && opts.url));
        return origRel.call(this, opts);
      };
    }
  }), 'wrap wx.request/reLaunch');

  console.log('reLaunch → quiz-result');
  await cmd(() => mini.evaluate(() => wx.reLaunch({ url: '/pages/quiz-result/quiz-result' })), 'reLaunch quiz-result', 2);

  // 观察 30 秒
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const p = await cmd(() => mini.currentPage(), 'currentPage').catch(() => null);
    if (i % 5 === 4 || (p && p.path === 'pages/login/login')) console.log('  t=' + (i + 1) + 's page=' + (p && p.path));
    if (p && p.path === 'pages/login/login') break;
  }

  console.log('--- console 监控 ---');
  logs.filter((l) => /\[REQ\]|\[RES\]|\[FAIL\]|\[RELAUNCH\]|TypeError/.test(l.text)).forEach((l) => console.log('  ' + l.text.slice(0, 220)));

  const out = { logs: logs.map((l) => l.text).slice(0, 40) };
  fs.writeFileSync(path.join(__dirname, 'results-repro-t16a-wrap.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('已落盘 results-repro-t16a-wrap.json');
  mini.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.log('脚本异常: ' + (e && e.message));
  try { if (mini) mini.disconnect(); } catch (e2) {}
  process.exit(1);
});
