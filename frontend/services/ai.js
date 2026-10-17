/**
 * AI 历史助手服务：连续对话、我的会话列表、会话详情、删除本人会话。
 *
 * 契约（camelCase，对应后端 /api/ai/*）：
 * - 会话归属一律由后端 JWT 判定，前端不传 user_id；读写他人会话后端按 404 处理。
 * - chat 的 conversationId 为空表示新建会话，非空表示在该会话内追问（连续对话）。
 * - 403=AI 未开放、429=今日额度用尽、502=上游异常，均由 request.js 抛出带 message 的 Error。
 */
const requestService = require('./request');

/**
 * 发送一条提问并获取回答。
 * @param {string} message 用户问题（1-500 字）
 * @param {number} [conversationId] 会话 ID，为空则新建会话
 * @param {number} [nodeId] 节点上下文（在节点讲解内追问时携带）
 * @returns {Promise<{conversationId:number, title:string, reply:string,
 *   sources:Array<{id:number,title:string,source:string,category:string}>, usedTokens:number|null}>}
 */
function chat(message, conversationId, nodeId) {
  const data = { message };
  if (conversationId) data.conversationId = conversationId;
  if (nodeId) data.nodeId = nodeId;
  return requestService.request({ url: '/ai/chat', method: 'POST', data, timeout: 60000 });
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

module.exports = {
  chat,
  listConversations,
  getConversation,
  deleteConversation
};
