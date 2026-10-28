// 复制导入解析器自检。运行：node --experimental-strip-types test/paste-questions-check.ts
import { parsePastedQuestions } from '../src/utils/pasteQuestions.ts'

const SAMPLE = `
中央红军（红一方面军）长征的起点是（ ）。
A. 井冈山
B. 瑞金
C. 延安
D. 遵义
【答案】B
【解析】1934年10月，中央红军从江西瑞金等地出发，开始长征。

标志着中国共产党历史上生死攸关的转折点的会议是（ ）。
A. 八七会议
B. 古田会议
C. 遵义会议
D. 瓦窑堡会议
【答案】C
【解析】1935年1月召开的遵义会议，挽救了党、挽救了红军、挽救了中国革命，是党的历史上生死攸关的转折点。

红军长征途中，打乱敌人追剿计划的军事行动是（ ）。
A. 强渡大渡河
B. 四渡赤水
C. 飞夺泸定桥
D. 巧渡金沙江
【答案】B
【解析】四渡赤水战役是红军长征中的经典战例，彻底粉碎了蒋介石企图围歼红军于川黔滇边境的狂妄计划。
`

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`PASS ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}${detail ? ` | ${detail}` : ''}`)
}

const sample = parsePastedQuestions(SAMPLE)
check('示例三题', sample.items.length === 3 && sample.overflow === 0, `n=${sample.items.length}`)
check(
  '示例全部可导入',
  sample.items.every((item) => item.errors.length === 0 && item.type === 'single')
)
check('第1题答案瑞金', sample.items[0]?.answer[0] === 'B' && sample.items[0]?.options[1]?.text === '瑞金')
check('第2题答案遵义会议', sample.items[1]?.answer[0] === 'C' && sample.items[1]?.options[2]?.text === '遵义会议')
check('第3题解析保留', (sample.items[2]?.analysis || '').includes('四渡赤水'))

const loose = parsePastedQuestions(`1、遵义会议召开于哪一年？
A、1934年
A）这行应算重复标签
B、1935年
【答案】B
解析：1935年1月。
2. 另一题没有空行也应该切开
A. 甲
B. 乙
答案：A`)
check('无空行切成两题', loose.items.length === 2, `n=${loose.items.length} q2=${loose.items[1]?.question}`)
check('题号前缀去掉', loose.items[0]?.question === '遵义会议召开于哪一年？', loose.items[0]?.question)
check('重复选项标签', (loose.items[0]?.errors || []).some((error) => error.includes('选项标签重复')))

const numbered = parsePastedQuestions(`起点在哪里？
1. 井冈山
2. 瑞金
3. 延安
【答案】2
【解析】第一句。
从瑞金出发。`)
check('数字选项映射到 B', numbered.items.length === 1 && numbered.items[0]?.answer[0] === 'B' && numbered.items[0]?.options[1]?.label === 'B')
check('解析换行拼接', numbered.items[0]?.analysis === '第一句。从瑞金出发。', numbered.items[0]?.analysis)
check('数字选项无错误', numbered.items[0]?.errors.length === 0, (numbered.items[0]?.errors || []).join('；'))

const judge = parsePastedQuestions(`遵义会议确立了毛泽东在党中央的领导地位。
【答案】正确
【解析】事实上确立了领导地位。`)
check('判断题', judge.items[0]?.type === 'judge' && judge.items[0]?.answer[0] === 'A' && judge.items[0]?.errors.length === 0)

const judgeOptions = parsePastedQuestions(`下面说法是否正确。
A. 错误
B. 正确
【答案】B`)
check(
  '判断选项归一',
  judgeOptions.items[0]?.type === 'judge' &&
    judgeOptions.items[0]?.answer[0] === 'A' &&
    judgeOptions.items[0]?.options[0]?.text === '正确'
)

const bad = parsePastedQuestions(`只有题干没有选项。
【解析】缺答案

有选项没答案
A. 甲
B. 乙

有选项没答案
A. 甲
B. 乙`)
check('缺答案被标出', bad.items.length === 3 && bad.items[0]?.errors.length > 0 && bad.items[1]?.errors.some((error) => error.includes('答案')))
check('批内题干重复', bad.items[2]?.errors.some((error) => error.includes('重复')))

const textAnswer = parsePastedQuestions(`起点是（ ）。
Ａ．井冈山
Ｂ．瑞金
【答案】瑞金`)
check('全角选项与文字答案', textAnswer.items[0]?.answer[0] === 'B' && textAnswer.items[0]?.errors.length === 0, (textAnswer.items[0]?.errors || []).join('；'))

const many = Array.from({ length: 501 }, (_, index) => `题干${index}？\nA. 甲\nB. 乙\n【答案】A`).join('\n\n')
const overflow = parsePastedQuestions(many)
check('超过 500 道截断', overflow.items.length === 500 && overflow.overflow === 1)

const empty = parsePastedQuestions('   \n\n  ')
check('空白文本', empty.items.length === 0)

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
