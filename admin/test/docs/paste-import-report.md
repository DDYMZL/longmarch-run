# 题库「复制导入」管理后台验收

- 日期：2026-10-28
- 范围：题库维护页新增粘贴导入；单次最多 500 题；导入成功后再统一设分值，默认每题 20 分
- 构建：`npm run build`（vue-tsc + vite build + dist.zip）通过
- 脚本：`admin/test/paste-questions-check.ts`（解析器，18 项通过，含 501 题溢出 1 条）
- 截图：`admin/test/images/paste-import-score.png`

## 1. 改动

| 文件 | 说明 |
| --- | --- |
| `src/utils/pasteQuestions.ts` | 按空行切题，解析题干、A–D 选项、【答案】、【解析】；单次上限 500 |
| `src/components/PasteImportDialog.vue` | 预览每页 20 行；勾选后一次提交；成功后进入「设置分值」，默认 20，不改分不再发第二次请求 |
| `src/views/QuestionsView.vue` | 工具栏「复制导入」；成功后清筛选并跳到最后一页 |
| `src/api/admin.ts` | `pasteImportQuestions`（60 秒）、`updateQuestionScores` |
| `src/main.ts` | 注册 `DocumentCopy` 图标 |

## 2. 浏览器验收（http://localhost:5173/questions，账号 admin）

| 步骤 | 结果 |
| --- | --- |
| 粘贴用户示例三题并导入 | 写入题库，分值 20，出现在列表末页 |
| 再导入时其中一题与题库重复 | 弹窗切到「设置分值」：已导入 1 道、默认 20 分；未写入 1 道，原因「与题库中已有题目重复」 |
| 把分值改为 25 并保存 | 该题列表分值显示 25 |
| 删除本次验收题并清空搜索 | 列表回到「共 28 题」（含此前示例三题，分值 20） |

## 3. 同一行选项

`A. 甲 B. 乙`、`A 甲 B 乙`、`A甲 B乙` 都能拆成独立选项，答案 `答案：B` 对得上 B。解析器 22 项通过。浏览器预览两道题均为「可导入」，答案显示「B. 战略转移」。

## 4. 结论

预览只渲染当前页，导入与改分各一次请求。分值在导入成功之后设置，保持 20 分时不额外打接口。
