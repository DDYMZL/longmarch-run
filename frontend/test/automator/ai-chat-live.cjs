/**
 * AI 历史助手真实链路验收（模拟器 → 本机后端 → CloudBase Agent，全真调用不 stub）
 * 前置：config.js ENV='local'、本机 8010 后端已起、外网可达（VPN 关闭态）；
 *       登录态用服务端签发的真实 JWT 注入 Storage（用户为本地开发库既有账号）。
 * 用法（cwd 必须是本目录，每次运行前需 cli auto 武装）：
 *   AI_LIVE_TOKEN=<服务端签发的JWT> node ai-chat-live.cjs assert   发送真实提问并断言回答/来源/提示条
 *   AI_LIVE_TOKEN=<服务端签发的JWT> node ai-chat-live.cjs shot     打开会话抽屉进入该会话并截图（视觉证据）
 */
const fs = require('fs');
const path = require('path');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const MODE = process.argv[2] || 'assert';
const TOKEN = (process.env.AI_LIVE_TOKEN || '').trim();
if (!TOKEN) { console.log('HARNESS ERR: 需通过环境变量 AI_LIVE_TOKEN 传入服务端签发的 JWT'); process.exit(1); }
const CONV_FILE = path.join(__dirname, '..', '..', '..', 'tmp_ai_live_conv.txt');
const QUESTION = '遵义会议有什么历史意义？';
const results = [];
function rec(id, name, ok, detail) {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' ' + name + (detail ? ' | ' + detail : ''));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function boot(mini) {
  for (let i = 0; i < 8; i++) {
    try {
      const ok = await mini.evaluate((token) => {
        const app = getApp();
        if (!app) return false;
        wx.setStorageSync('lm_auth_token', token);
        app.globalData.loggedIn = true;
        app.globalData.user = { id: 267, nickname: '长征小战士', avatar: '' };
        return true;
      }, TOKEN);
      if (ok) return;
    } catch (e) { /* app 未就绪，重试 */ }
    await sleep(1000);
  }
  throw new Error('注入登录态失败');
}

(async () => {
  const mini = await automator.connect({ wsEndpoint: WS });
  await boot(mini);
  await mini.switchTab('/pages/ai-chat/ai-chat');
  await sleep(1500);
  let page = await mini.currentPage();

  if (MODE === 'shot') {
    const drawerBtn = await page.$('.ai-topbtn');
    await drawerBtn.tap();
    await sleep(1500);
    page = await mini.currentPage();
    const first = await page.$('.ai-session-main');
    rec('S0', '抽屉列出真实会话', !!first);
    if (first) {
      await first.tap();
      await sleep(2000);
    }
    const file = path.join(__dirname, '..', 'images', 'ai-chat-live.png');
    await mini.screenshot({ path: file });
    console.log('SHOT ' + file);
    const pass = results.filter(Boolean).length;
    console.log('\n合计 ' + results.length + ' 项：通过 ' + pass + '，失败 ' + (results.length - pass));
    await mini.close();
    process.exit(0);
  }

  // assert 模式：真实发送 → 等待真实 Agent 回答
  await page.setData({ inputText: QUESTION });
  await sleep(400);
  const sendBtn = await page.$('.ai-send');
  await sendBtn.tap();
  let done = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    await sleep(1500);
    page = await mini.currentPage();
    const d = await page.data();
    const last = d.messages[d.messages.length - 1];
    if (!last) continue;
    if (last.role === 'assistant' && !last.loading) { done = d; break; }
    if (last.failed) { done = d; break; }
  }
  if (!done) {
    rec('L1', '真实 Agent 回答返回', false, '90s 内未收到助手消息');
  } else {
    const last = done.messages[done.messages.length - 1];
    const failed = !!last.failed;
    const content = last.content || '';
    rec('L1', '真实 Agent 回答返回（非空、无失败标记）', !failed && content.length >= 20,
      'len=' + content.length + ' failed=' + failed);
    rec('L2', '回答带平台用量 usedTokens>0', (last.usedTokens || 0) > 0, 'usedTokens=' + last.usedTokens);
    rec('L3', '无 403/429 提示条', done.banner === '', 'banner=' + JSON.stringify(done.banner));
    rec('L4', '会话已建立（conversationId 非空）', !!done.conversationId, 'conv=' + done.conversationId);
    console.log('回答样例：' + content.slice(0, 100));
    console.log('来源数：' + (last.sources ? last.sources.length : 0));
    if (done.conversationId) fs.writeFileSync(CONV_FILE, String(done.conversationId));
  }
  const pass = results.filter(Boolean).length;
  console.log('\n合计 ' + results.length + ' 项：通过 ' + pass + '，失败 ' + (results.length - pass));
  await mini.close();
  process.exit(0);
})().catch((e) => {
  console.log('HARNESS ERR: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
