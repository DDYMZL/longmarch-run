/**
 * AI 流式客户端离线校验（services/request.js 的 requestStream + services/ai.js 的 chatStream）。
 *
 * 不连后端：用假的 wx.request 按脚本投递字节分片，覆盖真机上最难复现的三类问题——
 * ① 多字节汉字被切在分片边界（小程序没有 TextDecoder，解码器写错就是满屏乱码）；
 * ② SSE 事件跨分片、坏块、\r\n 换行；③ 退化路径（401 / 传输失败 / 不支持分块）与 abort。
 *
 * 用法：cd frontend && node test/ai-stream-check.cjs
 */
let canUseChunked = true;
let requests = [];
let chunkScript = null; // { chunks: Buffer[], status, body, failWith, noChunkApi, delay }
let lastChunkTask = null;
let plainResponse = null; // { status, body, failWith }

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** 分块响应：按 setImmediate 逐片投递，模拟真机上 onChunkReceived 的异步到达。 */
function mockChunked(opts) {
  const script = chunkScript || { chunks: [] };
  const task = {
    _cb: null,
    aborted: false,
    onChunkReceived(cb) {
      task._cb = cb;
    },
    abort() {
      task.aborted = true;
      // 真机上已排队的分片仍可能在 abort 之后投递一次，刻意复现以验证调用方会丢弃它
      if (task._cb && script.chunks[i]) task._cb({ data: toArrayBuffer(script.chunks[i]) });
      if (opts.fail) opts.fail({ errMsg: 'request:fail abort' });
    }
  };
  if (script.noChunkApi) delete task.onChunkReceived;
  lastChunkTask = task;
  // 默认尽快投递；只有需要「中止落在流中间」的用例才拉开片间隔
  // （setTimeout 每片至少 1ms，1 字节切片会产生数百片，会超出用例等待窗口）
  const next = script.delay ? (fn) => setTimeout(fn, script.delay) : setImmediate;
  let i = 0;
  const step = () => {
    if (task.aborted) return;
    if (i < script.chunks.length) {
      if (task._cb) task._cb({ data: toArrayBuffer(script.chunks[i]) });
      i += 1;
      next(step);
      return;
    }
    if (script.failWith) {
      opts.fail({ errMsg: script.failWith });
      return;
    }
    opts.success({
      statusCode: script.status || 200,
      data: script.body === undefined ? '' : script.body,
      header: {}
    });
  };
  setImmediate(step);
  return task;
}

/** 普通响应：退化路径（chat()）与 401 静默重登都走它。 */
function mockPlain(opts) {
  const resp = plainResponse || { status: 200, body: {} };
  setImmediate(() => {
    if (resp.failWith) {
      opts.fail({ errMsg: resp.failWith });
      return;
    }
    opts.success({ statusCode: resp.status, data: resp.body, header: {} });
  });
  return { abort() {} };
}

global.wx = {
  canIUse: () => canUseChunked,
  getStorageSync: () => 'fake-token',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  getStorageInfoSync: () => ({ keys: [] }),
  reLaunch: () => {},
  request: (opts) => {
    requests.push({
      url: opts.url,
      method: opts.method,
      enableChunked: !!opts.enableChunked,
      timeout: opts.timeout,
      auth: (opts.header || {}).Authorization || '',
      data: opts.data
    });
    return opts.enableChunked ? mockChunked(opts) : mockPlain(opts);
  }
};

const ai = require('../services/ai');

const RESULTS = [];
function record(id, name, ok, detail) {
  RESULTS.push({ id, name, ok: !!ok, detail: String(detail || '').slice(0, 300) });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' ' + name + (detail ? ' | ' + detail : ''));
}

/** 把事件对象编码成后端一致的 SSE 字节（data: {json}\n\n，中文不转义）。 */
function sse(evt, sep) {
  return Buffer.from('data: ' + JSON.stringify(evt) + (sep || '\n\n'), 'utf8');
}

/** 把整段字节按固定步长重切，刻意制造跨片的多字节字符与半截事件行。 */
function rechunk(bufs, size) {
  const all = Buffer.concat(bufs);
  const out = [];
  for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));
  return out;
}

/**
 * 跑一次 chatStream，收集回调事件直到出现终止事件（done/error）或超时。
 * @returns {Promise<{events:Array, handle:object}>}
 */
function run(chunks, opts) {
  const o = opts || {};
  requests = [];
  canUseChunked = o.canUseChunked !== false;
  chunkScript = { chunks: chunks, status: o.status, body: o.body, failWith: o.failWith,
    noChunkApi: o.noChunkApi, delay: o.delay };
  lastChunkTask = null;
  plainResponse = o.plain || { status: 200, body: { conversationId: 9, title: '退化会话', reply: '一次性回答', sources: [], usedTokens: 7 } };

  const events = [];
  const push = (name) => (arg) => events.push({ name, arg });
  const handle = ai.chatStream(o.message || '飞夺泸定桥是怎么回事？', o.conversationId, o.nodeId, {
    onStart: push('start'),
    onDelta: push('delta'),
    onDone: push('done'),
    onError: push('error')
  });
  if (o.onHandle) o.onHandle(handle);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const last = events[events.length - 1];
      const terminated = last && (last.name === 'done' || last.name === 'error');
      if (terminated || Date.now() - t0 > (o.wait || 400)) {
        clearInterval(timer);
        resolve({ events, handle });
      }
    }, 4);
  });
}

const text = (events, name) => events.filter((e) => e.name === name).map((e) => e.arg).join('');
const count = (events, name) => events.filter((e) => e.name === name).length;
const last = (events) => events[events.length - 1] || {};

async function main() {
  const answer = '飞夺泸定桥发生在1935年5月29日，红四团22名突击队员攀踏铁索夺桥。🚩';

  // ============ C01 多字节字符跨分片：逐字节/3 字节切片都不乱码 ============
  const stream = [
    sse({ type: 'start', conversationId: 3, title: '飞夺泸定桥' }),
    sse({ type: 'delta', text: answer.slice(0, 12) }),
    sse({ type: 'delta', text: answer.slice(12, 25) }),
    sse({ type: 'delta', text: answer.slice(25) }),
    sse({ type: 'done', reply: answer, sources: [{ id: 1, title: '泸定桥', source: '《党史》' }], usedTokens: 321 }),
    Buffer.from('data: [DONE]\n\n', 'utf8')
  ];
  for (const size of [1, 3, 7]) {
    const r = await run(rechunk(stream, size));
    record('C01-' + size, '按 ' + size + ' 字节切片：增量拼接 == done.reply，emoji 与汉字无乱码',
      text(r.events, 'delta') === answer && count(r.events, 'done') === 1
      && last(r.events).arg.reply === answer,
      '拼接长度=' + text(r.events, 'delta').length + '/' + answer.length
      + ' 尾部=' + JSON.stringify(text(r.events, 'delta').slice(-4)));
  }

  // ============ C02 事件语义与顺序 ============
  const r2 = await run(stream);
  const start2 = r2.events.filter((e) => e.name === 'start')[0] || {};
  const done2 = last(r2.events).arg || {};
  record('C02', 'start 给出 conversationId/title，delta 三片，done 带 reply/sources/usedTokens',
    count(r2.events, 'start') === 1 && count(r2.events, 'delta') === 3 && count(r2.events, 'done') === 1
    && start2.arg.conversationId === 3 && start2.arg.title === '飞夺泸定桥'
    && r2.events.map((e) => e.name).join(',') === 'start,delta,delta,delta,done'
    && done2.conversationId === 3 && done2.usedTokens === 321
    && done2.sources.length === 1 && done2.sources[0].title === '泸定桥',
    '顺序=' + r2.events.map((e) => e.name).join(','));
  record('C03', '请求打到 /api 前缀的 /ai/chat/stream，POST + 分块 + 带 JWT + 不限时超时',
    requests.length === 1 && /\/ai\/chat\/stream$/.test(requests[0].url)
    && requests[0].enableChunked === true && requests[0].auth === 'Bearer fake-token'
    && requests[0].timeout === 120000,
    JSON.stringify(requests[0]));

  // ============ C04 事件跨片 + 坏块 + \r\n 换行 ============
  const mixed = Buffer.concat([
    sse({ type: 'start', conversationId: 5, title: 't' }),
    Buffer.from('data: {"type":"delta","text":"前半', 'utf8'),
    Buffer.from('段"}\r\n\r\n', 'utf8'),
    Buffer.from('data: {坏块 不是 JSON}\n\ndata: {"type":"delta","text":"后半段"}\n\n', 'utf8'),
    sse({ type: 'done', reply: '前半段后半段', sources: [], usedTokens: 1 })
  ]);
  const r4 = await run(rechunk([mixed], 5));
  record('C04', '半截事件行跨片续接、\\r\\n 分帧、坏块跳过而不中断后续事件',
    text(r4.events, 'delta') === '前半段后半段' && count(r4.events, 'done') === 1
    && count(r4.events, 'error') === 0,
    '拼接=' + JSON.stringify(text(r4.events, 'delta')));

  // ============ C05 前置校验失败：普通 JSON + 状态码，不退化不重试 ============
  const errBody = { detail: '今日 AI 提问额度已用完，请明天再来' };
  const r5 = await run([Buffer.from(JSON.stringify(errBody), 'utf8')], { status: 429 });
  const e5 = last(r5.events).arg || {};
  record('C05', '429 额度用尽：错误体只在分片里也能解析出 detail，statusCode 保留，不再退化重试',
    e5.statusCode === 429 && e5.message === errBody.detail && requests.length === 1,
    'status=' + e5.statusCode + ' msg=' + e5.message + ' 请求数=' + requests.length);

  const offBody = { detail: 'AI 助手暂未开放' };
  const r5b = await run([], { status: 403, body: offBody }); // 错误体走 res.data（不经分片）
  const e5b = last(r5b.events).arg || {};
  record('C06', '403 AI 未开放：res.data 路径同样解析出 detail，不退化',
    e5b.statusCode === 403 && e5b.message === offBody.detail && requests.length === 1,
    'status=' + e5b.statusCode + ' msg=' + e5b.message);

  // ============ C07 401 退化为一次性 chat()（复用 request.js 的静默重登） ============
  const r7 = await run([Buffer.from('{"detail":"登录已过期"}', 'utf8')], { status: 401 });
  record('C07', '401：退化为一次性 /ai/chat，整段回答当作单个 delta 推出，页面渲染路径唯一',
    requests.length === 2 && requests[1].url.indexOf('/ai/chat') > 0
    && requests[1].enableChunked === false && requests[1].timeout === 60000
    && text(r7.events, 'delta') === '一次性回答' && count(r7.events, 'done') === 1
    && last(r7.events).arg.conversationId === 9,
    '请求=' + requests.map((r) => r.url + (r.enableChunked ? '(chunked)' : '')).join(' , '));

  // ============ C08 传输失败：无增量则退化，有增量则报错（避免正文重复） ============
  const r8a = await run([], { failWith: 'request:fail timeout' });
  record('C08', '一个增量都没收到就断网 → 退化重发（后端已清掉这次提问，不会重复）',
    requests.length === 2 && count(r8a.events, 'done') === 1 && text(r8a.events, 'delta') === '一次性回答',
    '请求数=' + requests.length);

  const r8b = await run([sse({ type: 'start', conversationId: 7, title: 't' }), sse({ type: 'delta', text: '已推出的半截' })],
    { failWith: 'request:fail 网络中断' });
  const e8b = last(r8b.events).arg || {};
  record('C09', '已推出增量后断网 → 不退化重发，只报错（重发会让正文重复）',
    requests.length === 1 && e8b.network === true && /网络/.test(e8b.message || '')
    && text(r8b.events, 'delta') === '已推出的半截',
    '请求数=' + requests.length + ' err=' + e8b.message);

  // ============ C10 流中途上游故障事件 ============
  const r10 = await run([sse({ type: 'start', conversationId: 8, title: 't' }),
    sse({ type: 'delta', text: '半截' }),
    sse({ type: 'error', message: 'AI 生成超时，请稍后重试' })]);
  record('C10', 'SSE error 事件：转成带 message 的 Error 交页面提示，不触发退化',
    last(r10.events).name === 'error' && last(r10.events).arg.message === 'AI 生成超时，请稍后重试'
    && requests.length === 1,
    'err=' + (last(r10.events).arg || {}).message);

  // ============ C11 abort：停止回调，不再产生新事件 ============
  const many = [sse({ type: 'start', conversationId: 11, title: 't' })];
  for (let i = 0; i < 40; i += 1) many.push(sse({ type: 'delta', text: '字' }));
  many.push(sse({ type: 'done', reply: 'x', sources: [], usedTokens: 1 }));
  const r11 = await run(many, {
    wait: 250,
    delay: 4, // 40 片 × 4ms ≈ 160ms，30ms 时中止必定落在流中间
    onHandle: (h) => setTimeout(() => h.abort(), 30)
  });
  const atAbort = count(r11.events, 'delta');
  await new Promise((res) => setTimeout(res, 150));
  record('C11', 'abort() 后不再有任何回调（含 abort 后仍投递的排队分片），页面可自行收尾保留半截回答',
    atAbort > 0 && atAbort < 40 && count(r11.events, 'delta') === atAbort
    && count(r11.events, 'done') === 0 && count(r11.events, 'error') === 0
    && !!lastChunkTask && lastChunkTask.aborted === true,
    '中止时已收=' + atAbort + '/40 静置 150ms 后=' + count(r11.events, 'delta')
    + ' 底层 task.abort=' + !!(lastChunkTask && lastChunkTask.aborted));

  // ============ C12 基础库不支持分块 / 运行时缺 onChunkReceived ============
  const r12a = await run([], { canUseChunked: false });
  record('C12', 'canIUse 判定不支持分块：直接走一次性 chat()，不发流式请求',
    requests.length === 1 && requests[0].enableChunked === false
    && text(r12a.events, 'delta') === '一次性回答' && count(r12a.events, 'done') === 1,
    '请求=' + JSON.stringify(requests[0] && requests[0].url));

  const r12b = await run(stream, { noChunkApi: true });
  record('C13', 'canIUse 说谎（拿不到 onChunkReceived）：中止流式请求并退化，功能不中断',
    requests.length === 2 && requests[0].enableChunked === true && requests[1].enableChunked === false
    && text(r12b.events, 'delta') === '一次性回答',
    '请求数=' + requests.length + ' 拼接=' + JSON.stringify(text(r12b.events, 'delta')));

  // ============ C14/C15 请求体透传 ============
  const tiny = [sse({ type: 'start', conversationId: 42, title: 't' }),
    sse({ type: 'done', reply: 'ok', sources: [], usedTokens: 1 })];
  const r14 = await run(tiny, { message: '节点追问', conversationId: 42, nodeId: 7 });
  const body14 = (requests[0] || {}).data || {};
  record('C14', 'message/conversationId/nodeId 透传到流式端点（连续对话与节点上下文不丢）',
    requests.length === 1 && requests[0].method === 'POST' && body14.message === '节点追问'
    && body14.conversationId === 42 && body14.nodeId === 7 && count(r14.events, 'done') === 1
    && last(r14.events).arg.conversationId === 42,
    JSON.stringify(body14));

  const r15 = await run(tiny, { message: '新问题' });
  const body15 = (requests[0] || {}).data || {};
  record('C15', '新建会话：请求体只带 message，不塞 null/0 之类空值',
    Object.keys(body15).join(',') === 'message' && body15.message === '新问题'
    && count(r15.events, 'done') === 1,
    JSON.stringify(body15));

  const ok = RESULTS.filter((r) => r.ok).length;
  console.log('\n合计 ' + RESULTS.length + ' 项：通过 ' + ok + '，失败 ' + (RESULTS.length - ok));
  require('fs').writeFileSync(__dirname + '/ai-stream-check-results.json',
    JSON.stringify({ total: RESULTS.length, passed: ok, results: RESULTS }, null, 2), 'utf8');
  return ok === RESULTS.length ? 0 : 1;
}

process.exitCode = 1;
main().then((code) => {
  process.exit(code);
}).catch((err) => {
  console.error('用例执行异常：', err);
  process.exit(1);
});
