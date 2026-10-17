/**
 * AI 历史助手（长征历史问答）
 * - 连续对话：conversationId 为空新建会话，追问沿用同一会话（后端注入历史上下文）；
 * - 会话管理：右上「会话」抽屉查看/切换/删除本人会话（归属由后端 JWT 判定）；
 * - 状态：加载动画、失败重试、空状态常见问题、AI 未开放(403)/额度用尽(429)/上游异常(502) 明确提示；
 * - 来源：回答下方展示后端核验过的已发布知识资料。
 * 登录守卫：非 tab 页，onShow 自行校验 loggedIn，未登录回启动页。
 */
const app = getApp();
const ai = require('../../services/ai');
const util = require('../../utils/util');

const COMMON_QUESTIONS = [
  '红军长征是从什么时候开始的？',
  '遵义会议有什么历史意义？',
  '红军长征翻越了哪些雪山？',
  '飞夺泸定桥是怎么回事？'
];

let _seq = 0;

Page({
  data: {
    messages: [],
    conversationId: null,
    title: '',
    inputText: '',
    sending: false,
    toView: '',
    commonQuestions: COMMON_QUESTIONS,
    // 会话抽屉
    showSessions: false,
    sessions: [],
    sessionsLoading: false,
    // 顶部提示条（AI 未开放/额度用尽等，非致命错误）
    banner: ''
  },

  onLoad(options) {
    // 支持从节点讲解等入口带 nodeId 追问（Phase A 先不接入，保留参数通道）
    this.nodeId = options && options.nodeId ? Number(options.nodeId) : null;
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
      this.setData({ messages: [], conversationId: null, title: '', banner: '', sessions: [], showSessions: false });
    }
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

  /** 点击发送按钮 */
  tapSend() {
    const text = (this.data.inputText || '').trim();
    if (!text) {
      wx.showToast({ title: '请先输入问题', icon: 'none' });
      return;
    }
    this.send(text);
  },

  /**
   * 发送一条提问：乐观插入用户气泡 + 加载态，成功后追加回答气泡。
   * 失败时把该用户气泡标记为 failed 并提供重试；403/429 转为顶部提示条。
   * @param {string} text
   */
  send(text) {
    if (this.data.sending) return;
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    if (trimmed.length > 500) {
      wx.showToast({ title: '问题请控制在 500 字以内', icon: 'none' });
      return;
    }

    const userMsg = { _k: 'm' + (++_seq), role: 'user', content: trimmed, sources: [], failed: false };
    const loadingMsg = { _k: 'm' + (++_seq), role: 'assistant', content: '', sources: [], loading: true };
    this.setData({
      messages: this.data.messages.concat([userMsg, loadingMsg]),
      inputText: '',
      sending: true,
      banner: ''
    });
    this.scrollToBottom();

    ai.chat(trimmed, this.data.conversationId, this.nodeId)
      .then((res) => {
        const msgs = this.data.messages.slice();
        // 移除加载占位，替换为真实回答
        msgs.pop();
        msgs.push({
          _k: 'm' + (++_seq),
          role: 'assistant',
          content: res.reply || '',
          sources: res.sources || [],
          usedTokens: res.usedTokens
        });
        this.setData({
          messages: msgs,
          conversationId: res.conversationId,
          title: res.title || this.data.title,
          sending: false
        });
        this.scrollToBottom();
      })
      .catch((err) => {
        const msgs = this.data.messages.slice();
        msgs.pop(); // 去掉加载占位
        // 把最后一条用户气泡标记为失败，供重试
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'user') {
            msgs[i] = Object.assign({}, msgs[i], { failed: true });
            break;
          }
        }
        const patch = { messages: msgs, sending: false };
        const status = err && err.statusCode;
        const message = (err && err.message) || 'AI 服务暂时不可用，请稍后重试';
        if (status === 403 || status === 429) {
          patch.banner = message; // 未开放/额度用尽：顶部常驻提示，不弹一闪而过的 toast
        } else {
          wx.showToast({ title: message, icon: 'none' });
        }
        this.setData(patch);
        this.scrollToBottom();
      });
  },

  /** 重试失败的那条提问：移除失败气泡后重新发送，避免重复堆叠 */
  tapRetry(e) {
    const k = e.currentTarget.dataset.k;
    const target = this.data.messages.find((m) => m._k === k);
    if (!target || !target.content || this.data.sending) return;
    this.setData({ messages: this.data.messages.filter((m) => m._k !== k) });
    this.send(target.content);
  },

  /** 新建对话：清空当前会话，下次发送即新建 */
  tapNew() {
    if (this.data.sending) return;
    this.setData({ messages: [], conversationId: null, title: '', banner: '', showSessions: false });
  },

  scrollToBottom() {
    const msgs = this.data.messages;
    if (!msgs.length) return;
    // 下一帧再定位，确保新气泡已渲染
    wx.nextTick(() => this.setData({ toView: 'msg-' + msgs[msgs.length - 1]._k }));
  },

  // ---------------- 会话抽屉 ----------------
  openSessions() {
    this.setData({ showSessions: true });
    this.loadSessions();
  },

  closeSessions() {
    this.setData({ showSessions: false });
  },

  noop() {},

  loadSessions() {
    this.setData({ sessionsLoading: true });
    ai.listConversations(1, 50)
      .then((res) => {
        const items = (res.items || []).map((it) => ({
          conversationId: it.conversationId,
          title: it.title || '未命名会话',
          preview: it.preview || '',
          messageCount: it.messageCount || 0,
          timeText: util.formatRelative(it.updatedAt || it.createdAt)
        }));
        this.setData({ sessions: items, sessionsLoading: false });
      })
      .catch((err) => {
        this.setData({ sessionsLoading: false });
        wx.showToast({ title: (err && err.message) || '会话列表加载失败', icon: 'none' });
      });
  },

  /** 切换到某个历史会话：拉详情并渲染消息 */
  tapSession(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id || this.data.sending) return;
    wx.showLoading({ title: '加载中', mask: true });
    ai.getConversation(id)
      .then((res) => {
        const messages = (res.messages || []).map((m) => ({
          _k: 'm' + (++_seq),
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content || '',
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
