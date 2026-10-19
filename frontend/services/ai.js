/**
 * AI 历史助手服务：连续对话（一次性 / 流式逐字）、我的会话列表、会话详情、删除本人会话。
 *
 * 契约（camelCase，对应后端 /api/ai/*）：
 * - 会话归属一律由后端 JWT 判定，前端不传 user_id；读写他人会话后端按 404 处理。
 * - chat / chatStream 的 conversationId 为空表示新建会话，非空表示在该会话内追问（连续对话）。
 * - 403=AI 未开放、429=今日额度用尽、502=上游异常，均由 request.js 抛出带 message 的 Error。
 * - 流式走 /ai/chat/stream 的 SSE（start → delta* → done），前置校验失败仍是普通 JSON 状态码。
 */
const requestService = require('./request');

/** 组装提问请求体：conversationId 为空表示新建会话，nodeId 为节点上下文追问。 */
function chatPayload(message, conversationId, nodeId) {
  const data = { message };
  if (conversationId) data.conversationId = conversationId;
  if (nodeId) data.nodeId = nodeId;
  return data;
}

/** 把 handlers 包装成安全的 emit（未注册的回调直接忽略）。 */
function emitter(handlers) {
  const h = handlers || {};
  return (name, arg) => {
    if (typeof h[name] === 'function') h[name](arg);
  };
}

/**
 * 发送一条提问并获取回答（一次性返回，不支持逐字渲染的场合使用）。
 * @param {string} message 用户问题（1-500 字）
 * @param {number} [conversationId] 会话 ID，为空则新建会话
 * @param {number} [nodeId] 节点上下文（在节点讲解内追问时携带）
 * @returns {Promise<{conversationId:number, title:string, reply:string,
 *   sources:Array<{id:number,title:string,source:string,category:string}>, usedTokens:number|null}>}
 */
function chat(message, conversationId, nodeId) {
  return requestService.request({
    url: '/ai/chat',
    method: 'POST',
    data: chatPayload(message, conversationId, nodeId),
    timeout: 60000
  });
}

/**
 * 一次性 chat() 的流式适配：整段回答当作单个 delta 推出，使页面只有一条渲染路径。
 * abort 无法真正取消已发出的 HTTP 请求，只停止渲染（后端仍会落库，重进会话即可看到）。
 * @param {function(string, *):void} emit
 * @returns {{abort:function():void}}
 */
function plainChatStream(message, conversationId, nodeId, emit) {
  let aborted = false;
  chat(message, conversationId, nodeId)
    .then((res) => {
      if (aborted) return;
      const info = { conversationId: res.conversationId, title: res.title || '' };
      emit('onStart', info);
      emit('onDelta', res.reply || '');
      emit('onDone', Object.assign({}, info, {
        reply: res.reply || '',
        sources: res.sources || [],
        usedTokens: res.usedTokens === undefined ? null : res.usedTokens
      }));
    })
    .catch((err) => {
      if (!aborted) emit('onError', err);
    });
  return {
    abort() {
      aborted = true;
    }
  };
}

/**
 * 流式提问（逐字返回）：把后端 SSE 的 start / delta / done / error 映射为四个回调。
 *
 * 退化策略：基础库不支持分块传输、需要静默重登（401）、或一个增量都没收到就传输失败时，
 * 改走一次性 chat()——这三种情况都还没有内容推给用户，重发不会产生重复正文
 * （后端会把没推出任何增量的这次提问连同空会话一并清掉）。已推出增量后不再重试，
 * 只把错误交给页面提示，由用户决定停止或重问。
 *
 * @param {string} message 用户问题（1-500 字）
 * @param {number} [conversationId] 会话 ID，为空则新建会话
 * @param {number} [nodeId] 节点上下文（在节点讲解内追问时携带）
 * @param {{onStart?:function({conversationId:number,title:string}):void,
 *   onDelta?:function(string):void,
 *   onDone?:function({conversationId:number,title:string,reply:string,sources:Array,usedTokens:*}):void,
 *   onError?:function(Error):void}} handlers
 * @returns {{abort:function():void}} abort 停止接收与回调；后端自行收尾（已推部分会落库）
 */
function chatStream(message, conversationId, nodeId, handlers) {
  const emit = emitter(handlers);
  const data = chatPayload(message, conversationId, nodeId);
  if (!requestService.supportsChunked()) return plainChatStream(message, conversationId, nodeId, emit);

  let current = null;
  let startInfo = null;
  let gotDelta = false;
  let finished = false;

  current = requestService.requestStream(
    { url: '/ai/chat/stream', method: 'POST', data },
    (evt) => {
      // abort 之后可能还有已排队的分片到达，一律丢弃：页面此时已自行收尾，
      // 再推增量会把正文写到被替换掉的气泡位置
      if (finished) return;
      const type = evt && evt.type;
      if (type === 'start') {
        startInfo = { conversationId: evt.conversationId, title: evt.title || '' };
        emit('onStart', startInfo);
      } else if (type === 'delta') {
        gotDelta = true;
        emit('onDelta', evt.text || '');
      } else if (type === 'done') {
        finished = true;
        emit('onDone', Object.assign({}, startInfo, {
          reply: evt.reply || '',
          sources: evt.sources || [],
          usedTokens: evt.usedTokens === undefined ? null : evt.usedTokens
        }));
      } else if (type === 'error') {
        // 流已建立（状态码 200），上游故障只能作为事件下发，页面按普通失败提示
        finished = true;
        emit('onError', new Error(evt.message || 'AI 服务暂时不可用，请稍后重试'));
      }
    },
    (err) => {
      if (finished) return;
      finished = true;
      if (err && (err.statusCode === 401 || err.unsupported || (err.network && !gotDelta))) {
        current = plainChatStream(message, conversationId, nodeId, emit);
        return;
      }
      emit('onError', err || new Error('AI 服务暂时不可用，请稍后重试'));
    }
  );

  return {
    abort() {
      finished = true;
      if (current) current.abort();
    }
  };
}

/**
 * 我的会话列表（新到旧）。
 * @param {number} [page] 页码，默认 1
 * @param {number} [pageSize] 每页数量，默认 20
 * @returns {Promise<{total:number, items:Array<{conversationId:number,title:string,preview:string,
 *   messageCount:number,createdAt:string|null,updatedAt:string|null}>}>}
 */
function listConversations(page, pageSize) {
  return requestService.request({
    url: '/ai/conversations',
    data: { page: page || 1, pageSize: pageSize || 20 }
  });
}

/**
 * 会话详情（含历史消息）。
 * @param {number} conversationId
 * @returns {Promise<{conversationId:number,title:string,createdAt:string|null,updatedAt:string|null,
 *   messages:Array<{id:number,role:string,content:string,
 *     sources:Array<{id:number,title:string,source:string,category:string}>,createdAt:string|null}>}>}
 */
function getConversation(conversationId) {
  return requestService.request({ url: '/ai/conversations/' + conversationId });
}

/**
 * 删除本人会话（后端校验归属）。
 * @param {number} conversationId
 * @returns {Promise<{message:string}>}
 */
function deleteConversation(conversationId) {
  return requestService.request({
    url: '/ai/conversations/' + conversationId,
    method: 'DELETE'
  });
}

/**
 * 建议问题（B5）：按节点上下文返回引导提问。
 * @param {number} [nodeId] 节点 ID，携带则返回该节点相关建议问题
 * @returns {Promise<{items:Array<{text:string}>}>}
 */
function getSuggestedQuestions(nodeId) {
  const data = {};
  if (nodeId) data.nodeId = nodeId;
  return requestService.request({ url: '/ai/suggested-questions', data });
}

module.exports = {
  chat,
  chatStream,
  listConversations,
  getConversation,
  deleteConversation,
  getSuggestedQuestions
};
