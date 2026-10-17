/**
 * AI 历史助手聊天页 —— 视觉证据截图（与断言分离，每状态以主动导航开头唤醒桥）
 * 用法（cwd 必须是本目录）：node ai-chat-shots.cjs
 */
const path = require('path');
const { spawnSync } = require('child_process');
const automator = require('miniprogram-automator');
const WS = 'ws://127.0.0.1:9420';
const CLI = 'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const PROJ = 'D:/project/longmarch-run';
const IMG = path.join(__dirname, '..', 'images');
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rearm() {
  spawnSync(CLI, ['auto', '--project', PROJ, '--auto-port', '9420'], { shell: true, stdio: 'ignore' });
  sleep(20000);
}

const CONV = [
  { _k: 'm1', role: 'user', content: '遵义会议有什么历史意义？', sources: [], failed: false },
  { _k: 'm2', role: 'assistant', content: '遵义会议是红军长征途中一次生死攸关的转折点，事实上确立了毛泽东在党中央和红军的领导地位，标志着中国共产党在政治上开始走向成熟。', sources: [{ id: 1, title: '遵义会议史料', source: '公开史料', category: 'event' }], usedTokens: 431 },
  { _k: 'm3', role: 'user', content: '它发生在哪一年？', sources: [], failed: true },
  { _k: 'm4', role: 'assistant', content: '', sources: [], loading: true }
];
const SESSIONS = [
  { conversationId: 2, title: '遵义会议的意义', preview: '它发生在哪一年？', messageCount: 4, timeText: '刚刚' },
  { conversationId: 1, title: '飞夺泸定桥', preview: '红军如何夺取泸定桥？', messageCount: 6, timeText: '2小时前' }
];

async function shot(name, prepare, needRearm) {
  // 每状态独立连接：截图会让自动化桥退化，故一次连接只拍一张；后续状态先自愈重连
  if (needRearm) rearm();
  const mini = await automator.connect({ wsEndpoint: WS });
  await mini.evaluate(() => {
    const app = getApp();
    app.globalData.loggedIn = true;
    app.globalData.user = { id: 1, nickname: '渲染校验', avatar: '' };
  });
  await mini.reLaunch('/pages/ai-chat/ai-chat');
  await sleep(1200);
  const page = await mini.currentPage();
  await page.setData(prepare);
  await sleep(700);
  await mini.screenshot({ path: path.join(IMG, name) });
  console.log('shot -> ' + name);
  await mini.close();
  await sleep(800);
}

const STATES = {
  empty: { messages: [], title: '', banner: '' },
  conversation: { title: '遵义会议的意义', messages: CONV },
  drawer: { title: '遵义会议的意义', messages: CONV, showSessions: true, sessionsLoading: false, sessions: SESSIONS },
  banner: { messages: [], title: '', banner: 'AI 助手当前未开放，请稍后再试' }
};

(async () => {
  // 单状态单次运行：node ai-chat-shots.cjs <empty|conversation|drawer|banner>
  // 截图会让自动化桥退化，故每次调用只拍一张，状态间由外部 cli auto 自愈重连
  const which = process.argv[2] || 'empty';
  const prepare = STATES[which];
  if (!prepare) { console.log('unknown state: ' + which); process.exit(1); }
  await shot('ai-chat-' + which + '.png', prepare, false);
  process.exit(0);
})().catch((e) => { console.log('SHOTS ERR: ' + (e && e.message ? e.message : e)); process.exit(1); });
