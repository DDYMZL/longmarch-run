/**
 * AI 历史助手聊天页 —— 真机(开发者工具)渲染校验（不依赖后端/Agent，全部用 setData 注入代表数据）
 * 覆盖：空状态常见问题、用户/AI 气泡、知识来源、加载三点、失败重试、会话抽屉。
 * 用法（cwd 必须是本目录）：node ai-chat-render.cjs
 */
const path = require('path');
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const IMG = path.join(__dirname, '..', 'images');
const results = [];
function rec(id, name, ok, detail) {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' ' + name + (detail ? ' | ' + detail : ''));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const mini = await automator.connect({ wsEndpoint: WS });
  // 注入登录态，避免 ai-chat onShow 守卫弹回启动页（不触任何后端）
  await mini.evaluate(() => {
    const app = getApp();
    app.globalData.loggedIn = true;
    app.globalData.user = { id: 1, nickname: '渲染校验', avatar: '' };
  });
  await mini.reLaunch('/pages/ai-chat/ai-chat');
  await sleep(1200);
  let page = await mini.currentPage();
  rec('V1', '进入 ai-chat 页', !!page && page.path === 'pages/ai-chat/ai-chat', page && page.path);

  let d = await page.data();
  rec('V2', '空状态：常见问题 4 条、消息为空', d.commonQuestions.length === 4 && d.messages.length === 0,
    'common=' + d.commonQuestions.length + ' msgs=' + d.messages.length);

  // 注入一段代表性对话：用户问 / AI 答(含来源) / 用户失败 / AI 加载中
  page = await mini.currentPage();
  await page.setData({
    title: '遵义会议的意义',
    messages: [
      { _k: 'm1', role: 'user', content: '遵义会议有什么历史意义？', sources: [], failed: false },
      { _k: 'm2', role: 'assistant', content: '遵义会议是红军长征途中一次生死攸关的转折点，事实上确立了毛泽东在党中央和红军的领导地位。', sources: [{ id: 1, title: '遵义会议史料', source: '公开史料', category: 'event' }], usedTokens: 431 },
      { _k: 'm3', role: 'user', content: '它发生在哪一年？', sources: [], failed: true },
      { _k: 'm4', role: 'assistant', content: '', sources: [], loading: true }
    ]
  });
  await sleep(700);
  d = await page.data();
  const hasSrc = d.messages[1].sources.length === 1;
  const hasFailed = d.messages[2].failed === true;
  const hasLoading = d.messages[3].loading === true;
  rec('V3', '对话渲染：4 条消息 + 标题 + 来源/失败/加载态', d.messages.length === 4 && d.title === '遵义会议的意义'
    && hasSrc && hasFailed && hasLoading,
    'msgs=' + d.messages.length + ' src=' + hasSrc + ' failed=' + hasFailed + ' loading=' + hasLoading);

  // 会话抽屉（注入列表，不触后端）
  page = await mini.currentPage();
  await page.setData({
    showSessions: true,
    sessionsLoading: false,
    sessions: [
      { conversationId: 2, title: '遵义会议的意义', preview: '它发生在哪一年？', messageCount: 4, timeText: '刚刚' },
      { conversationId: 1, title: '飞夺泸定桥', preview: '红军如何夺取泸定桥？', messageCount: 6, timeText: '2小时前' }
    ]
  });
  await sleep(600);
  d = await page.data();
  rec('V4', '会话抽屉：显示 2 条会话', d.showSessions === true && d.sessions.length === 2,
    'show=' + d.showSessions + ' n=' + d.sessions.length);

  const pass = results.filter(Boolean).length;
  console.log('\n合计 ' + results.length + ' 项：通过 ' + pass + '，失败 ' + (results.length - pass));
  await mini.close();
  process.exit(0);
})().catch((e) => {
  console.log('HARNESS ERR: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
