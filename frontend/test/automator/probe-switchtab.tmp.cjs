/** 探针：freshLogin 后 switchTab mine 的状态排查（一次性，用完即弃） */
const automator = require('miniprogram-automator');
process.on('unhandledRejection', () => {});
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  const p0 = await mini.currentPage();
  console.log('当前页:', p0 && p0.path, 'query:', JSON.stringify(p0 && p0.query));
  try {
    const r = await mini.switchTab('/pages/mine/mine');
    console.log('switchTab 返回:', r && r.path ? r.path : JSON.stringify(r));
  } catch (e) {
    console.log('switchTab 异常:', e && e.message);
  }
  await sleep(3000);
  const p1 = await mini.currentPage().catch((e) => ({ err: e.message }));
  console.log('3s 后页:', p1 && p1.path, p1 && p1.err || '');
  if (p1 && p1.path) {
    const data = await p1.data().catch(() => null);
    console.log('data keys:', data ? Object.keys(data).slice(0, 12).join(',') : 'null');
    console.log('loggedIn 相关:', JSON.stringify({ user: data && data.user ? 'has' : data && data.user }));
  }
  try { await mini.disconnect(); } catch (e) {}
  process.exit(0);
}
setTimeout(() => process.exit(3), 90000);
main().catch((e) => { console.error('探针失败:', e && e.message); process.exit(2); });
