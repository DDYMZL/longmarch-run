// 实时推送 composable：后端 /api/ws/updates 数据变更广播（data_changed / activity）
// token query 鉴权、指数退避重连、data_changed 合并防抖刷新、卸载自动清理
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { ActivityItem } from '../api/admin'
import { getToken } from '../store/auth'

type LiveMessage = {
  type: string
  eventType?: string
  userId?: number
  nickname?: string
  text?: string
  at?: string
}

type LiveHandlers = {
  /** 数据变更：同一窗口内多次广播合并为一次回调 */
  onDataChanged?: () => void
  onActivity?: (item: ActivityItem) => void
}

const RELOAD_DELAY = 800
// 推送动态无库内 id，用递减负数作行 key，避免与真实 id 及同毫秒事件冲突
let liveActivitySeq = 0

export function useLiveUpdates(handlers: LiveHandlers) {
  const wsStatus = ref<'connecting' | 'online' | 'offline'>('connecting')
  let socket: WebSocket | null = null
  let reconnectTimer: number | null = null
  let reloadTimer: number | null = null
  let reconnectDelay = 3000
  let disposed = false

  function handle(data: LiveMessage) {
    if (data.type === 'data_changed' && handlers.onDataChanged && reloadTimer === null) {
      reloadTimer = window.setTimeout(() => {
        reloadTimer = null
        handlers.onDataChanged?.()
      }, RELOAD_DELAY)
    } else if (data.type === 'activity' && data.text && handlers.onActivity) {
      handlers.onActivity({
        id: --liveActivitySeq,
        event_type: data.eventType || '',
        event_time: data.at || new Date().toISOString(),
        user_id: data.userId || 0,
        nickname: data.nickname || '',
        text: data.text,
        data: {}
      })
    }
  }

  function connect() {
    if (disposed) return
    const token = getToken()
    if (!token) {
      wsStatus.value = 'offline'
      return
    }
    wsStatus.value = 'connecting'
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/ws/updates?token=${encodeURIComponent(token)}`)
    socket = ws
    ws.onopen = () => {
      wsStatus.value = 'online'
      reconnectDelay = 3000
    }
    ws.onmessage = (event) => {
      let data: unknown
      try {
        data = JSON.parse(String(event.data))
      } catch {
        return // 非 JSON 消息（心跳等）忽略
      }
      if (data && typeof (data as LiveMessage).type === 'string') handle(data as LiveMessage)
    }
    ws.onclose = () => {
      socket = null
      if (!disposed) scheduleReconnect()
    }
    ws.onerror = () => ws.close()
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer !== null) return
    wsStatus.value = 'offline'
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      connect()
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 15000)
  }

  function dispose() {
    disposed = true
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    if (reloadTimer !== null) window.clearTimeout(reloadTimer)
    if (socket) {
      socket.onclose = null
      socket.close()
    }
  }

  onMounted(connect)
  onBeforeUnmount(dispose)

  return { wsStatus }
}
