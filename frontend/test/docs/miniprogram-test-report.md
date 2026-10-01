# 小程序测试报告 —— 长征主题小程序全功能（frontend/，13 页面 + 9 服务）

- 测试日期：2026-10-01
- 测试人：自动化验收（Qoder）
- 被测对象：`frontend`（原生微信小程序，WXML/WXSS/JS，无构建工具；tabBar 5 项：首页/长征/答题/排名/我的）
- **总体结论：27/27 验证项通过，2 个缺陷（F1/F2，均为未登录深链崩溃）**
- 测试方式：微信开发者工具自动化（automator，`ws://127.0.0.1:9420`）模拟真实用户操作，断言页面 `data`、元素属性与控制台日志；视觉证据由独立脚本 `shots-tour.cjs` 复现 16 个页面状态补拍，截图存于 `frontend/test/images/`
- 数据环境：后端 FastAPI `http://127.0.0.1:8010/api` 真实参与（登录 `/auth/login`、路线节点 `/march/route-nodes`）；其余服务（quiz 判分 / org / rank / sport / points / medal）为前端本地 mock（与 `mock/data.js` 种子一致）
- 关联报告：`backend/test/docs/backend-test-report.md`、`admin/test/docs/frontend-test-report.md`

## 1. 覆盖范围与结论

| 模块 | 页面/服务 | 验证项 | 结论 |
| --- | --- | --- | --- |
| 登录 | login + auth | 冷启动守卫、真实后端登录（JWT）、跳组织选择 | ✅ T01/T02 |
| 组织选择 | org-select + org | 根层级、逐级下钻、面包屑回跳、任意层级选定、我的页改组织 | ✅ T03a–e / T14 |
| 首页运动 | home + sport | 步数同步、+2000 演示、进度点亮、答题入口徽标 | ✅ T04a–c |
| 长征路线 | march + march | 10 节点（真实后端）、实景/星空 Canvas 双模式 | ✅ T05a/b |
| 节点详情 | node-detail | 遵义节点信息与状态 | ✅ T06 |
| 每日答题 | quiz / quiz-answer / quiz-result | 满分链路、重置、零分链路、已完成态、积分规则 | ✅ T07a–c / T08a/b |
| 排行榜 | rank | 19 人总榜、我的高亮、步数一致性 | ✅ T09 |
| 我的 | mine | 统计一致性、四个功能入口 | ✅ T10a |
| 记录页 | sport-records / quiz-records | 步数与答题记录 | ✅ T11 / T12 |
| 勋章 | medals | 6 枚勋章、首步勋章必得 | ✅ T13 |
| 退出登录 | mine + auth | token 清除、回登录页 | ✅ T15 |
| 未登录深链 | quiz-result / quiz-answer | 路由守卫 | ❌ F1/F2 缺陷（详见第 3 节） |

## 2. 详细结果

以下全部为 automator 运行时断言的实测值（原始记录见 `frontend/test/automator/results-p1..p5.json` 与汇总 `results.json`，控制台日志见 `console-log.json`）。

### 2.1 登录与组织选择

| 项 | 断言 | 实测 |
| --- | --- | --- |
| T01 | 冷启动进入登录页 | `path=pages/login/login`，`lm_auth_token=""` |
| T02 | 登录成功并跳组织选择 | 真实 `POST /auth/login`（wx.login code 换 JWT），落 `pages/org-select/org-select` |
| T03a | 组织根层级加载 | 根层级=长征集团总部 |
| T03b | 下钻总部→华东分公司 | 第二层=市场部, 技术部, 运营部 |
| T03c | 下钻技术部 | 第三层=前端组, 后端组 |
| T03d | 面包屑回跳根层级 | 回跳后=长征集团总部 |
| T03e | 选定前端组并进入首页 | `orgFullName=长征集团总部 / 华东分公司 / 技术部 / 前端组` |

### 2.2 首页运动

| 项 | 断言 | 实测 |
| --- | --- | --- |
| T04a | 同步微信步数 | steps=5679（before=0），点亮 2/10 节点，进度 57%，`syncError` 为空 |
| T04b | 演示按钮 +2000 步 | 5679+2000=7679 |
| T04c | 首页今日答题入口状态 | 剩余题数=5 |

### 2.3 长征路线与节点详情

| 项 | 断言 | 实测 |
| --- | --- | --- |
| T05a | 路线节点加载（后端 route-nodes） | mode=real，nodes=10，lit=2，selected=四渡赤水 |
| T05b | 切换星空插画模式 | mode=canvas |
| T06 | 节点详情页（遵义） | name=遵义，status=completed |

### 2.4 每日答题

| 项 | 断言 | 实测 |
| --- | --- | --- |
| T07a | 答题首页未完成状态 | completed=false |
| T07b | 满分提交（答对 5 题） | score=100，correct=5/5，points=15（+5 每日答题，+10 满分） |
| T07c | 答题页已完成态 | completed=true，score=100，correct=5/5（返回答题 Tab 后 `record` 正确展示） |
| T08a | 开发调试重置今日答题 | 确认弹窗后 completed=false（记录、题目缓存与积分一并撤销） |
| T08b | 零分提交（全答错） | score=0，correct=0/5，points=5 |

### 2.5 排行榜 / 我的 / 记录页 / 勋章

| 项 | 断言 | 实测 |
| --- | --- | --- |
| T09 | 排行榜（本用户 + 18 名模拟成员） | list=19，myRank=17，mySteps=7679，本人行高亮 |
| T10a | 我的页统计一致性 | steps=7679，lit=2，quiz=1，points=31 |
| T11 | 运动记录页 | totalSteps=7679 |
| T12 | 答题记录页 | 同日满分+零分两次作答仅留 1 条（2026-10-01: 0分）——记录按 userId+date 唯一 |
| T13 | 勋章墙 | 6 枚勋章，owned=1/6，`first-step`（首次同步必得）在列 |

### 2.6 组织修改 / 退出登录 / 未登录深链（缺陷复现）

| 项 | 断言 | 实测 |
| --- | --- | --- |
| T14 | 我的页修改组织为后端组 | `orgFullName=长征集团总部 / 华东分公司 / 技术部 / 后端组`（1→2→6→13 逐级下钻后选定） |
| T15 | 退出登录 | 确认弹窗后 `lm_auth_token` 已清空，回到登录页 |
| T16a | 未登录深链 quiz-result | 停留页=quiz-result，异常日志 2 条 → **F1** |
| T16b | 未登录深链 quiz-answer | 停留页=quiz-answer，异常日志 2 条，题目未渲染 → **F2** |

### 2.7 跨页一致性（同一测试用户贯穿全部阶段）

- **步数 7679** 在首页（T04b）、排行榜（T09）、我的（T10a）、运动记录页（T11）四处完全一致。
- **积分流水 31 分可精确对账**：每日登录 +1、每日运动达 5000 步 +5、点亮节点 ×2 +20、答题净 +5（满分 +15 → 重置撤销 → 零分 +5）= 31，与 T10a 实测一致。
- 排行榜 19 人（18 名 mock 成员 + 本用户）、勋章 6 枚与 `mock/data.js` 种子一致；勋章的「飞夺泸定桥=节点 6、翻越雪山=节点 7」映射与后端 route-nodes id 1-10 核对无误。

## 3. 缺陷清单

### F1【中】未登录状态深链 quiz-result 页 onLoad 直接崩溃（缺少登录守卫）
- 位置：`frontend/pages/quiz-result/quiz-result.js:22`
- 代码：`onLoad() { const daily = quiz.getDaily(app.globalData.user.id); ... }` — 未登录时 `app.globalData.user === null`，读取 `.id` 抛 `TypeError`，页面停留在空白/异常态，未跳回登录页。
- 复现：退出登录后 `reLaunch /pages/quiz-result/quiz-result`（如通过分享链接/扫码深链）。
- 实测证据（T16a，2026-10-01）：
  - 页面停留 `pages/quiz-result/quiz-result`，未跳转登录页；
  - 控制台异常 2 条：`TypeError: MiniProgramError — Cannot read properties of null (reading 'id')`；
  - 截图：`frontend/test/images/15-deeplink-quiz-result.png`。

### F2【中】未登录状态深链 quiz-answer 页 onLoad 直接崩溃（同类缺守卫）
- 位置：`frontend/pages/quiz-answer/quiz-answer.js:22`，同一模式。
- 实测证据（T16b，2026-10-01）：
  - 页面停留 `pages/quiz-answer/quiz-answer`，未跳转登录页；
  - 控制台异常 2 条：同一 `TypeError: Cannot read properties of null (reading 'id')`；
  - 题目未渲染（`current` 为空，页面不可用）；
  - 截图：`frontend/test/images/16-deeplink-quiz-answer.png`。

### 根因与修复建议（F1/F2 共用）
项目架构不变量即「前端非 tab 页无全局路由守卫，每个子页 onLoad/onShow 需自行判断登录态」——quiz-result 与 quiz-answer 两个子页恰好漏判。建议：
1. 短期：两页 onLoad 首行加 `if (!app.globalData.user) { wx.reLaunch({ url: '/pages/login/login' }); return; }`。
2. 长期：在 app.js 或封装 `requireLogin()` 工具中做子页面白名单守卫，避免逐页遗漏。

## 4. 架构观察（非缺陷，正式接入后端时需关注）

1. **双轨混合数据源**：`services/` 中仅 auth（登录）与 march（路线节点）经 `services/request.js` 调真实后端（`config.js` `API_BASE_URL = http://127.0.0.1:8010/api`）；quiz 判分、org、rank、sport、points、medal 仍为前端本地 mock。mock 服务注释已预留对应后端接口（如 `rank.js` 对应 `GET /api/rank/steps`、`org.js` 对应 `/api/org/children|mine|select`），正式接入时页面调用方无需改动。当前后果：**答题判分在客户端完成**（`quiz.js` 直接读取 `QUESTION_BANK` 答案），题目与答案随代码包分发，可被破解刷分；接入后端判分前不可用于真实激励场景。
2. **步数为确定性种子值**：`sport.syncToday` 使用 `util.seededSteps(date, userId)` 生成当日步数（自动化环境无微信运动授权），同一用户同一天数值恒定——利于测试复现，正式版需接 `wx.getWeRunData` + 后端解密。
3. **防御性死分支**：`quiz-answer.js:29` 的 `!daily.questions` 分支在当前实现下不可达（`getDaily` 未完成时必生成题目缓存），保留无害。
4. **勋章-路线节点映射已核对**：`medal.js` 中 `飞夺泸定桥=6`、`翻越雪山=7` 与后端 `route-nodes` id 1-10 完全一致（本次专项验证项，无缺陷）。

## 5. 测试环境说明与证据效力

1. **执行方式**：微信开发者工具 CLI 开启自动化端口（`cli.bat auto --project D:/project/longmarch-run --auto-port 9420`），`miniprogram-automator` 以 5 个独立短阶段驱动（长会话会阻塞 IDE 自动化桥；阶段间整体重启 IDE，避免残留 IDE 进程抢占自动化端口）。每条命令 20s 硬超时 + 每阶段看门狗强制落盘，结果可复核（`frontend/test/automator/results-p1..p5.json` → `results.json`，27/27）。
2. **同一用户贯穿**：登录态（`lm_auth_token`）在各阶段间保留，阶段 1–5 复用同一测试用户，故 2.7 节的跨页数值一致性与积分对账在同一次会话内成立。登录走真实 `POST /auth/login`；本次会话后端新增测试用户若干（昵称「自动化测试员」）。
3. **截图与断言分离**：实测发现任何 automator `screenshot` 调用都会使自动化桥进入退化状态（后续命令报 not on top / 超时），故断言阶段完全不截图（`ui-test.cjs` 的 `shot()` 为空操作）；视觉证据由独立的 `shots-tour.cjs` 在断言全部落盘后复现 16 个页面状态补拍（每状态独立连接 + 自动重启自动化端口）。两张深链缺陷截图（15-/16-）即崩溃现场实拍。
4. **mock 弹窗**：退出登录、重置今日答题的 `wx.showModal` 确认框以 `mockWxMethod` 自动确认，验证的是确认分支；取消分支未覆盖（低风险）。
5. **IDE「无法检测代码问题」为假阴性**（已知工具限制），本报告全部结论基于 automator 运行时行为 + 控制台日志，不依赖 IDE 静态检查。
6. **测试脚本自校正说明**：执行期间修正了 3 处测试脚本自身断言错误（答题页已完成态读取不存在的 `quizScore` 字段 → 实为 `record.score`；勋章页 `medalList` → 实为 `medals`；`waitFor` 以真值判断导致 `completed=false`、`displayScore=0` 等合法假值永不返回），修正后全部通过——以上均为测试代码问题，非被测小程序缺陷，小程序行为始终与页面数据结构一致。
7. 测试残留：后端新增测试用户若干（自动化登录产生）；前端 storage 已在收尾清空回登录页。

## 6. 修复优先级建议

1. **P1**：F1/F2 未登录深链崩溃 —— 补登录守卫（两处一行修复）。已在运行时复现并留有崩溃日志与截图证据。
2. **P2**：答题判分本地化（第 4 节观察 1）—— 正式上线激励前必须后端判分。
3. 参见后端报告 P0（BUG-B1/B2/B3）与本报告无交叉阻塞：小程序侧登录/路线均正常。
