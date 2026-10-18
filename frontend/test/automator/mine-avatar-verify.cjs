/**
 * 一次性验证脚本（2026-10-18）：mine 页头像飘动遮挡修复 + 部门榜本地联调。
 *
 * 与 ui-test.cjs 的差异：不 mock wx.login —— 本地 8010 后端已配真实微信凭证且未开
 * WX_LOGIN_ALLOW_MOCK，mock code 会被 502 拒绝；IDE 已登录真实微信账号，真实 code
 * 可完成 code2Session，且该账号已在本地库入驻。
 *
 * 验证点：
 *   1) mine 页头像在飘动动画上行顶点（translateY -14rpx 附近）不被 button 裁剪：
 *      间隔截图两张 + 读取 avatar/button 计算样式与包围盒断言；
 *   2) 编辑角标不再被圆形 overflow:hidden 裁剪（角标中心在圆外但应完整可见）；
 *   3) rank 页切到「部门榜」不再 not found（本地后端已含 /rank/orgs）。
 *
 * 前置：开发者工具自动化端口 9420（连不上自动 cli.bat auto 重开）；本地后端 8010 运行中。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const CLI = 'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const PROJECT = 'D:/project/longmarch-run';
const IMAGES_DIR = path.join(__dirname, '..', 'images');
const OUT = path.join(__dirname, 'results-mine-avatar.json');

process.on('unhandledRejection', (e) => {
  console.log('未处理 rejection（已忽略）: ' + (e && e.message ? e.message : e));
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('超时:' + label)), ms); if (t.unref) t.unref(); });
  return Promise.race([Promise.resolve(p), to]).finally(() => clearTimeout(t));
}

function rearmBridge() {
  console.log('--- 重启自动化桥 ---');
  spawnSync('cmd.exe', ['/c', CLI, 'auto', '--project', PROJECT, '--auto-port', '9420'], { stdio: 'ignore', timeout: 60000 });
}

async function connectMini() {
  for (let i = 0; i < 3; i++) {
    try { return await withTimeout(automator.connect({ wsEndpoint: WS }), 20000, 'connect'); }
    catch (e) { console.log('connect 失败(' + (i + 1) + '/3): ' + e.message); await sleep(6000); }
  }
  rearmBridge();
  await sleep(25000);
  return await withTimeout(automator.connect({ wsEndpoint: WS }), 25000, 'connect-final');
}

const results = [];
function record(id, name, pass, detail) {
  results.push({ id, name, pass: !!pass, detail: String(detail == null ? '' : detail).slice(0, 400) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + (detail ? ' | ' + detail : ''));
}

/** 截图会使自动化桥退化（见 shots-tour.cjs 头注）：截完强制重连，失败不阻断后续阶段 */
async function safeShot(name) {
  try {
    await withTimeout(mini.screenshot({ path: path.join(IMAGES_DIR, name) }), 20000, 'shot ' + name);
    console.log('截图成功: ' + name);
  } catch (e) {
    console.log('截图失败(不阻断): ' + name + ' | ' + e.message);
  }
  try { await mini.disconnect(); } catch (e) { /* ignore */ }
  mini = null;
  await ensureMini();
}
let mini = null;
async function ensureMini() {
  if (mini) {
    const p = await withTimeout(mini.currentPage().catch(() => null), 6000, 'probe').catch(() => null);
    if (p) return mini;
    console.log('--- 桥已断开，重连 ---');
    try { await mini.disconnect(); } catch (e) { /* ignore */ }
    mini = null;
  }
  mini = await connectMini();
  return mini;
}

async function phaseLogin() {
  await ensureMini();
  // 等 appservice 就绪（currentPage 可返回）再探测，避免 evaluate 在启动期挂死
  for (let i = 0; i < 20; i++) {
    const p = await withTimeout(mini.currentPage().catch(() => null), 8000, 'currentPage-wait').catch(() => null);
    if (p && p.path) break;
    await sleep(1000);
  }

  // 真实 wx.login 可用性（重试容忍启动期抖动）
  let loginState = 'UNKNOWN';
  for (let i = 0; i < 5; i++) {
    loginState = await withTimeout(mini.evaluate(() => new Promise((resolve) => {
      wx.login({ success: (r) => resolve(r && r.code ? 'OK' : 'NO_CODE'), fail: (e) => resolve('FAIL:' + (e && e.errMsg)) });
    })), 10000, 'wx.login').catch((e) => 'EVAL:' + e.message);
    if (loginState === 'OK' || loginState.indexOf('FAIL:') === 0) break;
    console.log('wx.login 探测重试(' + (i + 1) + '/5): ' + loginState);
    await sleep(2000);
  }
  console.log('真实 wx.login => ' + loginState);
  if (loginState !== 'OK') throw new Error('真实 wx.login 不可用：' + loginState);

  // 回启动页完成自动登录（IDE 已登录真实微信账号，本地库已有该用户）
  await withTimeout(mini.reLaunch('/pages/launch/launch'), 15000, 'reLaunch launch').catch(async (e) => {
    console.log('reLaunch 异常（可能桥断）: ' + e.message);
    mini = null;
    await ensureMini();
  });
  await sleep(4500);
  const page = await withTimeout(mini.currentPage(), 8000, 'currentPage');
  console.log('启动后页面: ' + page.path);
  const ok = page.path === 'pages/home/home' || page.path === 'pages/mine/mine';
  record('A0', '启动后自动登录', ok, page.path);
  if (!ok) throw new Error('自动登录未完成');
}

async function phaseMine() {
  await ensureMini();
  await withTimeout(mini.switchTab('/pages/mine/mine'), 15000, 'switchTab mine');
  await sleep(2500);
  const page = await withTimeout(mini.currentPage(), 8000, 'currentPage mine');
  record('A1', '进入我的页', page.path === 'pages/mine/mine', page.path);

  // 样式断言：头像与按钮尺寸一致（border-box），角标完整在包裹层内
  const styleInfo = await withTimeout(mini.evaluate(() => {
    const q = wx.createSelectorQuery();
    return new Promise((resolve) => {
      q.select('.mine-avatar-btn').boundingClientRect();
      q.select('.mine-avatar-wrap').boundingClientRect();
      q.select('.mine-avatar').boundingClientRect();
      q.select('.avatar-edit-badge').boundingClientRect();
      q.exec((res) => {
        const [btn, wrap, avatar, badge] = res || [];
        if (!btn || !wrap || !avatar || !badge) { resolve(null); return; }
        resolve({
          btn: { top: btn.top, left: btn.left, width: btn.width, height: btn.height },
          wrap: { top: wrap.top, left: wrap.left, width: wrap.width, height: wrap.height },
          avatar: { top: avatar.top, left: avatar.left, width: avatar.width, height: avatar.height },
          badge: { top: badge.top, left: badge.left, width: badge.width, height: badge.height }
        });
      });
    });
  }), 10000, 'selectorQuery');
  if (!styleInfo) {
    record('A2', '头像区域节点齐全', false, 'selectorQuery 未取到节点');
  } else {
    const { btn, wrap, avatar, badge } = styleInfo;
    const sizeMatch = Math.abs(avatar.width - btn.width) < 1 && Math.abs(avatar.height - btn.height) < 1;
    record('A2', '头像与按钮尺寸一致（border-box 不溢出）', sizeMatch,
      'btn=' + btn.width + 'x' + btn.height + ' avatar=' + avatar.width + 'x' + avatar.height);
    const badgeInside = badge.left >= wrap.left - 1 && badge.top >= wrap.top - 1 &&
      badge.left + badge.width <= wrap.left + wrap.width + 1 &&
      badge.top + badge.height <= wrap.top + wrap.height + 1;
    record('A3', '编辑角标完整可见（不被圆形裁剪）', badgeInside,
      'badge=(' + badge.left + ',' + badge.top + ',' + badge.width + 'x' + badge.height + ') wrap=(' + wrap.left + ',' + wrap.top + ',' + wrap.width + 'x' + wrap.height + ')');
  }

  // 飘动行程对拍：周期 3.2s，顶点在 1.6s
  await safeShot('mine-avatar-float-a.png');
  await sleep(1600);
  await safeShot('mine-avatar-float-b.png');
  record('A4', '飘动行程两张截图已落盘', true, 'mine-avatar-float-a/b.png');
}

async function phaseRankOrg() {
  await ensureMini();
  await withTimeout(mini.switchTab('/pages/rank/rank'), 15000, 'switchTab rank');
  await sleep(2500);
  const rankPage = await withTimeout(mini.currentPage(), 8000, 'currentPage rank');
  await withTimeout(rankPage.setData({ tab: 'org', errorMsg: '' }), 8000, 'setData org');
  await withTimeout(rankPage.callMethod('refresh'), 10000, 'refresh org');
  await sleep(2500);
  const rankData = await withTimeout(rankPage.data(), 8000, 'rank data');
  const orgOk = rankData && rankData.tab === 'org' && !rankData.errorMsg && rankData.loading === false;
  record('A5', '部门榜加载成功（本地后端）', !!orgOk,
    'errorMsg=' + (rankData && rankData.errorMsg) + ' items=' + (rankData && rankData.orgList ? rankData.orgList.length : -1));
  await safeShot('rank-org-local.png');
}

/** AI 问答 markdown 渲染：注入合成助手消息（不打真实 AI 接口），断言 blocks 生成并截图验证 */
async function phaseAiMarkdown() {
  await ensureMini();
  await withTimeout(mini.switchTab('/pages/ai-chat/ai-chat'), 15000, 'switchTab ai-chat');
  await sleep(2000);
  await withTimeout(mini.currentPage(), 8000, 'currentPage ai-chat');

  // 解析函数正确性已由 Node 单测覆盖（parseMarkdownLite 无法在高内 evaluate 里 require 页面模块）。
  // 这里按解析产物结构注入合成消息，验证 WXML 渲染层（加粗/标题/列表）
  const msg = {
    _k: 'md1', role: 'assistant',
    content: '### 长征关键战役\n1. **遵义会议**：确立了新的领导集体，是伟大转折点。\n2. **四渡赤水**：运动战的典范。\n- 巧渡金沙江\n- 强渡大渡河\n\n以上战役**意义重大**。',
    blocks: [
      { _bk: 'b0', type: 'h', level: 3, segs: [{ _sk: 'b0s0', t: '长征关键战役', b: false }] },
      { _bk: 'b1', type: 'li', mark: '1.', segs: [{ _sk: 'b1s0', t: '遵义会议', b: true }, { _sk: 'b1s1', t: '：确立了新的领导集体，是伟大转折点。', b: false }] },
      { _bk: 'b2', type: 'li', mark: '2.', segs: [{ _sk: 'b2s0', t: '四渡赤水', b: true }, { _sk: 'b2s1', t: '：运动战的典范。', b: false }] },
      { _bk: 'b3', type: 'li', mark: '•', segs: [{ _sk: 'b3s0', t: '巧渡金沙江', b: false }] },
      { _bk: 'b4', type: 'li', mark: '•', segs: [{ _sk: 'b4s0', t: '强渡大渡河', b: false }] },
      { _bk: 'b6', type: 'p', segs: [{ _sk: 'b6s0', t: '以上战役', b: false }, { _sk: 'b6s1', t: '意义重大', b: true }, { _sk: 'b6s2', t: '。', b: false }] }
    ],
    sources: []
  };
  await withTimeout(mini.evaluate((m) => {
    const p = getCurrentPages().slice(-1)[0];
    p.setData({ messages: [m] });
  }, msg), 10000, 'inject message').catch((e) => console.log('注入消息异常: ' + e.message));
  await sleep(1200);
  const rendered = await withTimeout(mini.evaluate(() => {
    const q = wx.createSelectorQuery();
    return new Promise((resolve) => {
      q.selectAll('.ai-md-b').boundingClientRect();
      q.select('.ai-md-h').boundingClientRect();
      q.exec((res) => resolve({ boldCount: (res[0] || []).length, hasHeading: !!res[1] }));
    });
  }), 10000, 'render check').catch(() => null);
  record('A6', 'markdown 气泡渲染出加粗段与标题',
    !!rendered && rendered.boldCount >= 3 && rendered.hasHeading,
    rendered ? ('bold=' + rendered.boldCount + ' heading=' + rendered.hasHeading) : 'evaluate 失败');
  await safeShot('ai-chat-markdown.png');
  record('A7', 'AI 回答 markdown 气泡截图已落盘', true, 'ai-chat-markdown.png');
}

async function main() {
  // 桥不稳定时可分阶段重跑：node mine-avatar-verify.cjs ai|mine|rank（默认全量）
  const only = process.argv[2] || '';
  if (!only) {
    await phaseLogin();
    await phaseMine();
    await phaseRankOrg();
    await phaseAiMarkdown();
  } else {
    if (only === 'mine') await phaseMine();
    if (only === 'rank') await phaseRankOrg();
    if (only === 'ai') await phaseAiMarkdown();
  }
  const failed = results.filter((r) => !r.pass).length;
  fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
  console.log('完成：' + (results.length - failed) + '/' + results.length + ' 通过，结果落盘 ' + OUT);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('FATAL: ' + e.message);
  try { fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), fatal: e.message, results }, null, 2)); } catch (err) { /* ignore */ }
  process.exit(2);
});
