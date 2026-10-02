/**
 * P0-1 行军轨迹截图（与断言分离，每状态独立连接 —— 协议第3/3b条）
 *
 * 前置：node p0-march.cjs 已跑通；后端 8010 运行；自动化端口 9420。
 * 步骤：HTTP 给自动化账号补足步数（路线中段）→ 逐状态独立连接截图。
 * 产物：frontend/test/images/17-march-real-p0.png / 18-march-canvas-p0.png
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');
const automator = require('miniprogram-automator');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

const WS = 'ws://127.0.0.1:9420';
const CLI = 'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const PROJECT = 'D:/project/longmarch-run';
const IMG_DIR = path.join(__dirname, '..', 'images');

/** 截图后自动化桥退化：connect 失败时 rearm 自愈（协议第3d条） */
async function connectWithHeal(name) {
  for (let i = 0; i < 2; i++) {
    try {
      return await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect ' + name);
    } catch (e) {
      console.log('connect ' + name + ' 失败(' + (i + 1) + '/2): ' + e.message + '，rearm 自愈');
      spawnSync('cmd.exe', ['/c', CLI, 'auto', '--project', PROJECT, '--auto-port', '9420'], { stdio: 'ignore', timeout: 60000 });
      await sleep(25000);
    }
  }
  return await withTimeout(automator.connect({ wsEndpoint: WS }), 25000, 'connect-final ' + name);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('命令超时(' + ms + 'ms): ' + label)), ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t));
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

async function prepareSteps() {
  let code = 'automator-p0m-shot';
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
    if (s && s.loginCode) code = s.loginCode;
  } catch (e) { /* ignore */ }
  const login = await api('/auth/login', null, 'POST', { code, nickname: '自动化测试员' });
  const token = login.body && login.body.token;
  if (!token) throw new Error('登录失败: ' + login.status);
  const today = await api('/sport/today', token);
  console.log('当前累计步数=' + (today.body ? today.body.totalSteps : '?'));
  // 补到 ~30000（路线中段：泸定桥后、雪山前）
  const need = 30000 - (today.body ? today.body.totalSteps : 0);
  if (need > 0) {
    await api('/sport/add', token, 'POST', { delta: need });
    const lit = await api('/march/light-up', token, 'POST');
    console.log('补步数 ' + need + '，新点亮 ' + (lit.body && lit.body.newlyLit ? lit.body.newlyLit.length : 0) + ' 个节点');
  } else {
    console.log('步数已足够，无需补充');
  }
}

async function shotOnce(name, nav, file) {
  const mini = await connectWithHeal(name);
  try {
    await nav(mini);
    await sleep(2600);
    const target = path.join(IMG_DIR, file);
    await withTimeout(mini.screenshot({ path: target }), 25000, 'screenshot ' + name);
    console.log('SHOT ' + file);
  } finally {
    try { await mini.disconnect(); } catch (e) { /* ignore */ }
  }
}

/** 整状态重试：截图后桥退化不可预测，失败即 rearm 后重拍（协议第3/3d条） */
async function shotState(name, nav, file) {
  for (let i = 0; i < 2; i++) {
    try {
      await shotOnce(name, nav, file);
      return;
    } catch (e) {
      if (i === 1) throw e;
      console.log('状态 ' + name + ' 失败(' + (i + 1) + '/2): ' + e.message + '，rearm 后重试');
      spawnSync('cmd.exe', ['/c', CLI, 'auto', '--project', PROJECT, '--auto-port', '9420'], { stdio: 'ignore', timeout: 60000 });
      await sleep(25000);
    }
  }
}

(async () => {
  await prepareSteps();

  // 状态A：实景地图（进行中段：已点亮金色路线 + 进度旗）
  await shotState('march-real', async (mini) => {
    await withTimeout(mini.switchTab('/pages/march/march'), 20000, 'switchTab march');
  }, '17-march-real-p0.png');

  // 状态B：插画地图（星空远征 + 呼吸光点进度旗）
  await shotState('march-canvas', async (mini) => {
    await withTimeout(mini.switchTab('/pages/march/march'), 20000, 'switchTab march');
    const page = await withTimeout(mini.currentPage(), 10000, 'currentPage');
    await withTimeout(page.callMethod('switchMode', { currentTarget: { dataset: { mode: 'canvas' } } }), 20000, 'switchMode canvas');
  }, '18-march-canvas-p0.png');

  console.log('== 截图完成 ==');
  process.exit(0);
})().catch((e) => {
  console.log('FATAL: ' + (e && e.message));
  process.exit(2);
});
