// 统一时间/数字格式化：Intl 实例模块级复用（表格大量行渲染时避免逐格新建）
// 后端时间为 UTC naive ISO，按本地时区展示（与小程序 util.formatTime 同约定）
const SHORT_TIME = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})
const FULL_TIME = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})
const FULL_TIME_SECONDS = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})
const NUMBER = new Intl.NumberFormat('zh-CN')

function parseUtc(value: string) {
  return new Date(/Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`)
}

/** MM/DD HH:mm */
export function formatTime(value: string | null | undefined) {
  return value ? SHORT_TIME.format(parseUtc(value)) : ''
}

/** YYYY/MM/DD HH:mm（seconds 时带秒）；空值返回 empty */
export function formatDateTime(value: string | null | undefined, empty = '—', seconds = false) {
  if (!value) return empty
  return (seconds ? FULL_TIME_SECONDS : FULL_TIME).format(parseUtc(value))
}

export function formatNumber(value: number) {
  return NUMBER.format(value)
}
