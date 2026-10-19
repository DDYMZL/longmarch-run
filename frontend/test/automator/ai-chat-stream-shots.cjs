/**
 * AI 逐字回答（SSE 流式）—— 视觉证据截图，与 ai-chat-stream.cjs 的断言分离运行。
 *
 * 拍的是真实流式过程中的画面（不是 setData 造的数据）：光标必须落在已渲染正文的末尾、
 * 发送按钮在生成中变成「停止」、点停止后半截回答原样留在气泡里。
 *
 * 截图会让自动化桥退化（见测试协议 #3），故每次调用只拍一张、拍完即 close；
 * 状态之间由外部 `cli.bat auto` 重新武装。
 *
 * 前置：config.js DEV_TARGET='local'、本机 8010 后端已起、外网可达。
 * 用法（cwd 必须是本目录）：
 *   AI_LIVE_TOKEN=<JWT> AI_LIVE_UID=<用户id> node ai-chat-stream-shots.cjs <typing|stopped>
 * 产物：../images/ai-stream-typing.png、../images/ai-stream-stopped.png
 */
const path = require('path');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const TOKEN = (process.env.AI_LIVE_TOKEN || '').trim();
const UID = Number(process.env.AI_LIVE_UID || 0);
const IMG = path.join(__dirname, '..', 'images');
const QUESTION = '请用三四句话介绍遵义会议的历史意义。';
const SAMPLE_MS = 120;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 只取判定必需的极小字段，避免整份 data（含 markdown blocks）高频过桥 */
const LEN_FN = () => {
  const ps = getCurrentPages();
  const p = ps[ps.length - 1];
  const d = (p && p.data) || {};
  const m = d.messages || [];
  const last = m[m.length - 1] || {};
  return { len: (last.content || '').length, sending: !!d.sending, streaming: !!last.streaming };
};

async function boot(mini) {
  for (let i = 0; i < 10; i++) {
    try {
      const ok = await mini.evaluate((token, uid) => {
        const app = getApp();
        if (!app) return false;
        wx.setStorageSync('lm_auth_token', token);
        app.globalData.loggedIn = true;
        app.globalData.user = { id: uid, nickname: '流式验收', avatar: '' };
        return true;
      }, TOKEN, UID);
      if (ok) return;
    } catch (e) {
      /* app 未就绪，重试 */
    }
    await sleep(1000);
  }
  throw new Error('注入登录态失败');
}

/** 提问后等到正文长度进入 [min, max] 区间，返回当时的页面句柄 */
async function typeUntil(mini, min, max) {
  const page = await mini.currentPage();
  await page.setData({ inputText: QUESTION });
  await sleep(300);
  const btn = await (await mini.currentPage()).$('.ai-send');
  if (!btn) throw new Error('找不到发送按钮');
  await btn.tap();
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    await sleep(SAMPLE_MS);
    let s;
    try {
      s = await mini.evaluate(LEN_FN);
    } catch (e) {
      continue;
    }
    if (s.len >= min && (max === undefined || s.len <= max)) return page;
    if (!s.sending) throw new Error('回答已收尾，没抓到了流式中间态（len=' + s.len + '）');
  }
  throw new Error('等待流式正文超时');
}

(async () => {
  const which = process.argv[2] || 'typing';
  if (!TOKEN || !UID) {
    console.log('SHOTS ERR: 需通过 AI_LIVE_TOKEN / AI_LIVE_UID 传入服务端签发的 JWT 与用户 id');
    process.exit(1);
  }
  const mini = await automator.connect({ wsEndpoint: WS });
  await boot(mini);
  await mini.reLaunch('/pages/ai-chat/ai-chat');
  await sleep(2000);

  // 干净起点：新建对话，避免历史消息把画面挤掉
  const page = await mini.currentPage();
  const topBtns = await page.$$('.ai-topbtn');
  if (topBtns.length > 1) await topBtns[1].tap();
  await sleep(600);

  if (which === 'typing') {
    await typeUntil(mini, 20, 70);
  } else if (which === 'stopped') {
    const p = await typeUntil(mini, 10, 60);
    const stop = await p.$('.ai-stop');
    if (!stop) throw new Error('找不到停止按钮');
    await stop.tap();
    await sleep(1200); // 等停止收尾渲染完（撤光标、按钮回「发送」）
  } else {
    console.log('unknown state: ' + which);
    process.exit(1);
  }

  const name = 'ai-stream-' + which + '.png';
  await mini.screenshot({ path: path.join(IMG, name) });
  console.log('shot -> ' + name);
  await mini.close();
  process.exit(0);
})().catch((e) => {
  console.log('SHOTS ERR: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
