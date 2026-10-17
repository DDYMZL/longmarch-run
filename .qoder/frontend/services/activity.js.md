# activity.js

## 1. 文件路径

`frontend/services/activity.js`（30 行）

## 2. 文件职责

活动状态服务层薄封装：拉取活动名称/状态/起止时间/准入标记/结束文案，并把结果缓存到 `app.globalData.activity` 供各页读取（docstring `frontend/services/activity.js:1-3`、`:8`）。状态由后端按服务器时间实时计算，业务接口同样在后端拦截，前端仅用于展示与引导（`:3`）。

## 3. 业务需求

V2.0「活动状态页与查看拦截」批次交付（提交 `44eb77b`，`docs/迭代记录.md` 的 `44eb77b` 条目），本文件由该提交创建（`git log --follow` 仅此 1 个提交）。

## 4. 核心功能

| 函数 | 行号 | 后端接口 | 说明 |
|---|---|---|---|
| `getStatus()` | `:12-17` | `GET /api/activity/status` | 拉取活动状态并写入 `getApp().globalData.activity`（`:14`）后原样返回 |
| `formatRange(status)` | `:20-25` | 无（纯函数） | ISO 时间（带 +08:00）截为 `YYYY-MM-DD HH:mm`，拼「start 至 end」，任一缺失返回 `''` |

- 请求经 `services/request.js`（`:5`），URL 拼接为 `API_BASE_URL + opts.url`（`frontend/services/request.js:69`）。
- `getStatus` 带 `skipActivityRedirect: true`（`:13`）：request.js 对活动拦截的 GET 请求默认自动跳转活动状态页（`frontend/services/request.js:125`、`:134`），本接口自身就是活动状态页的数据源，跳过该跳转以避免自引用循环。
- `formatRange` 用字符串截取（`slice(0,16).replace('T',' ')`，`:21`），隐含假设后端返回 ISO 格式时间串。

## 5. 输入与输出

- `getStatus()`：无参；返回 `{name, status, statusText, startAt|null, endAt|null, allowParticipate, allowView, restrictEnabled, endTitle, message, serverTime}`（JSDoc `:9-10`）。
- `formatRange(status)`：入参为上述状态对象（容错 null，`:22-23`）；返回展示文本或 `''`。
- 异常：由 request.js 统一 reject（401 静默重登重试一次，`frontend/services/request.js:122-123`）；调用方均自行 catch（§6）。

## 6. 依赖关系

- 依赖：仅 `services/request.js`（`:5`）。缓存写 `app.globalData.activity`（内存级，`:14`），**不写 Storage、不经 `services/store.js`**。
- 被依赖（grep `services/activity`）：
  - `frontend/pages/home/home.js:15`（`:166` 调 `getStatus().catch(() => null)`，失败不展示横幅；`:31` 调 `formatRange`）；
  - `frontend/pages/activity/activity.js:6`（`:32` `getStatus`，`:39` `formatRange`，活动状态页本体）；
  - `frontend/pages/launch/launch.js:16`（`:112` `getStatus`，启动时活动准入判断）。
- 后端契约文档：`.qoder/backend/app/api/routes/activity.py.md`。

## 7. 业务规则

1. 活动状态判定（未开始/进行中/已结束、allowParticipate/allowView）全部在后端计算，前端不自行比对时间（`:3`）；本服务只是读取与转发。
2. `globalData.activity` 缓存仅在 `getStatus` 成功后更新；各页读取该缓存时应理解其可能为旧值或缺失，最新状态需重新调用（代码未提供失效机制）。

## 8. 修改约束

1. 不得移除 `skipActivityRedirect: true`（`:13`），否则活动结束时本请求会触发 request.js 的活动拦截跳转（`frontend/services/request.js:134`），活动状态页/启动流程可能循环跳转。
2. 返回结构 camelCase 硬契约（`backend/AGENTS.md` §4.1），改字段需与后端及三个消费页同步。
3. `formatRange` 若后端时间格式变更（非 ISO 带时区），截取逻辑失效，需同步修改。

## 9. 当前实现状态

- 已实现：两个导出均有真实调用方（§6），无死代码。
- 待开发：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/activity.js`，共 **1 个提交**。

### 2026-10-13（`44eb77b`，13:25）
- 需求：V2.0 小程序批次——活动状态页与查看拦截。
- 修改内容（涉本文件）：创建本文件（`getStatus`/`formatRange`）；同批交付活动状态页 `pages/activity/`（提交信息为唯一证据）。
- 关联文件：`frontend/pages/activity/activity.js`、`frontend/pages/home/home.js`、`frontend/pages/launch/launch.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（v2 自动化验收 14/14）。
