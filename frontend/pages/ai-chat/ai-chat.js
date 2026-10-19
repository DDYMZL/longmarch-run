/**
 * AI 历史助手（长征历史问答）
 * - 连续对话：conversationId 为空新建会话，追问沿用同一会话（后端注入历史上下文）；
 * - 逐字输出：走 SSE 流式接口，增量先进字符队列再由定时器批量渲染（模型常整段吐出，
 *   直接 setData 会一跳一大段），生成中显示光标并可随时「停止」；
 * - 会话管理：右上「会话」抽屉查看/切换/删除本人会话（归属由后端 JWT 判定）；
 * - 状态：加载动画、失败重试、空状态常见问题、AI 未开放(403)/额度用尽(429)/上游异常(502) 明确提示；
 * - 来源：回答下方展示后端核验过的已发布知识资料。
 * 登录守卫：非 tab 页，onShow 自行校验 loggedIn，未登录回启动页。
 */
const app = getApp();
const ai = require('../../services/ai');
const march = require('../../services/march');
const util = require('../../utils/util');

// 建议问题接口失败时的兜底文案
const COMMON_QUESTIONS = [
  '红军长征是从什么时候开始的？',
  '遵义会议有什么历史意义？',
  '红军长征翻越了哪些雪山？',
  '飞夺泸定桥是怎么回事？'
];

const SESSION_PAGE_SIZE = 20;

// 打字机节奏：每 TYPE_TICK_MS 渲染一批字符。批量大小按队列长度自适应——
// 队列越长说明模型吐得越快，取多一点追上进度；队列短时一次一两个字，保留逐字观感。
const TYPE_TICK_MS = 45;
const TYPE_MAX_PER_TICK = 12;
// 生成中跟随滚动的最小间隔：逐字渲染每 tick 都触发 setData，滚动再跟着刷会翻倍开销
const SCROLL_GAP_MS = 300;
// 底部锚点：scroll-into-view 值不变不会重复触发，故先清空再定位
const BOTTOM_ANCHOR = 'ai-bottom';

let _seq = 0;

/** 给最后一个块打标记，供 WXML 在正文末尾接上闪烁光标。 */
function markLast(blocks) {
  if (blocks.length) blocks[blocks.length - 1].last = true;
  return blocks;
}

/** 把最后一条用户气泡标记为失败（供「点击重试」定位到该条提问）。 */
function markLastUserFailed(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      msgs[i] = Object.assign({}, msgs[i], { failed: true });
      return;
    }
  }
}

Page({
  data: {
    messages: [],
    conversationId: null,
    title: '',
    inputText: '',
    // 请求进行中（含逐字生成）：此状态下发送按钮变为「停止」，并禁止切会话/新建/重发
    sending: false,
    toView: '',
    commonQuestions: COMMON_QUESTIONS,
    // 节点上下文（B5）：从节点详情「问 AI」进入时携带，展示为可清除的 chip
    nodeContext: null,
    // 会话抽屉
    showSessions: false,
    sessions: [],
    sessionsLoading: false,
    sessionsHasMore: false,
    // 顶部提示条（AI 未开放/额度用尽等，非致命错误）
    banner: ''
  },

  onLoad(options) {
    // 支持从节点讲解等入口带 nodeId 追问（tab 页主要走 globalData.pendingAiNodeId）
    this.nodeId = options && options.nodeId ? Number(options.nodeId) : null;
    this._sessionsPage = 0;
    this._sessionsTotal = 0;
    this.loadSuggestedQuestions(this.nodeId);
  },

  onShow() {
    if (!app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/launch/launch' });
      return;
    }
    // tab 页常驻：换账号登录后清空上一账号的会话，避免串号展示
    const uid = (app.globalData.user || {}).id;
    if (this._uid !== uid) {
      this._uid = uid;
      this.stopStream(); // 上一账号可能还在生成，先中止再清空，否则回调会写进新账号的消息列表
      this.setData({ messages: [], conversationId: null, title: '', banner: '', sessions: [], showSessions: false });
    }
    // 消费节点详情「问 AI」传入的上下文（switchTab 不支持 query，走 globalData）
    const pendingId = app.globalData.pendingAiNodeId;
    if (pendingId) {
      app.globalData.pendingAiNodeId = null;
      this.applyNodeContext(Number(pendingId));
    }
  },

  /** 页面销毁（如登录态失效 reLaunch 回启动页）：中止流式请求，避免回调打到已销毁的页面 */
  onUnload() {
    this.stopStream();
  },

  /**
   * 应用节点上下文：记录 nodeId、拉取节点名做 chip 展示，并刷新该节点的建议问题。
   * @param {number} nodeId
   */
  applyNodeContext(nodeId) {
    if (!nodeId) return;
    this.nodeId = nodeId;
    // 先占位展示，节点名加载成功后补全
    this.setData({ nodeContext: { id: nodeId, name: '' } });
    this.loadSuggestedQuestions(nodeId);
    march.getNodeDetail(nodeId)
      .then((node) => {
        if (this.nodeId === nodeId && node) {
          this.setData({ nodeContext: { id: nodeId, name: node.name || '' } });
        }
      })
      .catch(() => { /* 名称加载失败不影响追问，chip 仍展示 id 上下文 */ });
  },

  /** 清除节点上下文：恢复无上下文的默认建议问题 */
  clearNodeContext() {
    this.nodeId = null;
    this.setData({ nodeContext: null });
    this.loadSuggestedQuestions(null);
  },

  /**
   * 加载建议问题（B5）：优先调后端接口，失败回退硬编码常见问题。
   * @param {number|null} nodeId
   */
  loadSuggestedQuestions(nodeId) {
    ai.getSuggestedQuestions(nodeId)
      .then((res) => {
        const items = ((res && res.items) || []).map((it) => it.text).filter((t) => t);
        this.setData({ commonQuestions: items.length ? items : COMMON_QUESTIONS });
      })
      .catch(() => {
        this.setData({ commonQuestions: COMMON_QUESTIONS });
      });
  },


  /** 输入框实时同步 */
  onInput(e) {
    this.setData({ inputText: e.detail.value });
  },

  /** 点击常见问题直接发问 */
  tapCommon(e) {
    const text = e.currentTarget.dataset.text;
    if (text) this.send(text);
  },

  /** 点击发送按钮（生成中该按钮已变为「停止」，这里只处理空闲态） */
  tapSend() {
    const text = (this.data.inputText || '').trim();
    if (!text) {
      wx.showToast({ title: '请先输入问题', icon: 'none' });
      return;
    }
    this.send(text);
  },

  /**
   * 发送一条提问：乐观插入用户气泡 + 加载占位，随后按 SSE 增量逐字渲染回答。
   * 失败/停止时保留已渲染的半截回答并给出重试入口；403/429 转为顶部提示条。
   * @param {string} text
   */
  send(text) {
    if (this.data.sending) {
      wx.showToast({ title: 'AI 正在回答，可点「停止」后再提问', icon: 'none' });
      return;
    }
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    if (trimmed.length > 500) {
      wx.showToast({ title: '问题请控制在 500 字以内', icon: 'none' });
      return;
    }

    const userMsg = { _k: 'm' + (++_seq), role: 'user', content: trimmed, sources: [], failed: false };
    const aiMsg = { _k: 'm' + (++_seq), role: 'assistant', content: '', sources: [], loading: true };
    const messages = this.data.messages.concat([userMsg, aiMsg]);
    this._pending = '';    // 已收到、还没渲染到屏幕的字符
    this._shown = '';      // 已渲染进 AI 气泡的正文
    this._typing = false;  // 是否已把加载动画换成正文（首拍标志）
    this._aiIndex = messages.length - 1;
    this._result = null;   // done 事件结果：等打字机把队列排空再收尾
    this._lastQuestion = trimmed;
    this._lastScroll = 0;
    this.setData({
      messages: messages,
      inputText: '',
      sending: true,
      banner: ''
    });
    this.scrollToBottom();

    this._stream = ai.chatStream(trimmed, this.data.conversationId, this.nodeId, {
      onStart: (info) => {
        this.setData({
          conversationId: info.conversationId,
          title: info.title || this.data.title
        });
      },
      onDelta: (piece) => this.pushDelta(piece),
      onDone: (res) => this.finishWhenDrained(res),
      onError: (err) => this.streamFailed(err)
    });
  },

  /** 收到增量：入队并启动渲染定时器（首片到达前气泡一直是三点加载动画） */
  pushDelta(piece) {
    if (!piece) return;
    this._pending += piece;
    if (!this._timer) this._timer = setInterval(() => this.renderNextChunk(), TYPE_TICK_MS);
  },

  /**
   * 渲染定时器的一拍：从队列取一批字符追加到正文。
   * 只 setData 这一条消息的字段（而非整个 messages 数组），逐字渲染才不至于卡顿。
   */
  renderNextChunk() {
    const queue = this._pending;
    if (queue) {
      const size = Math.max(1, Math.min(TYPE_MAX_PER_TICK, Math.ceil(queue.length / 20)));
      this._shown += queue.slice(0, size);
      this._pending = queue.slice(size);
      this.patchStreaming();
      this.followScroll();
      return;
    }
    // 队列已空：done 到了就收尾，没到则停表等下一片（省掉空转的定时器）
    if (this._result) {
      this.completeStream(this._result);
    } else {
      this.stopTimer();
    }
  },

  /** 把当前 _shown 渲染进 AI 气泡；首拍同时把加载动画换成正文与光标 */
  patchStreaming() {
    const i = this._aiIndex;
    if (!this.data.messages[i]) return;
    const patch = {};
    patch['messages[' + i + '].content'] = this._shown;
    patch['messages[' + i + '].blocks'] = markLast(util.parseMarkdownLite(this._shown));
    // 用实例标志判断首拍：不依赖 setData 之后 this.data 是否已同步更新
    if (!this._typing) {
      this._typing = true;
      patch['messages[' + i + '].loading'] = false;
      patch['messages[' + i + '].streaming'] = true;
    }
    this.setData(patch);
  },

  /** done 事件：记下结果，等打字机把队列排空再收尾，避免尾字被一次性糊上去 */
  finishWhenDrained(res) {
    this._result = res || {};
    if (!this._pending) this.completeStream(this._result);
  },

  /** 收尾：以后端返回的完整正文为准（含来源与用量），停表并恢复输入区 */
  completeStream(res) {
    this.stopStreamState();
    const reply = res.reply || this._shown;
    this._shown = reply;
    const i = this._aiIndex;
    const patch = { sending: false };
    patch['messages[' + i + '].content'] = reply;
    patch['messages[' + i + '].blocks'] = util.parseMarkdownLite(reply);
    patch['messages[' + i + '].sources'] = res.sources || [];
    patch['messages[' + i + '].usedTokens'] = res.usedTokens;
    patch['messages[' + i + '].loading'] = false;
    patch['messages[' + i + '].streaming'] = false;
    this.setData(patch);
    this.scrollToBottom();
  },

  /**
   * 流式失败：已渲染出正文则保留半截回答并在其下给重试入口；
   * 一个字都没出则撤掉空气泡、把提问标记为失败（后端此时已回滚本次提问）。
   */
  streamFailed(err) {
    this.stopStreamState();
    const msgs = this.data.messages.slice();
    const i = this._aiIndex;
    const shown = this._shown;
    const status = err && err.statusCode;
    const message = (err && err.message) || 'AI 服务暂时不可用，请稍后重试';
    const patch = { sending: false };
    if (shown && msgs[i]) {
      msgs[i] = Object.assign({}, msgs[i], {
        content: shown,
        blocks: util.parseMarkdownLite(shown),
        loading: false,
        streaming: false,
        failed: true
      });
      wx.showToast({ title: message, icon: 'none' });
    } else {
      msgs.splice(i, 1); // 撤掉没出字的空气泡
      markLastUserFailed(msgs);
      if (status === 403 || status === 429) {
        patch.banner = message; // 未开放/额度用尽：顶部常驻提示，不弹一闪而过的 toast
      } else {
        wx.showToast({ title: message, icon: 'none' });
      }
    }
    patch.messages = msgs;
    this.setData(patch);
    this.scrollToBottom();
  },

  /** 输入区「停止」按钮 */
  tapStop() {
    this.stopStream(true);
  },

  /**
   * 中止当前生成：保留已渲染的半截回答（后端会把已推出部分落库，重进会话看到的内容一致）。
   * @param {boolean} [restoreInput] 一个增量都没收到时，是否把问题还回输入框便于改问
   *   （仅「停止」按钮为 true；切会话/新建/换账号时不该往输入框塞旧问题）
   */
  stopStream(restoreInput) {
    if (!this._stream) return; // 空闲态（如 tapNew/切会话）不需要收尾，也不能动 messages
    this._stream.abort();
    this.stopStreamState();
    const msgs = this.data.messages.slice();
    const i = this._aiIndex;
    const shown = this._shown;
    const patch = { sending: false };
    if (shown && msgs[i]) {
      msgs[i] = Object.assign({}, msgs[i], {
        content: shown,
        blocks: util.parseMarkdownLite(shown),
        loading: false,
        streaming: false
      });
    } else {
      // 一个字都没出：撤掉空气泡与本次提问（后端同样已清库）
      msgs.splice(i, 1);
      for (let k = msgs.length - 1; k >= 0; k--) {
        if (msgs[k].role === 'user') {
          msgs.splice(k, 1);
          break;
        }
      }
      if (restoreInput) patch.inputText = this._lastQuestion || '';
    }
    patch.messages = msgs;
    this.setData(patch);
  },

  /** 清掉流式相关的定时器、句柄与待渲染队列（三条终止路径共用） */
  stopStreamState() {
    this.stopTimer();
    this._stream = null;
    this._result = null;
    this._pending = '';
  },

  stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  /**
   * 重试：失败标记可能挂在用户气泡（没出字）或 AI 气泡（半截回答）上，
   * 两种情况都要重发对应的那条提问，并把它与失败气泡一并移除，避免同一问题出现两次。
   */
  tapRetry(e) {
    if (this.data.sending) return;
    const k = e.currentTarget.dataset.k;
    const msgs = this.data.messages;
    let idx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i]._k === k) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    let userIdx = msgs[idx].role === 'user' ? idx : -1;
    for (let i = idx - 1; userIdx < 0 && i >= 0; i--) {
      if (msgs[i].role === 'user') userIdx = i;
    }
    const content = userIdx >= 0 ? msgs[userIdx].content : '';
    if (!content) return;
    this.setData({ messages: msgs.slice(0, userIdx) });
    this.send(content);
  },

  /** 新建对话：清空当前会话（生成中则先停止），下次发送即新建 */
  tapNew() {
    this.stopStream();
    this.setData({ messages: [], conversationId: null, title: '', banner: '', showSessions: false });
  },

  /**
   * 滚到底部：scroll-into-view 的值不变就不会重复触发，
   * 故先清空再于下一帧定位到底部锚点（下一帧是为了等新气泡渲染完）。
   */
  scrollToBottom() {
    if (!this.data.messages.length) return;
    this.setData({ toView: '' });
    wx.nextTick(() => this.setData({ toView: BOTTOM_ANCHOR }));
  },

  /** 生成中的跟随滚动：按 SCROLL_GAP_MS 节流，避免每拍都触发一次定位 */
  followScroll() {
    const now = Date.now();
    if (now - this._lastScroll < SCROLL_GAP_MS) return;
    this._lastScroll = now;
    this.scrollToBottom();
  },

  // ---------------- 会话抽屉 ----------------
  openSessions() {
    this.setData({ showSessions: true });
    this.loadSessions(true);
  },

  closeSessions() {
    this.setData({ showSessions: false });
  },

  noop() {},

  /** 抽屉打开时加载更多会话（下一页） */
  loadMoreSessions() {
    if (this.data.sessionsLoading || !this.data.sessionsHasMore) return;
    this.loadSessions(false);
  },

  /**
   * 加载会话列表（分页）。
   * @param {boolean} reset true=重新从第一页加载；false=追加下一页
   */
  loadSessions(reset) {
    const page = reset ? 1 : this._sessionsPage + 1;
    this.setData({ sessionsLoading: true });
    ai.listConversations(page, SESSION_PAGE_SIZE)
      .then((res) => {
        const rawItems = res.items || [];
        const items = rawItems.map((it) => ({
          conversationId: it.conversationId,
          title: it.title || '未命名会话',
          preview: it.preview || '',
          messageCount: it.messageCount || 0,
          timeText: util.formatRelative(it.updatedAt || it.createdAt)
        }));
        const sessions = reset ? items : this.data.sessions.concat(items);
        this._sessionsPage = page;
        this._sessionsTotal = res.total || sessions.length;
        this.setData({
          sessions,
          sessionsLoading: false,
          sessionsHasMore: sessions.length < this._sessionsTotal && rawItems.length > 0
        });
      })
      .catch((err) => {
        this.setData({ sessionsLoading: false });
        wx.showToast({ title: (err && err.message) || '会话列表加载失败', icon: 'none' });
      });
  },


  /** 切换到某个历史会话：拉详情并渲染消息 */
  tapSession(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    // 切会话即放弃当前生成：半截回答后端已落库，切回来仍能看到
    this.stopStream();
    wx.showLoading({ title: '加载中', mask: true });
    ai.getConversation(id)
      .then((res) => {
        const messages = (res.messages || []).map((m) => ({
          _k: 'm' + (++_seq),
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content || '',
          // 仅助手消息做 markdown 块解析；用户消息保持纯文本
          blocks: m.role === 'user' ? null : util.parseMarkdownLite(m.content || ''),
          sources: m.sources || []
        }));
        this.setData({
          conversationId: res.conversationId,
          title: res.title || '',
          messages,
          showSessions: false,
          banner: ''
        });
        wx.hideLoading();
        this.scrollToBottom();
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '会话加载失败', icon: 'none' });
      });
  },

  /** 删除某个会话（二次确认） */
  tapDeleteSession(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    wx.showModal({
      title: '删除会话',
      content: '确定删除这条会话吗？删除后不可恢复。',
      confirmColor: '#C8102E',
      success: (res) => {
        if (!res.confirm) return;
        // 删的正是当前会话且还在生成：先停止，别再往已删除的会话里写增量
        if (this.data.conversationId === id) this.stopStream();
        ai.deleteConversation(id)
          .then(() => {
            const sessions = this.data.sessions.filter((s) => s.conversationId !== id);
            const patch = { sessions };
            // 删的是当前会话则清空对话区
            if (this.data.conversationId === id) {
              patch.messages = [];
              patch.conversationId = null;
              patch.title = '';
            }
            this.setData(patch);
            wx.showToast({ title: '已删除', icon: 'success' });
          })
          .catch((err) => {
            wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' });
          });
      }
    });
  }
});
