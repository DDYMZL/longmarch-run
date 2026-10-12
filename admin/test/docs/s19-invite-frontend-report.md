# 小程序邀请码扫码准入 测试报告（frontend）

日期：2026-10-12 ｜ 范围：frontend ｜ 语法校验：`node --check` ✓

## 覆盖范围

需求 1 的小程序侧改造：
- 启动页改为「扫邀请码准入」落地页（原通用入驻码落地逻辑废除）
- 新增入驻页 `pages/onboard/onboard`（姓名 + 组织）
- `services/auth.js` 改为状态式登录（active/unregistered/disabled），新增邀请码校验/入驻方法
- `services/request.js` 增加 `X-Account-Status: disabled` 识别，禁用用户不走 401 重登
- 组织选择页 `org-select` 新增 `pickMode=onboard` 范围锁定与 `eventChannel` 回传

## 节点语法校验

```
node --check frontend/services/auth.js        OK
node --check frontend/services/request.js     OK
node --check frontend/pages/launch/launch.js  OK
node --check frontend/pages/onboard/onboard.js OK
node --check frontend/pages/org-select/org-select.js OK
node --check frontend/pages/login/login.js    OK
```

## 功能预期（后端用例已验证，前端路径对照）

| ID | 流程 | 关键代码 | 后端对应用例 |
| --- | --- | --- | --- |
| F01 | 冷启动 → 已登录 → 直达首页 | `launch.js: ensureLogin → active` | I01（反面） |
| F02 | 未扫码进入 → 停留启动页 blocked 态「仅对受邀人员开放」+ 重新扫码/退出 | `launch.wxml .block-title` + `onRescan/onExit` | I01 |
| F03 | 扫邀请码进入 → verify 通过 → 跳 onboard 填写姓名+组织 | `parseInviteFromScene(scene)` + `auth.verifyInvite` | I07 |
| F04 | 入驻提交 → `auth.onboard` → 建号 → switchTab 首页 | `onboard.js submit` | I08 |
| F05 | 邀请码过期/停用/用满 → 启动页 blocked 态提示 | `handleUnregistered` 400 分支 | I04/I05/I06 |
| F06 | 专属码越界：onboard 页组织树只允许 rootId 子树 | `org-select.js pickMode + stack 底锁 root` | I09 |
| F07 | 已入驻用户再扫同码：ensureLogin active 直接进首页 | ensureLogin 分支 | I10 |
| F08 | 账号停用：业务接口 403 X-Account-Status: disabled → clearSession reLaunch 启动页 disabled 态 | `request.js send 回调` + `launch.js phase=disabled` | I15 |
| F09 | Token 过期：401 → 单飞 relogin → active 复用用户继续原请求 | `auth.relogin` + `request.js 401` | I25 |
| F10 | 手动登录页捕获 admission → reLaunch 启动页分流 | `login.js catch` | — |

## 未执行项

本次 CI 无微信开发者工具 automator，启动页三种态（loading/disabled/blocked）、入驻页组织选择
与提交的真机/模拟器截图未产出；小程序侧全链路需在开发者工具真机预览或 trial 包真扫码验收，
scene 长度 ≤ 32 字符已在后端 I21 用例校验（`i=GTkppfR5g0s0TLza` 共 18 字符）。

## 关联变更

- 新增：`frontend/pages/onboard/onboard.{js,json,wxml,wxss}`
- 修改：`frontend/services/auth.js`（callLogin / wxLogin / relogin / ensureLogin /
  verifyInvite / onboard / savePendingInvite 等）
- 修改：`frontend/services/request.js`（header 解析，disabled 短路）
- 修改：`frontend/pages/launch/{launch.js,launch.wxml,launch.wxss}`（parseInviteFromScene、
  blocked/disabled 三态）
- 修改：`frontend/pages/login/login.js`（admission 捕获 reLaunch）
- 修改：`frontend/pages/org-select/org-select.{js,wxml}`（pickMode / rootId / eventChannel）
- 修改：`frontend/app.json`（注册 onboard 页）
