/**
 * 底部 tab 换防验收：情报(quiz) 换为 AI 问答(ai-chat)
 * 覆盖：首页情报卡真 tap 以 navigateTo 进入 quiz 且可 navigateBack 回首页、
 *       5 tab 依次 switchTab 落页、ai-chat tab 页数据就绪、quiz 已非 tab（switchTab 应失败）。
 * 不依赖后端：登录态用 evaluate 注入；wx.request 全量 stub 成 fail，
 * 避免各页 onShow 拉接口 401 后静默重登失败 reLaunch 回启动页搅乱页面栈。
 * 顺序注意：march 页原生 map 层会使后续 tap 延迟数秒送达，故 tap 用例放在循环切 tab 之前；
 * switchTab 到非 tab 页被拒后桥状态受损，故负例放最后。
 * 用法（cwd 必须是本目录）：node ai-tab-swap.cjs
 */
const automator = require('miniprogram-automator');

const WS = 'ws://127.0.0.1:9420';
const results = [];
function rec(id, name, ok, detail) {
  results.push(ok);
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' ' + name + (detail ? ' | ' + detail : ''));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function curPath(mini) { return (await mini.currentPage()).path; }
// 模拟器 tap 事件送达可能延迟数秒（原生层预热），用轮询代替固定 sleep
async function waitPath(mini, want, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await curPath(mini)) === want) return true;
    await sleep(300);
  }
  return false;
}
async function inject(mini) {
  for (let i = 0; i < 8; i++) {
    try {
      const ok = await mini.evaluate(() => {
        const app = getApp();
        if (!app) return false;
        app.globalData.loggedIn = true;
        app.globalData.user = { id: 1, nickname: '换防验收', avatar: '' };
        wx.request = function (opt) {
          if (opt && typeof opt.fail === 'function') opt.fail({ errMsg: 'request:fail stubbed' });
          return { abort() {} };
        };
        return true;
      });
      if (ok) return;
    } catch (e) { /* app 未就绪，重试 */ }
    await sleep(1000);
  }
  throw new Error('注入登录态失败：app 长时间未就绪');
}

(async () => {
  const mini = await automator.connect({ wsEndpoint: WS });
  await inject(mini);

  // V1：首页情报卡真 tap 以 navigateTo 进 quiz，且可 navigateBack 回首页（干净状态先做，避开 march 原生层 tap 延迟）
  await mini.switchTab('/pages/home/home');
  await sleep(1200);
  const home = await mini.currentPage();
  const quizBtn = await home.$('.quiz-btn');
  rec('V1a', '首页情报卡按钮存在', !!quizBtn);
  if (quizBtn) await quizBtn.tap();
  const onQuiz = await waitPath(mini, 'pages/quiz/quiz', 8000);
  let backHome = false;
  if (onQuiz) {
    await mini.navigateBack();
    backHome = await waitPath(mini, 'pages/home/home', 4000);
  }
  rec('V1', '首页情报卡 tap 后 navigateTo quiz 且可返回', onQuiz && backHome, 'quiz=' + onQuiz + ' back=' + backHome);

  // V2：5 个 tab 依次 switchTab 均落对应页（含新 tab ai-chat）
  const tabs = [
    ['/pages/home/home', 'home'],
    ['/pages/march/march', 'march'],
    ['/pages/ai-chat/ai-chat', 'ai-chat'],
    ['/pages/rank/rank', 'rank'],
    ['/pages/mine/mine', 'mine']
  ];
  const landed = [];
  for (const [url, want] of tabs) {
    await mini.switchTab(url);
    await sleep(900);
    landed.push((await curPath(mini)) === 'pages/' + want + '/' + want ? want : 'MISS');
  }
  rec('V2', '5 tab 依次 switchTab 落页（含 AI 问答）', landed.every((p, i) => p === tabs[i][1]), landed.join(' → '));

  // V3：ai-chat tab 页数据就绪（常见问题 4 条、消息空）
  await mini.switchTab('/pages/ai-chat/ai-chat');
  await sleep(900);
  const d = await (await mini.currentPage()).data();
  rec('V3', 'ai-chat tab 页数据就绪', Array.isArray(d.messages) && d.commonQuestions.length === 4,
    'msgs=' + d.messages.length + ' common=' + d.commonQuestions.length);

  // V4：quiz 已非 tab，switchTab 应失败（拒后桥状态受损，故放最后）
  let switchErr = '';
  try {
    await mini.switchTab('/pages/quiz/quiz');
    await sleep(600);
  } catch (e) { switchErr = (e && e.message) || 'err'; }
  rec('V4', 'quiz 已非 tab（switchTab 被拒）', switchErr !== '' && (await curPath(mini)) !== 'pages/quiz/quiz', switchErr.slice(0, 60));

  const pass = results.filter(Boolean).length;
  console.log('\n合计 ' + results.length + ' 项：通过 ' + pass + '，失败 ' + (results.length - pass));
  await mini.close();
  process.exit(0);
})().catch((e) => {
  console.log('HARNESS ERR: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
