/**
 * 启动自动登录 / 401 静默重登状态机校验（Node 直跑，模拟 wx 与后端，无需开发者工具）。
 * 运行：node test/auth-flow-check.cjs
 */
const path = require('path');

const SERVICES = path.join(__dirname, '..', 'services');

/** 构造一套隔离环境：内存 Storage + 可编程后端 + 计数器。 */
function setup(opts) {
  const o = opts || {};
  const storage = Object.assign({}, o.storage || {});
  const app = { globalData: { user: null, loggedIn: false } };
  const backend = {
    users: { 'openid-1': { id: 1, nickname: '长征小战士', avatar: '', orgId: 7 } },
    validTokens: new Set(o.validTokens || []),
    loginCalls: 0,
    wxLoginCalls: 0,
    meCalls: 0,
    network: !!o.network,
    wxLoginFail: !!o.wxLoginFail,
    loginStatus: o.loginStatus || 200,
    requests: []
  };
  let seq = 0;

  global.getApp = () => app;
  global.wx = {
    getSystemInfoSync: () => ({ platform: 'devtools' }),
    getStorageSync: (k) => (k in storage ? storage[k] : ''),
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: (k) => { delete storage[k]; },
    reLaunch: (r) => { backend.reLaunched = r.url; },
    login: (cb) => {
      backend.wxLoginCalls += 1;
      setTimeout(() => (backend.wxLoginFail ? cb.fail({ errMsg: 'login:fail' }) : cb.success({ code: 'code-' + backend.wxLoginCalls })), 5);
    },
    request: (cfg) => {
      setTimeout(() => {
        if (backend.network) return cfg.fail({ errMsg: 'request:fail timeout' });
        const auth = (cfg.header.Authorization || '').replace('Bearer ', '');
        const route = cfg.url.replace(/^.*\/api/, '');
        backend.requests.push(route);
        if (route === '/auth/login') {
          backend.loginCalls += 1;
          if (backend.loginStatus !== 200) return cfg.success({ statusCode: backend.loginStatus, data: { detail: '微信登录失败，请重试' } });
          seq += 1;
          const token = 'tok-' + seq;
          backend.validTokens.add(token);
          return cfg.success({ statusCode: 200, data: { token: token, user: backend.users['openid-1'] } });
        }
        if (!backend.validTokens.has(auth)) return cfg.success({ statusCode: 401, data: { detail: '登录已过期' } });
        if (route === '/auth/me') backend.meCalls += 1;
        cfg.success({ statusCode: 200, data: route === '/auth/me' ? backend.users['openid-1'] : { ok: true, route: route } });
      }, 5);
    },
    getFileSystemManager: () => ({ saveFile: (x) => x.success({ savedFilePath: x.tempFilePath }) }),
    env: { USER_DATA_PATH: 'wxfile://usr' }
  };
  Object.keys(require.cache).forEach((k) => { if (k.startsWith(SERVICES)) delete require.cache[k]; });
  const auth = require(path.join(SERVICES, 'auth.js'));
  const request = require(path.join(SERVICES, 'request.js'));
  return { storage, app, backend, auth, request };
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail });
    console.log('PASS', name, detail ? '| ' + detail : '');
  } catch (e) {
    results.push({ name, pass: false, detail: e.message });
    console.log('FAIL', name, '|', e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  await check('A1 首次进入无 Token：静默 wx.login 登录并写入 Token', async () => {
    const env = setup();
    const user = await env.auth.ensureLogin();
    assert(user.id === 1 && env.storage.lm_auth_token === 'tok-1', 'token 未写入');
    assert(env.app.globalData.loggedIn === true, '全局未登录');
    return 'wx.login=' + env.backend.wxLoginCalls + ' login=' + env.backend.loginCalls;
  });

  await check('A2 有效 Token：仅调 /auth/me 校验，不重新登录', async () => {
    const env = setup({ storage: { lm_auth_token: 'tok-ok', lm_login_user: { id: 1, orgId: 7, orgFullName: '集团/一部' } }, validTokens: ['tok-ok'] });
    const user = await env.auth.ensureLogin();
    assert(env.backend.meCalls === 1 && env.backend.loginCalls === 0, '不应重登');
    assert(user.orgFullName === '集团/一部', '同组织应保留组织显示名');
    assert(env.app.globalData.loggedIn, '全局未登录');
    return 'me=1 login=0 orgFullName 保留';
  });

  await check('A3 过期 Token：/auth/me 401 → 自动重登换新 Token（同一用户）', async () => {
    const env = setup({ storage: { lm_auth_token: 'tok-expired', lm_login_user: { id: 1, orgId: 7 } } });
    const user = await env.auth.ensureLogin();
    assert(user.id === 1 && env.storage.lm_auth_token === 'tok-1', '未换新 Token');
    assert(!env.backend.reLaunched, '启动校验阶段不应跳转');
    return 'newToken=' + env.storage.lm_auth_token;
  });

  await check('A4 wx.login 失败：拒绝且不进入假登录态', async () => {
    const env = setup({ wxLoginFail: true });
    let err = null;
    await env.auth.ensureLogin().catch((e) => { err = e; });
    assert(err && !env.app.globalData.loggedIn && !env.storage.lm_auth_token, '不应登录');
    return err.message;
  });

  await check('A5 后端换取失败（502）：拒绝且不进入假登录态', async () => {
    const env = setup({ loginStatus: 502 });
    let err = null;
    await env.auth.ensureLogin().catch((e) => { err = e; });
    assert(err && err.statusCode === 502 && !env.app.globalData.loggedIn && !env.storage.lm_auth_token, '不应登录');
    return err.message;
  });

  await check('A6 网络异常：抛出 network 错误，保留本地 Token 供重试，不视为已登录', async () => {
    const env = setup({ network: true, storage: { lm_auth_token: 'tok-ok', lm_login_user: { id: 1 } }, validTokens: ['tok-ok'] });
    let err = null;
    await env.auth.ensureLogin().catch((e) => { err = e; });
    assert(err && err.network, '应为网络错误');
    assert(env.storage.lm_auth_token === 'tok-ok' && !env.app.globalData.loggedIn, 'Token 应保留且未登录');
    env.backend.network = false;
    const user = await env.auth.ensureLogin();
    assert(user.id === 1 && env.app.globalData.loggedIn, '重试应成功');
    return '重试后登录成功';
  });

  await check('A7 业务请求 401：静默重登并重试原请求一次（并发 5 个请求只登录一次）', async () => {
    const env = setup({ storage: { lm_auth_token: 'tok-expired', lm_login_user: { id: 1 } } });
    const out = await Promise.all([1, 2, 3, 4, 5].map((i) => env.request.request({ url: '/sport/today?i=' + i })));
    assert(out.every((r) => r.ok), '重试应成功');
    assert(env.backend.wxLoginCalls === 1 && env.backend.loginCalls === 1, '应只登录一次，实际 ' + env.backend.loginCalls);
    assert(!env.backend.reLaunched, '成功重登不应跳转');
    return 'login=' + env.backend.loginCalls;
  });

  await check('A8 401 后重登失败：清登录态回启动页', async () => {
    const env = setup({ loginStatus: 502, storage: { lm_auth_token: 'tok-expired', lm_login_user: { id: 1 } } });
    let err = null;
    await env.request.request({ url: '/sport/today' }).catch((e) => { err = e; });
    assert(err && env.backend.reLaunched === '/pages/launch/launch' && !env.storage.lm_auth_token, '应回启动页');
    return env.backend.reLaunched;
  });

  await check('A9 并发 ensureLogin（启动页与重试按钮同时触发）只登录一次', async () => {
    const env = setup();
    await Promise.all([env.auth.ensureLogin(), env.auth.ensureLogin(), env.auth.ensureLogin()]);
    assert(env.backend.loginCalls === 1, 'login=' + env.backend.loginCalls);
    return 'login=1';
  });

  await check('A10 主动退出后不再静默登录；登录页手动登录后恢复', async () => {
    const env = setup({ storage: { lm_auth_token: 'tok-ok', lm_login_user: { id: 1 } }, validTokens: ['tok-ok'] });
    env.auth.clearLocalUser();
    let err = null;
    await env.auth.ensureLogin().catch((e) => { err = e; });
    assert(err && err.loggedOut && env.backend.wxLoginCalls === 0, '退出后不应静默登录');
    await env.auth.wxLogin({});
    const user = await env.auth.ensureLogin();
    assert(user.id === 1 && env.app.globalData.loggedIn, '手动登录后应恢复');
    return 'loggedOut 拦截，手动登录后恢复';
  });

  await check('A11 组织变更后丢弃旧组织显示名', async () => {
    const env = setup({ storage: { lm_auth_token: 'tok-ok', lm_login_user: { id: 1, orgId: 3, orgFullName: '旧组织' } }, validTokens: ['tok-ok'] });
    const user = await env.auth.ensureLogin();
    assert(user.orgId === 7 && !user.orgFullName, '应丢弃旧组织名');
    return 'orgId=7 orgFullName 清空';
  });

  const passed = results.filter((r) => r.pass).length;
  console.log('\n== 小程序登录状态机: ' + passed + '/' + results.length + ' 通过 ==');
  require('fs').writeFileSync(path.join(__dirname, 'auth-flow-results.json'), JSON.stringify(results, null, 2));
  process.exit(passed === results.length ? 0 : 1);
})();
