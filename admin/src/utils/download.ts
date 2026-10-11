// 浏览器端保存文件：Blob（接口 responseType: 'blob' 返回值）或文本内容
export function saveFile(data: Blob | string, filename: string, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

// CSV 单元格防公式注入：以 = + - @ 开头的文本加前导单引号
export function csvCell(value: unknown) {
  let text = value == null ? '' : String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

// 本地日期 YYYY-MM-DD（toISOString 为 UTC，凌晨导出会得到前一天）
export function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
