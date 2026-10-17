# store.js

## 1. 文件路径

`frontend/services/store.js`（51 行）

## 2. 文件职责

**遗留数据迁移工具**，不是通用缓存层：Mock 时代业务数据写在本地 Storage 键 `lm_data_{userId}` 下，切换到真实后端后业务数据全部落库 openGauss，本文件仅保留一个函数 `migrateUserData`——登录时把旧 Mock 用户 ID 名下的本地数据**一次性复制**到后端真实用户 ID 名下（`frontend/services/store.js:1-14` 模块 docstring）。`frontend/AGENTS.md` §3 目录表对本文件的定位即「遗留：仅登录数据迁移（migrateUserData）」。

## 3. 业务需求

- 来源：`b0fd8b2`（2026-10-01）「小程序由本地 Mock 切换为真实后端接口」——切换期存量用户的本地步数/答题/积分等数据需要跟随新用户 ID（`docs/迭代记录.md` 的 `b0fd8b2` 条目）。
- `b467a8a`（2026-10-02）「移除 util/store 中零引用的 Mock 时代死代码」后，本文件从完整 Mock 存储层收缩为仅剩迁移职责（`docs/迭代记录.md` 的 `b467a8a` 条目）。

## 4. 核心功能

### 4.1 管理的 Storage 键（全部清单）

| 键 | 行号 | 读/写 | 说明 |
|---|---|---|---|
| `lm_data_{userId}`（前缀常量 `KEY_PREFIX = 'lm_data_'`） | `:15` | 读 + 写 | 旧 Mock 用户数据；结构 `{dailySport, litNodes, quizRecords, pointsLog, medals, firstSyncAt}`（docstring `:5-13` 与 `emptyData():18-27` 一致） |

**本文件只管理这一个键族**；登录态键 `lm_login_user`/`lm_auth_token`/`lm_logged_out` 归 `auth.js`/`request.js`（`frontend/AGENTS.md` §2 数据行、§4.3），不在本文件出现。**TTL/失效策略：无**——迁移是幂等的一次性复制，源键 `lm_data_{fromUserId}` 复制后**不删除**，Storage 中永久残留（代码事实：`:35-47` 无任何 `removeStorageSync`）；是否清理属产品决策，**待确认**。

### 4.2 `migrateUserData(fromUserId, toUserId)`（`:35-47`）

返回 boolean（是否实际执行了复制）。判定链：

1. 任一 id 缺失，或 `String(fromUserId) === String(toUserId)` → `false`，不迁移（`:36`）；
2. 目标键 `lm_data_{toUserId}` 已存在且为对象 → `false`，**不覆盖**（`:38-39`，JSDoc `:30`「目标已有数据则不覆盖」）；
3. 源键不存在或非对象 → `false`（`:40-41`）；
4. 写入 `Object.assign(emptyData(), source)`——用 `emptyData()` 补齐源数据缺失字段后落盘，返回 `true`（`:42-43`）；
5. 整体 try/catch，**任何 Storage 异常静默吞掉返回 `false`**（`:44-46`），迁移失败不阻断登录。

## 5. 输入与输出

- 输入：`fromUserId`/`toUserId`，`string|number` 均可（内部 `String()` 归一比较，`:36`）。
- 输出：`boolean`；无 Promise、无异常抛出（全部 catch）。
- 副作用：至多一次 `wx.setStorageSync`（`:42`）。

## 6. 依赖关系

- 依赖：仅 `wx.getStorageSync`/`wx.setStorageSync` 宿主 API；**不依赖 request.js/config.js**，纯本地操作。
- 被依赖（grep `migrateUserData|services/store` 全量核实，测试目录除外）：**唯一调用方 `frontend/services/auth.js`**，两处，条件相同——`previousUser` 存在且 `previousUser.id !== result.user.id` 时以旧 id → 新 id 调用：
  - `frontend/services/auth.js:103`：`/auth/login` 静默/自动登录成功分支；
  - `frontend/services/auth.js:208`：带 `inviteCode/nickname/orgId` 的手动登录成功分支。
- **零调用方导出**：无（唯一导出即 `migrateUserData`，`:49-51`）。

## 7. 业务规则

1. **刷新/失效不变量**：本文件写入的 `lm_data_*` 是**死数据**——后端切换后没有任何 service 或页面再读取它（`frontend/AGENTS.md` §4.2 明确「新增服务不得读写 `lm_data_{userId}`」，该文档为此规则的权威出处，本文档不复述其正文）。因此**不存在「写后须失效谁」的义务**：业务数据的唯一数据源是后端，写操作（sync/submit/light-up 等）后各页面靠「`onShow` + `refresh()`」从后端重拉（`frontend/AGENTS.md` §4.1），与本地 Storage 无关。
2. 迁移仅发生在「本地记录的旧用户 id ≠ 本次登录返回的后端用户 id」时（`auth.js:102`、`:207` 的前置判断），同一用户重复登录不触发。
3. 不覆盖原则（§4.2 第 2 条）保证多次登录、多设备场景下目标数据不被旧数据回写污染。

## 8. 修改约束

1. **禁止扩大职责**：不得把本文件改回通用缓存层或让新代码读写 `lm_data_{userId}`（`frontend/AGENTS.md` §4.2 不变量）；业务数据本地持久化违反「后端是唯一数据源」（`frontend/AGENTS.md` §3.1）。
2. 页面层不得直接读写 Storage（`frontend/AGENTS.md` §3.1），调用本函数的入口只应是 `auth.js` 登录链路。
3. 若删除本文件，须同步处理 `auth.js:103`、`:208` 两处调用；由于 Mock 时代用户已随时间自然消化，本模块属「可评估下线」的遗留代码——下线时机**待确认**（无需求文档记载保留期限）。

## 9. 当前实现状态

- **已实现**：`migrateUserData` 完整可用；死代码清理已于 `b467a8a` 完成（§3）。
- **存在问题 / 已知事项**：
  1. 迁移后源键 `lm_data_{fromUserId}` 与目标键均永久残留于 Storage，无清理逻辑（§4.1，代码事实）；小程序 Storage 单键/总量上限下一般无害，是否补清理**待确认**。
  2. 异常静默吞掉（`:44-46`）意味着迁移失败无任何日志可查——现状事实，是否加 `console.warn` **待确认**。
- **待开发**：无（遗留模块，只做收缩不做增强）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/store.js`，共 **3 个提交**；均已核对存在于 `docs/迭代记录.md`。按时间倒序。

### 2026-10-02（`b467a8a`，14:32）
- 需求：清理 Mock 时代零引用死代码。
- 修改内容（涉本文件）：删除 Mock 存储层其余函数，仅保留 `migrateUserData` 与 `emptyData`（提交信息「移除 util/store 中零引用的 Mock 时代死代码」）。
- 关联文件：`frontend/utils/util.js`（同批清理）。
- 测试结果：见 `docs/迭代记录.md` 的 `b467a8a` 条目。

### 2026-10-01（`b0fd8b2`，10:31）
- 需求：小程序由本地 Mock 切换为真实后端接口。
- 修改内容（涉本文件）：业务数据读写职责移交后端接口，本文件转为登录时旧数据迁移工具（提交信息；现文件 docstring `:1-3` 与之对应）。
- 关联文件：`frontend/services/auth.js`、`frontend/services/request.js` 及全部业务 service。
- 测试结果：见 `docs/迭代记录.md` 的 `b0fd8b2` 条目。

### 2026-09-30（`a94e685`，18:05）
- 需求：项目初始化。
- 修改内容（涉本文件）：创建 `store.js`（Mock 时代本地存储层，后经 `b467a8a` 收缩）。
- 关联文件：全仓库初始提交。
- 测试结果：初始化提交，无独立测试记录（提交信息为唯一证据）。
