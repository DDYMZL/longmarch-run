// 把粘贴的纯文本题目解析成题库结构。格式见 parsePastedQuestions 注释。
// 只做识别与就地校验；与库内重复由保存接口再查一次。

export const PASTE_IMPORT_LIMIT = 500

export interface PastedOption {
  label: string
  text: string
}

export interface PastedQuestion {
  key: number
  type: 'single' | 'judge'
  question: string
  options: PastedOption[]
  answer: string[]
  analysis: string
  errors: string[]
}

export interface PasteParseResult {
  items: PastedQuestion[]
  /** 空行切分后超出单次上限、未进入预览的题数 */
  overflow: number
}

const LABELS = ['A', 'B', 'C', 'D', 'E', 'F']
// 行首或空白后的 A-F。后面可以是 .、），也可以是空格，也可以直接接汉字（A战略后退）。
const OPTION_MARK = /(?:^|\s)([A-F])(?:\s*[.、．。:：)）]\s*|\s+|(?=[\u4e00-\u9fff]))/g
const NUMBERED_LINE = /^([1-6])\s*[.、．)）]\s*(.+)$/
const ANSWER_LINE = /^(?:【\s*(?:参考答案|正确答案|答案)\s*】\s*[:：]?|(?:参考答案|正确答案|答案)\s*[:：])\s*(.*)$/
const ANALYSIS_LINE = /^(?:【\s*(?:答案解析|试题解析|解析)\s*】\s*[:：]?|(?:答案解析|试题解析|解析)\s*[:：])\s*(.*)$/
const JUDGE_WORDS: Record<string, '正确' | '错误'> = {
  正确: '正确',
  对: '正确',
  错误: '错误',
  错: '错误'
}

function toHalfWidth(input: string): string {
  return input
    .replace(/[\uFF21-\uFF3A\uFF41-\uFF5A\uFF10-\uFF19]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .replace(/\u3000/g, ' ')
}

function normalizeLine(line: string): string {
  return toHalfWidth(line).replace(/\u00a0/g, ' ').trim()
}

/** 一行里的选项。支持 A. 甲、A 甲、A甲，以及同一行 A 甲 B 乙。行首不是选项时返回 null。 */
function splitLetterOptions(line: string): PastedOption[] | null {
  const marks: { label: string; markStart: number; contentStart: number }[] = []
  const re = new RegExp(OPTION_MARK.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(line)) !== null) {
    const lead = match[0].length - match[0].trimStart().length
    marks.push({
      label: match[1].toUpperCase(),
      markStart: match.index + lead,
      contentStart: match.index + match[0].length
    })
  }
  if (!marks.length || marks[0].markStart !== 0) return null
  return marks.map((mark, index) => ({
    label: mark.label,
    text: line.slice(mark.contentStart, index + 1 < marks.length ? marks[index + 1].markStart : line.length).trim()
  }))
}

function isOptionLine(line: string): boolean {
  return (splitLetterOptions(line)?.length ?? 0) > 0
}

function isAnswerLine(line: string): boolean {
  return ANSWER_LINE.test(line)
}

function isAnalysisLine(line: string): boolean {
  return ANALYSIS_LINE.test(line)
}

function numberedText(line: string, expected: number): string | null {
  const matched = line.match(NUMBERED_LINE)
  if (!matched || Number(matched[1]) !== expected) return null
  return matched[2].trim()
}

/** 当前行起、空行之前，若能看到至少两个选项或一行答案，则视为下一题的开头。 */
function looksLikeNextQuestion(lines: string[], index: number): boolean {
  let options = 0
  for (let j = index; j < lines.length && j < index + 12; j++) {
    const text = normalizeLine(lines[j])
    if (!text) break
    if (isAnswerLine(text)) return true
    if (isAnalysisLine(text)) break
    const inline = splitLetterOptions(text)
    if (inline) options += inline.length
    else if (NUMBERED_LINE.test(text)) options += 1
    if (options >= 2) return true
  }
  return false
}

function splitBlocks(text: string): string[][] {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const blocks: string[][] = []
  let current: string[] = []
  let phase: 'stem' | 'options' | 'answer' | 'analysis' = 'stem'

  const flush = () => {
    if (current.length) blocks.push(current)
    current = []
    phase = 'stem'
  }

  for (let i = 0; i < lines.length; i++) {
    const text = normalizeLine(lines[i])
    if (!text) {
      // 空行即一题结束。同一道题内部不要留空行，否则选项和答案会被拆开
      if (current.length) flush()
      continue
    }
    if ((phase === 'answer' || phase === 'analysis') && !isAnalysisLine(text) && !isAnswerLine(text)) {
      if (looksLikeNextQuestion(lines, i)) {
        flush()
      } else {
        current.push(text)
        phase = 'analysis'
        continue
      }
    }
    if (isAnalysisLine(text)) {
      current.push(text)
      phase = 'analysis'
      continue
    }
    if (isAnswerLine(text)) {
      current.push(text)
      phase = 'answer'
      continue
    }
    current.push(text)
    if (isOptionLine(text) || (phase === 'options' && NUMBERED_LINE.test(text))) phase = 'options'
  }
  flush()
  return blocks
}

function stripStemIndex(stem: string): string {
  return stem.replace(/^(?:[(（]\s*)?(?:第\s*)?\d{1,3}\s*[)）.、．]\s*/, '').trim()
}

function joinParts(parts: string[]): string {
  return parts.join('').trim()
}

interface ResolvedAnswer {
  label: string
  judgeWord: '正确' | '错误' | null
  error: string
}

function labelByNumber(n: number, options: PastedOption[]): string {
  const label = LABELS[n - 1] || ''
  return options.some((item) => item.label === label) ? label : ''
}

function resolveAnswer(raw: string, options: PastedOption[]): ResolvedAnswer {
  const text = raw.trim().replace(/[。．.]\s*$/, '')
  const empty: ResolvedAnswer = { label: '', judgeWord: null, error: '' }
  if (!text) return { ...empty, error: '未识别到答案' }

  const pieces = text.split(/[,，、/\s]+/).filter(Boolean)
  if (pieces.length > 1 && pieces.every((piece) => /^[A-F]$/i.test(piece))) {
    return { ...empty, error: '只支持一个正确答案' }
  }

  const wrapped = text.match(/^[（(]\s*([A-F1-6])\s*[）)]$/)
  const prefixed = text.match(/^([A-F])\s*[.、．:：)）]?\s*(.*)$/i)
  const numbered = text.match(/^([1-6])\s*[.、．)）]?\s*(.*)$/)
  let label = ''
  let rest = ''
  if (wrapped) {
    const token = wrapped[1].toUpperCase()
    label = /^[1-6]$/.test(token) ? labelByNumber(Number(token), options) : token
  } else if (prefixed && !prefixed[2].trim().match(/^[A-F]$/i)) {
    label = prefixed[1].toUpperCase()
    rest = prefixed[2].trim()
  } else if (numbered) {
    label = labelByNumber(Number(numbered[1]), options)
    rest = numbered[2].trim()
  }
  if (label && options.some((item) => item.label === label)) {
    const option = options.find((item) => item.label === label)
    if (!rest || rest === option?.text) return { ...empty, label }
  }

  const sameText = options.filter((item) => item.text === text)
  if (sameText.length === 1) return { ...empty, label: sameText[0].label }

  const judgeWord = JUDGE_WORDS[text] || null
  if (judgeWord) {
    const hit = options.filter((item) => item.text === judgeWord)
    if (hit.length === 1) return { ...empty, label: hit[0].label, judgeWord }
    if (!options.length) return { ...empty, judgeWord }
  }

  return { ...empty, error: options.length ? `答案「${text}」对不上选项` : '未识别到选项' }
}

function asJudge(options: PastedOption[], label: string): { options: PastedOption[]; answer: string[] } | null {
  if (options.length !== 2) return null
  const texts = new Set(options.map((item) => item.text))
  if (texts.size !== 2 || !texts.has('正确') || !texts.has('错误')) return null
  const chosen = options.find((item) => item.label === label)
  if (!chosen) return null
  return {
    options: [
      { label: 'A', text: '正确' },
      { label: 'B', text: '错误' }
    ],
    answer: [chosen.text === '正确' ? 'A' : 'B']
  }
}

function parseBlock(block: string[], key: number): PastedQuestion {
  const item: PastedQuestion = {
    key,
    type: 'single',
    question: '',
    options: [],
    answer: [],
    analysis: '',
    errors: []
  }
  const stem: string[] = []
  const analysis: string[] = []
  let answerRaw = ''
  let numbered = 0
  let mode: 'none' | 'letter' | 'number' = 'none'

  for (const line of block) {
    const analysisMatch = line.match(ANALYSIS_LINE)
    if (analysisMatch) {
      if (analysisMatch[1].trim()) analysis.push(analysisMatch[1].trim())
      continue
    }
    const answerMatch = line.match(ANSWER_LINE)
    if (answerMatch) {
      if (answerRaw) item.errors.push('答案出现了多次')
      answerRaw = answerMatch[1].trim()
      continue
    }
    const letterOptions = mode === 'number' ? null : splitLetterOptions(line)
    if (letterOptions) {
      mode = 'letter'
      item.options.push(...letterOptions)
      continue
    }
    if (mode !== 'letter' && stem.length) {
      const text = numberedText(line, numbered + 1)
      if (text !== null) {
        mode = 'number'
        numbered += 1
        item.options.push({ label: LABELS[numbered - 1], text })
        continue
      }
    }
    if ((mode === 'letter' || mode === 'number') && item.options.length && !answerRaw && !analysis.length) {
      // 答案出现前的换行视为上一个选项的续写
      const last = item.options[item.options.length - 1]
      last.text = `${last.text}${line}`.trim()
      continue
    }
    if (answerRaw || analysis.length) {
      analysis.push(line)
      continue
    }
    stem.push(line)
  }

  item.question = stripStemIndex(joinParts(stem))
  item.analysis = joinParts(analysis)

  if (!item.question) item.errors.push('题干不能为空')
  if (item.options.length > LABELS.length) item.errors.push(`最多 ${LABELS.length} 个选项`)
  if (item.options.some((option) => !option.text)) item.errors.push('选项内容不能为空')
  const labels = item.options.map((option) => option.label)
  if (new Set(labels).size !== labels.length) item.errors.push('选项标签重复')

  if (!answerRaw) {
    item.errors.push('未识别到答案')
  } else {
    const resolved = resolveAnswer(answerRaw, item.options)
    if (resolved.error) item.errors.push(resolved.error)
    if (resolved.judgeWord && !item.options.length) {
      item.type = 'judge'
      item.options = [
        { label: 'A', text: '正确' },
        { label: 'B', text: '错误' }
      ]
      item.answer = [resolved.judgeWord === '正确' ? 'A' : 'B']
    } else if (resolved.label) {
      const judged = asJudge(item.options, resolved.label)
      if (judged) {
        item.type = 'judge'
        item.options = judged.options
        item.answer = judged.answer
      } else {
        item.answer = [resolved.label]
      }
    }
  }

  if (item.type === 'single' && item.options.length < 2) item.errors.push('至少需要 2 个选项')
  return item
}

/**
 * 解析粘贴文本。题目之间用空行隔开（同一题内不要空行）；写在【解析】后面、且后面还能认出选项或答案的段落也会另起一题。
 *
 * 单题格式：
 *   题干
 *   A. 选项一
 *   B. 选项二
 *   【答案】B
 *   【解析】可省略
 *
 * 选项也可以写在同一行，点号和空格都可以省略：
 *   A. 选项一  B. 选项二
 *   A 选项一 B 选项二
 *   A选项一 B选项二
 * 也接受 A、 / A） / （A）、答案：、解析：，以及「正确 / 错误」判断题。
 * 题号前缀（如「1.」）会从题干去掉。1. 2. 3. 这种纯数字选项会按顺序改成 A B C。
 */
export function parsePastedQuestions(text: string): PasteParseResult {
  const blocks = splitBlocks(text).filter((block) => block.length)
  const overflow = Math.max(0, blocks.length - PASTE_IMPORT_LIMIT)
  const items = blocks.slice(0, PASTE_IMPORT_LIMIT).map((block, index) => parseBlock(block, index + 1))
  const seen = new Map<string, number>()
  items.forEach((item, index) => {
    const stem = item.question.trim()
    if (!stem) return
    const first = seen.get(stem)
    if (first !== undefined) {
      item.errors.push(`与本次粘贴的第 ${first} 题题干重复`)
    } else {
      seen.set(stem, index + 1)
    }
  })
  return { items, overflow }
}
