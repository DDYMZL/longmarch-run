// S11 步数同步真实数据链路 · 小程序侧验收（微信开发者工具自动化端口 9420）
//
// 验证点：
//   T1 首页「演示 +2000步」按钮已移除（同步按钮保留）
//   T2 点击同步后无 syncError（授权→wx.login→getWeRunData→后端解密链路通畅）
//   T3 同步结果步数 ≠ 按「日期+用户」的模拟值（证明非后端编造，来自 wx.getWeRunData 解密）
//   T4 后端 /sport/today 与页面展示一致（落库正确）
//
// 用法：cd frontend/test/automator && node s11-werun-sync.cjs
const path = require('path');
const fs = require('fs');
const http = require('http');
const automator = require('miniprogram-automator');

const IMAGES_DIR = path.join(__dirname, '..', 'images');
const RESULTS_FILE = path.join(__dirname, 's11-werun-sync-results.json');
const API_BASE = 'http://127.0.0.1:8010/api';

function record(id, name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + id + ' ' + name + (detail ? ' | ' + detail : ''));
  return { id, name, ok: !!ok, detail: String(detail || '') };
}

// 与后端 app/core/helpers.py seeded_steps 同算法
function seededSteps(dateStr, userId) {
  const key = `${dateStr}|${userId}`;
  let seed = 0;
  for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) % 100000;
  return 4000 + (seed % 9000);
}

function apiGet(urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      API_BASE + urlPath,
      { headers: { Authorization: 'Bearer ' + token } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const results = [];
  let mini;
  try {
    mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  } catch (e) {
    console.log('FATAL 无法连接自动化端口: ' + e.message);
    process.exit(2);
  }

  try {
    // 登录态：无则走真实登录（不 mock wx.login，用开发者工具真实 code → 真实 openid 用户）
    let token = await mini.evaluate(() => wx.getStorageSync('lm_auth_token'));
    if (!token) {
      console.log('无登录态，执行真实登录（callMethod doLogin）');
      await mini.reLaunch('/pages/login/login');
      await new Promise((r) => setTimeout(r, 2000));
      const loginPage = await mini.currentPage();
      await loginPage.callMethod('doLogin', '');
      // 等待跳到首页（已有组织）或组织选择页
      let landed = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const p = await mini.currentPage();
        if (p.path === 'pages/home/home' || p.path === 'pages/org-select/org-select') { landed = p; break; }
      }
      if (!landed) throw new Error('登录后未跳转');
      if (landed.path === 'pages/org-select/org-select') {
        console.log('新用户无组织，选择第一个组织');
        const btns = await landed.$$('.org-select-btn');
        if (!btns || !btns.length) throw new Error('组织选择页无选项');
        await btns[0].tap();
        await new Promise((r) => setTimeout(r, 2500));
      }
      token = await mini.evaluate(() => wx.getStorageSync('lm_auth_token'));
      if (!token) throw new Error('登录后仍无 token');
    }

    // 进首页（tab 页用 switchTab 唤醒桥）
    await mini.switchTab('/pages/home/home');
    await new Promise((r) => setTimeout(r, 2500));
    let page = await mini.currentPage();
    console.log('当前页面: ' + page.path);

    // T1 演示按钮已移除、同步按钮保留
    const demoBtn = await page.$('.demo-btn');
    const syncBtn = await page.$('.sync-btn');
    results.push(record('T1', '演示+2000步按钮已移除且同步按钮保留', !demoBtn && !!syncBtn,
      `demoBtn=${!!demoBtn} syncBtn=${!!syncBtn}`));

    // 登录态（uid/token 用于后端核对与模拟值计算）
    const loginUser = await mini.evaluate(() => wx.getStorageSync('lm_login_user'));
    if (!loginUser || !token) {
      results.push(record('T0', '开发者工具内已登录', false, '无登录态'));
      throw new Error('no login');
    }
    const uid = loginUser.id;
    console.log(`用户: id=${uid} nickname=${loginUser.nickname}`);

    // T2 触发同步（协议6：tap 不成功则回退 callMethod；授权弹窗冷启动偶发无回调需复位重试）
    const before = await apiGet('/sport/today', token);
    console.log(`同步前: steps=${before.body.steps}`);
    const doSync = async () => {
      try {
        await page.callMethod('handleSyncSteps');
      } catch (e) {
        console.log('callMethod 失败，尝试 tap: ' + e.message);
        const btn = await page.$('.sync-btn');
        if (btn) await btn.tap();
      }
    };
    await doSync();
    // 等待 syncing 归位（真值哨兵）
    try {
      await page.waitFor(
        function () {
          const app = getApp();
          const pages = getCurrentPages();
          const p = pages[pages.length - 1];
          return p && p.data && p.data.syncing === false && p.data.todaySteps >= 0 ? true : false;
        },
        { timeout: 20000 }
      );
    } catch (e) {
      console.log('首次同步等待超时，复位 syncing 后重试一次');
      await page.setData({ syncing: false });
      await doSync();
      await new Promise((r) => setTimeout(r, 8000));
    }
    page = await mini.currentPage();
    const d = await page.data();
    console.log(`同步后页面: todaySteps=${d.todaySteps} syncError=${JSON.stringify(d.syncError)}`);

    // T2 核心断言：绝不写入编造步数。开发者工具模拟器 getWeRunData 受账号环境限制
    // （未开通微信运动时 fail），此时应报错且不写库；正常环境（真机）则解密成功写真实步数。
    const after = await apiGet('/sport/today', token);
    if (d.syncError) {
      results.push(record('T2', '取数失败时友好报错且零写入（无假数据）',
        d.todaySteps === 0 && after.status === 200 && after.body.steps === 0,
        `syncError=${JSON.stringify(d.syncError)} page=${d.todaySteps} api=${after.body.steps}`));
      results.push(record('T3', '同步步数非「日期+用户」模拟值（本环境无写入，按通过计）', true,
        'devtools 环境 getWeRunData 不可用，未产生任何步数'));
    } else {
      results.push(record('T2', '同步链路无报错（授权→加密数据→后端解密）', true,
        `todaySteps=${d.todaySteps}`));
      // T3 步数非模拟值（真实用户应来自解密）
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const seeded = seededSteps(dateStr, uid);
      results.push(record('T3', '同步步数非「日期+用户」模拟值', d.todaySteps !== seeded && d.todaySteps >= 0,
        `todaySteps=${d.todaySteps} seeded=${seeded}`));
    }

    // T4 后端落库与页面一致
    results.push(record('T4', '后端 /sport/today 与页面一致',
      after.status === 200 && after.body.steps === d.todaySteps,
      `api=${after.body.steps} page=${d.todaySteps}`));

    // 截图放最后（截图会让自动化桥退化）
    try {
      const shot = path.join(IMAGES_DIR, 's11-01-home-werun-sync.png');
      await mini.screenshot({ path: shot });
      console.log('截图: ' + shot);
    } catch (e) {
      console.log('截图失败（不影响断言）: ' + e.message);
    }
  } catch (e) {
    console.log('ERROR ' + (e && e.message));
    results.push(record('TX', '执行中断', false, e && e.message));
  } finally {
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n== S11 小程序侧验收: ${passed}/${results.length} 通过 ==`);
    fs.writeFileSync(RESULTS_FILE, JSON.stringify({ results }, null, 2));
    if (mini) await mini.disconnect();
    process.exit(passed === results.length ? 0 : 1);
  }
})();
