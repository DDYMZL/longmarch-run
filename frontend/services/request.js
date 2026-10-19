const { API_BASE_URL } = require('./config');

const TOKEN_KEY = 'lm_auth_token';
const USER_KEY = 'lm_login_user';
const LAUNCH_PAGE = '/pages/launch/launch';
const ACTIVITY_PAGE = '/pages/activity/activity';
const ACTIVITY_REDIRECT_GAP_MS = 3000;

// 401 静默重登处理器，由 auth 模块注册（避免 request ↔ auth 循环依赖）
let reauthHandler = null;
let lastActivityRedirect = 0;

/** 获取本地 JWT。 */
function getToken() {
  try {
    return wx.getStorageSync(TOKEN_KEY) || '';
  } catch (e) {
    return '';
  }
}

/** 注册 401 时的重新登录函数（返回 Promise，成功即已写入新 Token）。 */
function setReauthHandler(fn) {
  reauthHandler = fn;
}

/** 清理失效登录态并回到启动页（由启动页重新自动登录或提示重试）。 */
function clearSession() {
  try {
    wx.removeStorageSync(TOKEN_KEY);
    wx.removeStorageSync(USER_KEY);
  } catch (e) {
    // Storage 清理失败时仍重置当前会话
  }
  // 清除 last-good 缓存，杜绝下一账号弱网兜底时读到上一账号数据
  clearAllCache();
  try {
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.user = null;
      app.globalData.loggedIn = false;
    }
    wx.reLaunch({ url: LAUNCH_PAGE });
  } catch (e) {
    // App 尚未初始化时仅清理持久化登录态
  }
}

/** 提取 FastAPI 错误信息。 */
function errorMessage(data, fallback) {
  if (data && typeof data.detail === 'string') return data.detail;
  if (data && Array.isArray(data.detail) && data.detail.length) {
    return data.detail.map((item) => item.msg || '').filter(Boolean).join('；') || fallback;
  }
  return fallback;
}

/** 构造带分类信息的错误：statusCode 为 HTTP 状态码，network 表示请求未到达后端。 */
function buildError(message, extra) {
  return Object.assign(new Error(message), extra);
}

/** 单次发送请求，不做 401 处理。 */
function send(opts) {
  const token = getToken();
  const header = Object.assign({ 'Content-Type': 'application/json' }, opts.header || {});
  if (token) header.Authorization = 'Bearer ' + token;

  return new Promise((resolve, reject) => {
    wx.request({
      url: API_BASE_URL + opts.url,
      method: opts.method || 'GET',
      data: opts.data,
      header: header,
      timeout: opts.timeout || 10000,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
          return;
        }
        const fallback = res.statusCode === 401 ? '登录已过期，请重新登录' : '请求失败';
        const err = buildError(errorMessage(res.data, fallback), { statusCode: res.statusCode });
        // 账号被停用：后端用响应头 X-Account-Status 标识（小写键兼容部分设备）
        const headers = res.header || {};
        const accountStatus = headers['X-Account-Status'] || headers['x-account-status'];
        if (res.statusCode === 403 && accountStatus === 'disabled') {
          err.admission = 'disabled';
        }
        // 活动时间拦截：X-Activity-Status 为 unpublished / not_started / ended
        const activityStatus = headers['X-Activity-Status'] || headers['x-activity-status'];
        if (res.statusCode === 403 && activityStatus) {
          err.activityStatus = activityStatus;
        }
        reject(err);
      },
      fail: (err) => {
        const raw = (err && err.errMsg) || '';
        const hint = /url not in domain list/i.test(raw)
          ? '请求域名未通过校验：请在公众平台把接口域名加入 request 合法域名（「不校验合法域名」对体验版/正式版无效）'
          : '网络连接失败：请检查手机网络，或确认后端服务可访问（本机联调需手机与电脑同一局域网）';
        // 附加原始 errMsg：真机看不了 console，只能靠它定位（如 request:fail url not in domain list）
        reject(buildError(raw ? hint + '｜' + raw : hint, { network: true, rawErrMsg: raw }));
      }
    });
  });
}

/**
 * 查看类请求（GET）被活动时间拦截 → 不可查看，统一跳活动状态页（并发请求只跳一次）；
 * 参与类请求（POST 等）只抛错，由页面提示 err.message。
 */
function redirectActivityClosed() {
  const now = Date.now();
  if (now - lastActivityRedirect < ACTIVITY_REDIRECT_GAP_MS) return;
  lastActivityRedirect = now;
  try {
    wx.reLaunch({ url: ACTIVITY_PAGE });
  } catch (e) {
    // App 尚未初始化时由启动页查询活动状态后跳转
  }
}

/**
 * 发起后端请求并统一附加 JWT。
 * 401 时静默重新登录并重试一次；重登或重试仍失败则清登录态回启动页。
 * skipAuthRetry：登录相关请求自行处理 401，不触发重登与跳转。
 * skipActivityRedirect：活动拦截时不自动跳转活动状态页。
 * @param {{url:string, method?:string, data?:object, header?:object, timeout?:number, skipAuthRetry?:boolean, skipActivityRedirect?:boolean}} options
 * @returns {Promise<any>}
 */
function request(options) {
  const opts = options || {};
  const method = (opts.method || 'GET').toUpperCase();
  const useCache = method === 'GET' && !opts.skipCache && isCachePath(opts.url);

  return send(opts).then(
    (data) => {
      // 核心 GET 成功：写入 last-good 缓存
      if (useCache) writeCache(opts.url, data);
      return data;
    },
    (err) => {
      // 核心 GET 网络失败：尝试读缓存兜底（附加 _fromCache 标记供调用方提示）
      if (useCache && err.network) {
        const cached = readCache(opts.url);
        if (cached !== null) {
          const patched = Object.assign({}, cached, { _fromCache: true });
          return Promise.resolve(patched);
        }
      }
      throw err;
    }
  ).catch((err) => {
    if (err.activityStatus) {
      const isView = (opts.method || 'GET').toUpperCase() === 'GET';
      if (isView && !opts.skipActivityRedirect) redirectActivityClosed();
      throw err;
    }
    // 账号停用：清登录态并回启动页由其显示准入拦截，不再做静默重登
    if (err.admission === 'disabled') {
      if (!opts.skipAuthRetry) clearSession();
      throw err;
    }
    if (err.statusCode !== 401 || opts.skipAuthRetry) throw err;
    if (!reauthHandler) {
      clearSession();
      throw err;
    }
    return reauthHandler().then(
      () =>
        send(opts).catch((retryErr) => {
          if (retryErr.statusCode === 401) clearSession();
          throw retryErr;
        }),
      (loginErr) => {
        // 网络异常保留现场由页面提示重试；其余重登失败回启动页
        if (!loginErr.network) clearSession();
        throw loginErr;
      }
    );
  });
}

// ---------------- 流式请求（SSE） ----------------
// 流式回答逐片到达可达数十秒，固定的 10s/60s 超时会误杀正常生成，这里给一个宽松的整体上限
const STREAM_TIMEOUT_MS = 120000;
// UTF-8 各码元长度对应的首字节有效位掩码（1/2/3/4 字节 → 7/5/4/3 位）
const UTF8_MASKS = [0x7f, 0x1f, 0x0f, 0x07];

/**
 * 增量 UTF-8 解码器：小程序运行时没有 TextDecoder，而多字节汉字常被切在分片边界上，
 * 逐片直接转字符串会出乱码。按首字节判定码元长度，尾部不完整的字节留到下一片再解；
 * 游离续字节与非法起始字节直接跳过（丢一个字符好过整条流崩掉）。
 */
function createUtf8Decoder() {
  let rest = new Uint8Array(0);

  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  return {
    /**
     * @param {ArrayBuffer} chunk 本次收到的字节
     * @returns {string} 本片能完整解出的文本
     */
    decode(chunk) {
      const bytes = concat(rest, new Uint8Array(chunk || new ArrayBuffer(0)));
      let text = '';
      let i = 0;
      while (i < bytes.length) {
        const b = bytes[i];
        if ((b >= 0x80 && b < 0xc0) || b >= 0xf8) {
          i += 1;
          continue;
        }
        let len = 1;
        if (b >= 0xf0) len = 4;
        else if (b >= 0xe0) len = 3;
        else if (b >= 0xc0) len = 2;
        if (i + len > bytes.length) break; // 尾部不完整，等下一片
        let cp = b & UTF8_MASKS[len - 1];
        for (let k = 1; k < len; k += 1) cp = (cp << 6) | (bytes[i + k] & 0x3f);
        // 超出 BMP 的码点（emoji 等）需手工组代理对，避免依赖 String.fromCodePoint
        text += cp > 0xffff
          ? String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff))
          : String.fromCharCode(cp);
        i += len;
      }
      rest = bytes.slice(i);
      return text;
    }
  };
}

/**
 * SSE 分帧：按空行切事件块，块内取 data: 行的 JSON。
 * 容忍 \r\n 换行；单个坏块只跳过（少几个字），中断整条流会让已显示的半截回答失去下文。
 * @param {function(object):void} onEvent
 */
function createSseParser(onEvent) {
  let buffer = '';

  function emit(block) {
    block.split('\n').forEach((line) => {
      if (line.indexOf('data:') !== 0) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let evt = null;
      try {
        evt = JSON.parse(payload);
      } catch (e) {
        return; // 坏块跳过；业务回调抛错不在此吞掉
      }
      onEvent(evt);
    });
  }

  return {
    feed(text) {
      buffer += text.replace(/\r\n/g, '\n');
      let idx = buffer.indexOf('\n\n');
      while (idx >= 0) {
        emit(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf('\n\n');
      }
    },
    /** 响应结束时把最后不足一个空行的残留块也吐出去 */
    flush() {
      if (buffer.trim()) emit(buffer);
      buffer = '';
    }
  };
}

/** 当前基础库是否支持分块传输（enableChunked 需 2.20.2 及以上）。 */
function supportsChunked() {
  try {
    return !!wx.canIUse('request.object.enableChunked');
  } catch (e) {
    return false;
  }
}

/**
 * 流式请求：只负责传输与分帧（字节流 → UTF-8 增量解码 → SSE 事件对象），不含业务语义。
 * 非 2xx 时把响应体当 FastAPI JSON 错误解析，错误语义与 request() 一致（statusCode + message）；
 * 401 不在此处静默重登——增量可能已推给用户，重放会导致正文重复，由调用方决定是否退化。
 * abort() 之后不再触发任何回调，收尾由调用方自行处理。
 * @param {{url:string, method?:string, data?:object, header?:object, timeout?:number}} opts
 * @param {function(object):void} onEvent 每收到一个 SSE 事件对象
 * @param {function(Error|null):void} onEnd 终止回调，null 表示 HTTP 层正常结束
 * @returns {{abort:function():void}}
 */
function requestStream(opts, onEvent, onEnd) {
  const token = getToken();
  const header = Object.assign(
    { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    opts.header || {}
  );
  if (token) header.Authorization = 'Bearer ' + token;

  const decoder = createUtf8Decoder();
  // 只在收到第一个 SSE 事件前累积原文：非 2xx 的 JSON 错误体需要它，成功流则不必留住整段正文
  let rawText = '';
  let sawEvent = false;
  let ended = false;
  const parser = createSseParser((evt) => {
    sawEvent = true;
    onEvent(evt);
  });

  function finish(err) {
    if (ended) return;
    ended = true;
    onEnd(err || null);
  }

  const task = wx.request({
    url: API_BASE_URL + opts.url,
    method: (opts.method || 'POST').toUpperCase(),
    data: opts.data,
    header: header,
    enableChunked: true,
    timeout: opts.timeout === undefined ? STREAM_TIMEOUT_MS : opts.timeout,
    success: (res) => {
      parser.flush();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        finish(null);
        return;
      }
      const fallback = res.statusCode === 401 ? '登录已过期，请重新登录' : '请求失败';
      let data = res.data;
      if (typeof data !== 'object' || data === null) {
        try {
          data = JSON.parse(rawText);
        } catch (e) {
          data = null;
        }
      }
      finish(buildError(errorMessage(data, fallback), { statusCode: res.statusCode }));
    },
    fail: (err) => {
      const raw = (err && err.errMsg) || '';
      const hint = /url not in domain list/i.test(raw)
        ? '请求域名未通过校验：请在公众平台把接口域名加入 request 合法域名'
        : '网络连接失败：请检查手机网络，或确认后端服务可访问';
      finish(buildError(raw ? hint + '｜' + raw : hint, { network: true, rawErrMsg: raw }));
    }
  });

  if (!task || typeof task.onChunkReceived !== 'function') {
    // canIUse 与实际能力不一致时（个别机型/模拟器）中止请求，由调用方退化为一次性返回。
    // 先置 ended 屏蔽 abort 引发的 fail 回调，否则 onEnd 会把「不支持」误报成「网络失败」
    ended = true;
    if (task && typeof task.abort === 'function') {
      try {
        task.abort();
      } catch (e) {
        // 中止失败也继续走退化
      }
    }
    onEnd(buildError('当前微信版本不支持流式返回', { unsupported: true }));
    return {
      abort() {}
    };
  }

  task.onChunkReceived((res) => {
    const text = decoder.decode(res && res.data);
    if (!text) return;
    if (!sawEvent) rawText += text;
    parser.feed(text);
  });

  return {
    abort() {
      ended = true;
      try {
        task.abort();
      } catch (e) {
        // 已结束的任务重复 abort 无需处理
      }
    }
  };
}

/**
 * 文件上传（wx.uploadFile）：不设 Content-Type（由微信自动拼 multipart boundary），
 * 复用 Authorization 头与错误分类。
 * @param {string} url   相对路径（如 /auth/avatar）
 * @param {string} filePath  本地临时文件路径
 * @returns {Promise<any>}   解析后的 JSON 响应
 */
function uploadFile(url, filePath) {
  const token = getToken();
  const header = {};
  if (token) header.Authorization = 'Bearer ' + token;

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: API_BASE_URL + url,
      filePath: filePath,
      name: 'file',
      header: header,
      timeout: 15000,
      success: (res) => {
        let data = null;
        try { data = JSON.parse(res.data); } catch (e) { /* 非 JSON 响应 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
          return;
        }
        const fallback = res.statusCode === 401 ? '登录已过期，请重新登录' : '上传失败';
        reject(buildError(errorMessage(data, fallback), { statusCode: res.statusCode }));
      },
      fail: (err) => {
        const raw = (err && err.errMsg) || '';
        reject(buildError(raw ? '文件上传失败｜' + raw : '文件上传失败，请检查网络', { network: true, rawErrMsg: raw }));
      }
    });
  });
}

/**
 * 需要"last-good 缓存"的核心 GET 接口白名单（仅对这些路径写 Storage）。
 * 缓存键前缀 lm_cache_ 且按用户隔离，网络失败时回读并附加 fromCache 标记。
 */
const CACHE_PATHS = ['/march/route', '/sport/today', '/medal/list'];
const CACHE_PREFIX = 'lm_cache_';

/** 判断某请求路径是否应使用 last-good 缓存 */
function isCachePath(url) {
  if (!url) return false;
  const path = url.split('?')[0];
  return CACHE_PATHS.indexOf(path) >= 0;
}

/** 当前登录用户 ID（缓存隔离标识）；未登录返回 ''。 */
function currentUserId() {
  try {
    const u = wx.getStorageSync(USER_KEY);
    return u && u.id !== undefined && u.id !== null ? String(u.id) : '';
  } catch (e) {
    return '';
  }
}

/** 缓存键：lm_cache_{userId}_{path去掉斜杠}，按用户隔离，杜绝跨账号脏读。 */
function cacheKey(url) {
  const uid = currentUserId() || 'anon';
  return CACHE_PREFIX + uid + '_' + url.split('?')[0].replace(/\//g, '_').replace(/^_/, '');
}

/** 写入 last-good 缓存（记录 ownerId 供读取时二次校验；未登录或 Storage 满时静默忽略）。 */
function writeCache(url, data) {
  const uid = currentUserId();
  if (!uid) return; // 未登录不缓存鉴权数据
  try {
    wx.setStorageSync(cacheKey(url), { ownerId: uid, data: data });
  } catch (e) { /* 静默 */ }
}

/**
 * 读取 last-good 缓存：校验 ownerId 与当前登录用户一致，不一致（含旧格式无 ownerId）则丢弃。
 * @returns {any|null} 缓存数据；无缓存或不属于当前用户时返回 null
 */
function readCache(url) {
  const uid = currentUserId();
  if (!uid) return null;
  try {
    const entry = wx.getStorageSync(cacheKey(url));
    if (!entry || entry.ownerId !== uid) return null;
    return entry.data !== undefined ? entry.data : null;
  } catch (e) {
    return null;
  }
}

/** 清除所有 last-good 缓存项（切换账号 / 登出 / 会话失效时调用）。 */
function clearAllCache() {
  try {
    const keys = wx.getStorageInfoSync().keys || [];
    keys.forEach((k) => {
      if (typeof k === 'string' && k.indexOf(CACHE_PREFIX) === 0) {
        try { wx.removeStorageSync(k); } catch (e) { /* 单项失败忽略 */ }
      }
    });
  } catch (e) {
    // 无法枚举时退化不清理；读取端 ownerId 校验仍可兜底防脏读
  }
}

module.exports = {
  TOKEN_KEY,
  getToken,
  setReauthHandler,
  request,
  requestStream,
  supportsChunked,
  uploadFile,
  isCachePath,
  writeCache,
  readCache,
  clearAllCache
};
