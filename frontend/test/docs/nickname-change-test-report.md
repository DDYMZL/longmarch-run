# 小程序测试报告 —— 微信授权登录（无昵称输入框）与昵称修改（每人仅一次）

- 测试日期：2026-10-01
- 测试人：自动化验收（Qoder）
- 测试方式：微信开发者工具 automator 自动化（自动化端口 9420）+ 语法检查 + 截图补拍
- 测试脚本：`frontend/test/automator/nickname-test.cjs`（可重复执行）
- 证据文件：`frontend/test/automator/results-nickname.json`、`frontend/test/images/mine-nickname-changed.png`
- 关联需求：
  1. 登录页不展示昵称输入框，选择微信登录后直接进入组织选择（昵称默认「长征小战士」）；
  2. 进入后可修改名称，一个人只允许修改一次。

## 1. 测试环境

| 项 | 值 |
| --- | --- |
| 后端 | FastAPI `http://127.0.0.1:8010`（真实链路，非 Mock） |
| 微信开发者工具 | 自动化端口 9420（ws 连接），`wx.login` 以 mockWxMethod 固定 code → 后端 mock openid 派生新测试用户 |
| 测试用户 | 每轮全新用户（本轮 code=`nickname-auto-<时间戳>`） |

## 2. 结论摘要

**9 / 9 全部通过**，无阻塞缺陷。

| 用例 | 结果 | 关键断言 |
| --- | --- | --- |
| M01 冷启动进入登录页 | ✅ | 登录态已清空 |
| M01b 登录页不展示昵称输入框 | ✅ | `.nickname-input` 元素数量为 0 |
| M02 微信授权登录并跳组织选择 | ✅ | 点击登录直达 org-select（无需填写昵称） |
| M03 mine 页展示默认昵称且未改名 | ✅ | nickname=长征小战士，nicknameChangedAt=null |
| M04 昵称修改入口展示 | ✅ | 昵称旁「✎ 修改昵称」 |
| M05 首次修改昵称成功并记录时间 | ✅ | 弹窗输入「新昵称乙」→ nickname 更新且 nicknameChangedAt 非空 |
| M06 二次修改被拦截 | ✅ | 再次触发修改昵称不变（前端兜底拦截 + 后端 400 兜底） |
| M07 重登后昵称保持改后值 | ✅ | 以微信名重新登录，昵称仍为「新昵称乙」 |
| M08 已改名用户不再显示修改按钮 | ✅ | 昵称旁修改按钮整体隐藏（wx:if 按 nicknameChangedAt） |

## 3. 视觉证据

`frontend/test/images/login-no-nickname.png`：登录页无昵称输入框，仅「微信授权登录」按钮。
`frontend/test/images/mine-nickname-changed.png`：mine 页昵称「新昵称乙」，昵称旁不再显示修改按钮。

## 4. 回归验证

- 改动 JS 均通过 `node --check`：`services/auth.js`、`pages/login/login.js`、`pages/mine/mine.js`；
- 既有后端 e2e 套件 23/23 通过（见 `backend/test/docs/nickname-change-test-report.md`）。

## 5. 变更清单

| 文件 | 变更 |
| --- | --- |
| `pages/login/login.wxml/js` | 移除昵称输入框与校验；微信授权登录（选头像）后直接登录，无组织则跳组织选择 |
| `services/auth.js` | 新增 `updateNickname(name)` → `PUT /api/auth/nickname`，成功后合并本地登录态 |
| `pages/mine/mine.wxml/js/wxss` | 昵称旁修改入口仅在未修改过时展示，弹窗明确提示「昵称仅可修改一次」；已改名（nicknameChangedAt 有值）整块隐藏 |
