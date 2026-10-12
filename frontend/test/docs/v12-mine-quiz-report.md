# V1.2 我的页隐藏「账号与绑定」+ 答题提交后统一反馈 测试报告

- 日期：2026-10-12
- 环境：微信开发者工具（自动化端口 9420）+ 本地后端 http://127.0.0.1:8010（openGauss，已应用 014_quiz_result_details.sql）
- 小程序脚本：`frontend/test/automator/v12-mine-quiz.cjs`（测试用户 Token 由后端脚本生成后注入，经启动页 `/auth/me` 后端校验进入首页）
- 后端脚本：`backend/test/s18_quiz_submit_feedback.py`（TestClient + SQLite 临时库）

## 变更范围

| 需求 | 文件 | 说明 |
| --- | --- | --- |
| 我的页隐藏账号与绑定 | `pages/mine/mine.wxml/js` | 删除入口与 `goAccount`；`pages/account` 页面、`/api/auth/identities*` 绑定接口、数据库字段均保留 |
| 答题反馈 | `pages/quiz-answer/*` | 作答中仅中性选中高亮；新增「上一题」回看改选；提交前校验全部作答并定位未答题；移除连胜徽章/对错提示/即时判题 |
| 答题反馈 | `pages/quiz-result/*` | 新增「答题详情」：题干、我的答案、正确答案、对错、每题得分、解析；历史记录无 details 时回退错题回顾 |
| 答题反馈 | `services/quiz.js` | 删除 `checkAnswer` |
| 后端 | `quiz_service.submit` / `routes/quiz.py` / schemas / models | 移除 `/api/quiz/check`；题目不下发 answer/analysis；提交须恰好覆盖今日全部题目、不重复、选项合法；逐题结果落库 `quiz_records.details`；唯一约束兜底并发重复提交，积分仅在首个提交成功后发放 |

## 小程序验收（真实开发者工具，8/8 通过）

| 用例 | 结果 | 说明 |
| --- | --- | --- |
| M01 我的页无「账号与绑定」入口 | PASS | 入口：我的长征/行军日历/组织架构/运动记录/答题记录/我的勋章，无空白行 |
| A01 答题页 5 题且不含答案/解析 | PASS | 页面题目对象与 `/quiz/daily` 响应均无 answer/analysis |
| A02 选择后仅中性高亮 | PASS | 仅 1 个 `option selected`；无 `opt-correct/opt-wrong/streak-badge/check-tip`；data 无判题字段 |
| A03 同题改选 | PASS | 改选覆盖 |
| A04 未选择不可下一题 | PASS | 停留当前题 |
| A05 上一题回看 | PASS | 回到第 1 题并回显已选答案 |
| A06 未答完提交拦截 | PASS | 定位到第 2 题，后端 `completed=false` 未生成记录 |
| A07 结果页逐题详情 | PASS | 60 分 3 对 2 错；5 条详情 verdict「✓正确·20分 ×3 / ✗错误·0分 ×2」，我的答案/正确答案与题库一致 |

截图：`../images/40-v12-mine.png`、`../images/41-v12-quiz-answering.png`、`../images/42-v12-quiz-result.png`

## 后端（14/14 通过）

Q01 不下发答案与解析 / Q02 同日同套 / Q03 `/quiz/check` 404 / Q04 缺题与空答案 400 / Q05 非今日题 400 / Q06 重复同题伪造满分 400 /
Q07 非法选项 400 / Q08 逐题判分（乱序提交按抽题顺序）/ Q09 重复提交 400 积分不重复 / Q10 daily 含 details、records 不含 /
Q11 满分 100 分积分 15 / Q12 8 线程并发提交仅 1 成功、积分仅一次 / Q13 历史无 details 记录原样返回不重算 / Q14 未登录 401。
结果文件：`backend/test/s18-quiz-feedback-results.json`。

## 遗留说明

- 旧脚本 `backend/test/p1_persons.py`、`backend/test/e2e_full_flow.py`、`frontend/test/automator/p1-persons-quiz.cjs` 依赖已移除的 `/quiz/check`（连胜反馈用例），按新需求已不适用，未重跑；其历史报告保留为当时版本记录。
