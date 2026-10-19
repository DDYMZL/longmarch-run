/**
 * AI 逐字回答（SSE 流式）端到端验收：模拟器 → 本机后端 → 真实大模型，全链路不 stub。
 *
 * 验的是「交互形态」而非回答内容：正文必须分多次增长（逐字渲染，不是一次性糊上来）、
 * 生成中有光标与「停止」按钮、点停止后保留半截回答且不再增长、收尾后 sending 复位。
 *
 * 前置：config.js DEV_TARGET='local'、本机 8010 后端已起且含 /api/ai/chat/stream、外网可达。
 * 用法（cwd 必须是本目录；一次 cli auto 武装只够一条连接，跑完即 close）：
 *   AI_LIVE_TOKEN=<服务端签发的JWT> AI_LIVE_UID=<用户id> node ai-chat-stream.cjs
 * 证据：结果写 ../ai-stream-ui-results.json；截图另起连接由 ai-chat-stream-shots.cjs 补拍。
 */
const fs = require('fs');
const path = require('path');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const TOKEN = (process.env.AI_LIVE_TOKEN || '').trim();
const UID = Number(process.env.AI_LIVE_UID || 0);
const QUESTION = '请用三四句话介绍遵义会议的历史意义。';
const STOP_QUESTION = '请详细讲讲红军飞夺泸定桥的经过。';
const SAMPLE_MS = 120;
const OUT = path.join(__dirname, '..', 'ai-stream-ui-results.json');

const results = [];
function rec(id, name, ok, detail) {
  results.push({ id, name, ok: !!ok, detail: String(detail || '').slice(0, 400) });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' ' + name + (detail ? ' | ' + detail : ''));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 在页面侧取一份极小的采样：逐字渲染要高频取样，整份 data（含 markdown blocks）过桥太贵。
 * 注意 evaluate 内不能 require 模块，只能用页面上下文里的全局。
 */
const SAMPLE_FN = () => {
  const ps = getCurrentPages();
  const p = ps[ps.length - 1];
  const d = (p && p.data) || {};
  const m = d.messages || [];
  const last = m[m.length - 1] || {};
  return {
    len: (last.content || '').length,
    blocks: (last.blocks || []).length,
    role: last.role || '',
    loading: !!last.loading,
    streaming: !!last.streaming,
    failed: !!last.failed,
    sources: (last.sources || []).length,
    usedTokens: last.usedTokens === undefined ? null : last.usedTokens,
    sending: !!d.sending,
    count: m.length,
    conv: d.conversationId || null,
    banner: d.banner || ''
  };
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

/**
 * 发一条提问并采集「正文长度随时间」的曲线，直到收尾或超时。
 * @param {object} opt { stopAfterLen:number } 给出则在正文达到该长度时点「停止」
 */
async function sendAndSample(mini, question, opt) {
  const o = opt || {};
  let page = await mini.currentPage();
  await page.setData({ inputText: question });
  await sleep(300);
  page = await mini.currentPage();
  const sendBtn = await page.$('.ai-send');
  if (!sendBtn) throw new Error('找不到发送按钮');
  await sendBtn.tap();

  const t0 = Date.now();
  const samples = [];
  const ui = { cursor: false, stopBtn: false, sendBtnBack: false, stopTappedAt: null };
  let stopTapped = false;
  const limit = o.timeout || 90000;

  while (Date.now() - t0 < limit) {
    await sleep(SAMPLE_MS);
    let s;
    try {
      s = await mini.evaluate(SAMPLE_FN);
    } catch (e) {
      continue; // 桥偶发抖动：丢一个采样点不影响判定
    }
    const t = Date.now() - t0;
    samples.push({ t, len: s.len, sending: s.sending, streaming: s.streaming, loading: s.loading,
      failed: s.failed, blocks: s.blocks, sources: s.sources, usedTokens: s.usedTokens,
      conv: s.conv, banner: s.banner, count: s.count });

    // 生成中的 UI 证据各查一次即可，不必每拍过桥
    if (s.sending && !ui.stopBtn) {
      try { ui.stopBtn = !!(await page.$('.ai-stop')); } catch (e) { /* 忽略 */ }
    }
    if (s.streaming && !ui.cursor) {
      try { ui.cursor = !!(await page.$('.ai-cursor')); } catch (e) { /* 忽略 */ }
    }
    if (!stopTapped && o.stopAfterLen && s.len >= o.stopAfterLen) {
      stopTapped = true;
      ui.stopTappedAt = t;
      try {
        const sb = await page.$('.ai-stop');
        if (sb) await sb.tap();
      } catch (e) { /* 忽略：后面用曲线判定是否真停下 */ }
      // 停止后继续采样，验证正文不再增长、按钮回到「发送」
      const tStop = Date.now();
      while (Date.now() - tStop < 2500) {
        await sleep(SAMPLE_MS);
        try {
          const s2 = await mini.evaluate(SAMPLE_FN);
          samples.push({ t: Date.now() - t0, len: s2.len, sending: s2.sending, streaming: s2.streaming,
            loading: s2.loading, failed: s2.failed, blocks: s2.blocks, sources: s2.sources,
            usedTokens: s2.usedTokens, conv: s2.conv, banner: s2.banner, count: s2.count });
        } catch (e) { /* 忽略 */ }
        if (!ui.sendBtnBack) {
          try { ui.sendBtnBack = !!(await page.$('.ai-send')) && !(await page.$('.ai-stop')); } catch (e) { /* 忽略 */ }
        }
      }
      break;
    }
    if (!s.sending && samples.length > 3) break;
  }
  return { samples, ui };
}

/** 从曲线里提取逐字渲染的判据：增长次数、首个非零字时刻、末次增长时刻、是否单调不减 */
function curve(samples) {
  const lens = samples.map((s) => s.len);
  let grows = 0;
  for (let i = 1; i < lens.length; i++) if (lens[i] > lens[i - 1]) grows++;
  let firstAt = null;
  let lastGrowAt = null;
  for (let i = 0; i < samples.length; i++) {
    if (firstAt === null && samples[i].len > 0) firstAt = samples[i].t;
    if (i > 0 && samples[i].len > samples[i - 1].len) lastGrowAt = samples[i].t;
  }
  const monotonic = lens.every((v, i) => i === 0 || v >= lens[i - 1]);
  const distinct = new Set(lens).size;
  return { grows, firstAt, lastGrowAt, monotonic, distinct, final: lens[lens.length - 1] || 0 };
}

(async () => {
  if (!TOKEN || !UID) {
    console.log('HARNESS ERR: 需通过 AI_LIVE_TOKEN / AI_LIVE_UID 传入服务端签发的 JWT 与用户 id');
    process.exit(1);
  }
  const mini = await automator.connect({ wsEndpoint: WS });
  await boot(mini);
  await mini.switchTab('/pages/ai-chat/ai-chat');
  await sleep(1800);

  // 干净起点：新建对话，避免上一轮残留消息干扰曲线判定
  let page = await mini.currentPage();
  const topBtns = await page.$$('.ai-topbtn');
  if (topBtns.length > 1) await topBtns[1].tap();
  await sleep(600);

  // ============ 阶段一：逐字渲染 ============
  const r1 = await sendAndSample(mini, QUESTION, { timeout: 90000 });
  const c1 = curve(r1.samples);
  const end1 = r1.samples[r1.samples.length - 1] || {};
  const totalMs = end1.t || 1;
  rec('A1', '正文分多次增长（逐字渲染，不是一次性返回）',
    c1.grows >= 3 && c1.distinct >= 4 && c1.monotonic,
    '增长次数=' + c1.grows + ' 不同长度=' + c1.distinct + ' 单调不减=' + c1.monotonic
    + ' 采样点=' + r1.samples.length);
  rec('A2', '首字明显早于回答结束（先出字再继续吐，而非等全部生成完）',
    c1.firstAt !== null && c1.firstAt < totalMs * 0.8 && c1.lastGrowAt > c1.firstAt,
    '首字=' + c1.firstAt + 'ms 末次增长=' + c1.lastGrowAt + 'ms 结束=' + totalMs + 'ms'
    + ' 首字占比=' + (c1.firstAt === null ? '-' : Math.round((c1.firstAt / totalMs) * 100) + '%'));
  rec('A3', '生成中：光标在正文末尾、发送按钮变为「停止」',
    r1.ui.cursor && r1.ui.stopBtn, 'cursor=' + r1.ui.cursor + ' stopBtn=' + r1.ui.stopBtn);
  rec('A4', '收尾：sending 复位、光标与停止按钮消失、正文与 blocks 非空、无失败标记',
    end1.sending === false && end1.failed === false && end1.len >= 20 && end1.blocks >= 1
    && !(await page.$('.ai-cursor')) && !(await page.$('.ai-stop')),
    'sending=' + end1.sending + ' failed=' + end1.failed + ' len=' + end1.len + ' blocks=' + end1.blocks);
  rec('A5', 'start 事件已写入 conversationId，done 带回 usedTokens，无 403/429 提示条',
    !!end1.conv && (end1.usedTokens || 0) > 0 && end1.banner === '',
    'conv=' + end1.conv + ' usedTokens=' + end1.usedTokens + ' banner=' + JSON.stringify(end1.banner));
  console.log('  曲线（ms:字数）：' + r1.samples
    .filter((s, i) => i % Math.max(1, Math.floor(r1.samples.length / 12)) === 0)
    .map((s) => s.t + ':' + s.len).join(' '));

  // ============ 阶段二：中途停止 ============
  const r2 = await sendAndSample(mini, STOP_QUESTION, { stopAfterLen: 10, timeout: 90000 });
  const atStop = r2.samples.filter((s) => s.t <= (r2.ui.stopTappedAt || 0));
  const afterStop = r2.samples.filter((s) => s.t > (r2.ui.stopTappedAt || 0));
  const lenAtStop = atStop.length ? atStop[atStop.length - 1].len : 0;
  const lensAfter = afterStop.map((s) => s.len);
  const frozen = lensAfter.length > 0 && lensAfter.every((v) => v === lensAfter[0]);
  const end2 = r2.samples[r2.samples.length - 1] || {};
  // tap 从发出到送达可延迟数百毫秒，这期间打字机仍在正常吐字，收尾字数因此允许略高于
  // 「点停止那一拍的采样字数」；判「真截断」看它是否远短于同模型的完整回答（end1.len）。
  const cutLimit = Math.max(60, Math.round(end1.len / 2));
  rec('A6', '生成中点「停止」：半截回答保留（不清空、不标失败、光标态复位）且明显短于完整回答',
    lenAtStop > 0 && end2.len >= lenAtStop && end2.len < cutLimit
    && end2.failed === false && end2.streaming === false,
    '停止时字数=' + lenAtStop + ' 收尾字数=' + end2.len + '(tap 送达期间多吐 '
    + (end2.len - lenAtStop) + ' 字) 截断阈值=' + cutLimit + ' failed=' + end2.failed
    + ' streaming=' + end2.streaming + ' 停止时刻=' + r2.ui.stopTappedAt + 'ms');
  rec('A7', '停止后正文不再增长，且定时器已停（继续采样长度恒定）',
    frozen && lensAfter.length >= 3,
    '停止后采样=' + JSON.stringify(lensAfter.slice(0, 8)));
  rec('A8', '停止后 sending 复位、按钮回到「发送」、光标消失，可立刻再提问',
    end2.sending === false && r2.ui.sendBtnBack && !(await page.$('.ai-cursor')),
    'sending=' + end2.sending + ' sendBtnBack=' + r2.ui.sendBtnBack);

  // ============ 阶段三：停止后仍能继续对话（同一会话追问） ============
  const convBefore = end2.conv;
  const r3 = await sendAndSample(mini, '那这次战斗发生在哪一年？', { timeout: 90000 });
  const c3 = curve(r3.samples);
  const end3 = r3.samples[r3.samples.length - 1] || {};
  rec('A9', '停止后追问仍走同一会话并继续逐字输出（会话未被中止操作打断）',
    end3.conv === convBefore && !!convBefore && c3.grows >= 2 && end3.sending === false
    && end3.failed === false && end3.len >= 5 && end3.count > (end2.count || 0),
    'conv=' + end3.conv + '(前=' + convBefore + ') 增长次数=' + c3.grows
    + ' 消息数=' + end3.count + ' len=' + end3.len);

  const pass = results.filter((r) => r.ok).length;
  console.log('\n合计 ' + results.length + ' 项：通过 ' + pass + '，失败 ' + (results.length - pass));
  fs.writeFileSync(OUT, JSON.stringify({ total: results.length, passed: pass, results }, null, 2), 'utf8');
  console.log('结果已写入 ' + OUT);
  await mini.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.log('HARNESS ERR: ' + (e && e.message ? e.message : e));
  const pass = results.filter((r) => r.ok).length;
  if (results.length) {
    fs.writeFileSync(OUT, JSON.stringify({ total: results.length, passed: pass, results }, null, 2), 'utf8');
  }
  process.exit(1);
});
