// 实时推送 composable：后端 /api/ws/updates 数据变更广播（data_changed / activity）
// 模式抽自 RankingsView：token query 鉴权、指数退避重连、卸载自动清理
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getToken } from '../store/auth'

export type LiveMessage = {
  type: string
  eventType?: string
  userId?: number
  nickname?: string
  text?: string
  at?: string
}

export function useLiveUpdates(onMessage: (data: LiveMessage) => void) {
  const wsStatus = ref<'connecting' | 'online' | 'offline'>('connecting')
  let socket: WebSocket | null = null
  let reconnectTimer: number | null = null
  let reconnectDelay = 3000
  let disposed = false

  function connect() {
    if (disposed) return
    const token = getToken()
    if (!token) return
    wsStatus.value = 'connecting'
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/ws/updates?token=${encodeURIComponent(token)}`)
    socket = ws
    ws.onopen = () => {
      wsStatus.value = 'online'
      reconnectDelay = 3000
    }
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data))
        if (data && typeof data.type === 'string') onMessage(data as LiveMessage)
      } catch {
        // 非 JSON 消息（心跳等）忽略
      }
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
    if (socket) {
      socket.onclose = null
      socket.close()
    }
  }

  onMounted(connect)
  onBeforeUnmount(dispose)

  return { wsStatus }
}

/** 后端时间为 UTC naive ISO，按本地时区格式化（与小程序 util.formatTime 同约定） */
export function formatTime(value: string | null | undefined) {
  if (!value) return ''
  const source = /Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(source))
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}
