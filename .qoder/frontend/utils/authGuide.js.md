# authGuide.js

## 1. 文件路径

`frontend/utils/authGuide.js`（64 行）

## 2. 文件职责

小程序**权限授权引导**的唯一落点：封装 `wx.getSetting → wx.showModal → wx.openSetting → 复检` 这条「用户已拒绝授权后如何再拿到权限」的固定链路，导出单函数 `ensureScope(scope, tipText)`（`:22-62`、`:64`）。

小程序的硬约束是：用户**明确拒绝**过某个 `scope` 后，再次调用 `wx.authorize` 会**直接失败且不再弹窗**，只能引导用户去「设置」页手动开启——这段引导代码此前散落在各页面，本文件将其收敛为一处（`frontend/AGENTS.md` §5.1「禁止在多个 service 复制同一工具函数」的同类要求）。

CommonJS 模块，**无状态、无内部依赖**：不 require 任何本仓模块（`:1-64` 全文无 `require`），只调 `wx.getSetting` / `wx.showModal` / `wx.openSetting` 三个原生 API；不读写 Storage、不发网络请求、不触碰 `getApp()`。

## 3. 业务需求

「十项增强」点 3——**`ensureScope` 统一 openSetting 授权引导**（`docs/迭代记录.md` 的 `53f2d62` 条目，2026-10-18）。涉及两类权限、四个业务场景：

| 权限 scope | 业务场景 | 拒绝后的后果 |
| --- | --- | --- |
| `scope.werun` | 微信运动步数同步（行军步数的唯一数据来源，需求 §3 步数体系） | 无法同步行军步数 → 路线不推进、节点不点亮 |
| `scope.writePhotosAlbum` | 长征完成仪式画面（需求 §20）与节点纪念票（需求 §19）保存到相册 | 无法保存分享图 |

文件头 docstring（`:1-11`）即写明这两类使用场景与调用范式。

## 4. 核心功能

### 4.1 `ensureScope(scope, tipText) → Promise<boolean>`（`:22-62`）

整体是一个 `new Promise((resolve) => ...)`（`:23`），**永不 reject**——所有失败分支都 `resolve(false)`（见 §7 第 3 条），调用方只需判真假。

以 `wx.getSetting` 的 `authSetting[scope]` 三态分流（`:24-60`）：

| # | `authSetting[scope]` | 行为 | 行号 | 返回 |
|---|---|---|---|---|
| 1 | `true`（已授权） | 不做任何交互，直接返回 | `:27-31` | `resolve(true)` |
| 2 | `false`（**已明确拒绝**） | 弹窗引导 → 用户确认 → `wx.openSetting` → 复检设置页结果 | `:32-55` | 见下表 |
| 3 | `undefined`（**从未请求过**） | 不弹窗、不 authorize，交回调用方自行触发 `wx.authorize` 首次授权弹窗 | `:56-57` | `resolve(false)` |
| 4 | `wx.getSetting` 自身 `fail` | 静默降级 | `:59` | `resolve(false)` |

分支 2 的弹窗与二级链路（`:34-53`）：

- `wx.showModal`：标题固定「权限未开启」，正文用调用方传入的 `tipText`（空则回退通用文案「该功能需要相关权限，请在设置中开启后重试。」，`:36`），按钮「去开启 / 暂不」（`:37-38`），确认键颜色 `#C8102E`（长征红，与 `frontend/AGENTS.md` §2 约定主色一致，`:39`）。
- 用户点「暂不」或弹窗 `fail` → `resolve(false)`（`:41-44`、`:52`）。
- 用户点「去开启」→ `wx.openSetting`，**成功回调里以设置页返回的 `authSetting[scope]` 复检**（`!!` 归一为布尔，`:45-48`），失败 → `resolve(false)`（`:49`）。即返回值是「用户在设置页真的打开了开关」的**最终状态**，不是「跳转成功」。

### 4.2 三态语义与调用方的两种用法

`resolve(false)` **有两种含义**（已拒绝后用户没开 / 从未请求过），调用方据此分成两类用法：

1. **首次授权链（服务层）**：`services/sport.js` 先 `ensureScope`，`false` 时自行 `wx.authorize` 弹首次授权窗，授权完成（无论成败）后**再调一次 `ensureScope` 复检**（`frontend/services/sport.js:23-38`）——第二次调用命中的是分支 1 或分支 2，从而把「刚拒绝」的用户也带进设置页引导。
2. **重试入口（页面层）**：首页步数同步失败提示条上的「去授权」直接 `ensureScope(...).then(granted => granted && this.handleSyncSteps())`（`frontend/pages/home/home.js:447-453`）；相册保存同理，`granted` 为真才继续 `canvasToTempFilePath → saveImageToPhotosAlbum`（`frontend/pages/ticket/ticket.js:183-189`、`frontend/pages/ceremony/ceremony.js:471-477`）。

## 5. 输入与输出

**入参**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `scope` | string | 是 | 权限标识，原样用作 `authSetting` 的键；仓库实际只出现 `scope.werun` 与 `scope.writePhotosAlbum` 两种，函数本身**不做白名单校验**（任意合法 scope 均可复用） |
| `tipText` | string | 否 | `wx.showModal` 正文；省略/空串时回退通用文案（`:36`） |

**返回**：`Promise<boolean>`，`true` = 此刻该 scope 已授权可用；`false` = 未授权（含「从未请求」「用户拒绝引导」「设置页没打开」「原生 API 调用失败」四种）。**无异常抛出、无 reject、无错误码**。

**副作用**：最多一次 `wx.showModal` + 一次 `wx.openSetting`（即跳转到小程序设置页，用户返回后页面 `onShow` 会再次触发）；无 setData、无 Storage 写入、无网络请求。

## 6. 依赖关系

**依赖**：仅微信原生 API `wx.getSetting`、`wx.showModal`、`wx.openSetting`。**不依赖任何本仓模块**（无 `require`），因此可被 service 层与 page 层同等引用而不产生循环依赖。

**被依赖（全仓 grep `authGuide` 实测，4 处 require + 5 处调用）**：

| 引用方 | require 行 | 调用点与 scope |
| --- | --- | --- |
| `frontend/services/sport.js` | `:12` | `:23`、`:33`（`scope.werun`，首次授权 + 复检两段式） |
| `frontend/pages/home/home.js` | `:20` | `:447`（`scope.werun`，同步失败后的「去授权」重试） |
| `frontend/pages/ticket/ticket.js` | `:10` | `:183`（`scope.writePhotosAlbum`，保存纪念票） |
| `frontend/pages/ceremony/ceremony.js` | `:14` | `:471`（`scope.writePhotosAlbum`，保存完成仪式画面） |

`frontend/pages/march/march.js:179` 的注释也指向本模块（march 页的就地同步复用 `sport.syncToday`，故不直接 require，见 `.qoder/frontend/pages/march/march.js.md` §4.2）。

**与后端的关系**：无。本模块只解决客户端权限，`scope.werun` 拿到授权后的取数与上送（`wx.login` code + `wx.getWeRunData` 加密数据 → `POST /api/sport/sync`）全在 `services/sport.js`（`.qoder/frontend/services/sport.js.md` §4.6）。

## 7. 业务规则

1. **三态严格区分**：用 `=== true` / `=== false` 判定而非真假值（`:27`、`:32`），因为 `undefined`（从未请求）与 `false`（已拒绝）在微信侧的后续行为完全不同——前者还能弹 `wx.authorize`，后者只能走设置页。误用 `if (!authSetting[scope])` 会对首次用户弹「权限未开启」的错误引导。
2. **本模块不代替 `wx.authorize`**：从未请求过的场景**刻意**返回 `false` 交回调用方（`:56-57` 注释「由调用方自行触发 wx.authorize」），避免在工具层触发一次不可控的授权弹窗。
3. **永不 reject**：所有 `fail` 回调（`getSetting:59`、`showModal:52`、`openSetting:49`）都 `resolve(false)`，调用方无需 `.catch`；这是「授权失败不应让业务链路抛异常」的取舍。
4. **返回值是复检后的最终状态**：`openSetting` 成功回调里重新读 `settingRes.authSetting[scope]`（`:47`），而不是假定「跳过去了就等于开了」。
5. **文案与配色统一**：标题、按钮文案、`confirmColor: '#C8102E'` 固定在工具内（`:35-39`），各调用方只传业务化的 `tipText`，保证全站授权引导观感一致。
6. **无幂等/并发约束**：函数无状态，可并发调用；但连续调用会各自弹一次 `showModal`（微信侧同一时刻只显示一个模态框，后一个被丢弃并走 `fail` → `resolve(false)`），调用方应自行避免重复触发（如 `march.js` 的 `syncing` 锁、`home.js` 的按钮态）。

## 8. 修改约束

1. **不得改变「永不 reject」契约**：4 个调用方（`sport.js`、`home.js`、`ticket.js`、`ceremony.js`）均只写了 `.then`，一旦引入 reject 会变成未捕获的 Promise 异常。
2. **不得吞掉 `undefined` 与 `false` 的区分**：`sport.js:23-38` 的两段式首次授权依赖「首次返回 `false` 且不弹窗」这一行为，改成对 `undefined` 也弹引导会导致新用户第一次同步就看到「权限未开启」。
3. **新增 scope 直接复用即可**，无需改本文件（`scope` 为透传参数）；但 `tipText` 必须写清「为何需要该权限」，这是微信审核与用户信任的要求。
4. **禁止在页面内重写这段 `getSetting/showModal/openSetting` 链路**（收敛前的重复实现即本文件的诞生原因，`53f2d62`）；新增权限场景一律 require 本模块。
5. 本模块属 `frontend/utils/**`，按 `.qoder/README.md` §4「必须建档」范围维护文档；改动后须同步本文件 §4–§9 并在 §10 追加记录。

## 9. 当前实现状态

**已实现**

1. `ensureScope` 单函数导出（`:64`），覆盖「已授权 / 已拒绝引导 / 从未请求 / 原生调用失败」四条路径；四个业务场景（微信运动同步、首页重试、纪念票保存、仪式画面保存）全部接入。

**存在问题 / 待确认**

2. **建档滞后（本次补齐）**：文件由 `53f2d62`（2026-10-18）新增，但当时未按 `.qoder/README.md` §3.3 建档，`.qoder/PROJECT.md` §10「文件级文档（按批次）」第二批的 `3 util` 口径因此少计 2 个（`authGuide.js` 与本批新增的 `hudMap.js`），已在同节更正为 5 个并说明增量来源。
3. **真机全流程未验证**：`53f2d62` 的迭代记录已把「微信运动 openSetting 全流程」列为待人工验证项；automator 无法驱动原生 `showModal`/`openSetting`，故本模块至今**没有自动化测试覆盖**，只有静态核对。
4. **`frontend/design.md` 未提及本模块**：其步数同步链路一节只写「授权 scope.werun → wx.login 取 code → …」，未记录「已拒绝 → ensureScope 引导设置页」这一段，本次已在该行补注（design.md 属 `.qoder/README.md` §4「既有说明文档」，只做索引与交叉引用，不复制正文）。
5. **无 scope 白名单**：任意字符串都会原样传给 `wx.getSetting` 判定，传错 scope 时表现为「永远返回 false 且不弹窗」（命中 `undefined` 分支），排查时需注意。

## 10. 迭代记录

数据来源：`git log --follow frontend/utils/authGuide.js` 与 `docs/迭代记录.md`（按提交号引用）。

### 2026-10-19

- 需求：`.qoder` 文档覆盖率补齐（`frontend/utils/**` 属必须建档范围）。
- 修改内容：**仅建档，未改源码**——新建本文档；`.qoder/PROJECT.md` §10 更正第二批 util 计数（3 → 5，含 `authGuide.js` 与 S2 新增的 `hudMap.js`）与总建档分母；`frontend/design.md` 步数同步链路一行补注 `utils/authGuide.js`。
- 关联文件：`.qoder/frontend/utils/authGuide.js.md`（新建）、`.qoder/PROJECT.md`、`frontend/design.md`。
- 测试结果：文档类变更，无代码执行；已核对本文件全部行号引用与 4 处调用点（grep `authGuide`/`ensureScope(` 实测）。

### 2026-10-18

- 需求：「十项增强」点 3——统一 openSetting 授权引导，消除各页面重复实现。
- 修改内容：新增 `frontend/utils/authGuide.js`（`ensureScope`）；`services/sport.js` 改为两段式首次授权 + 复检；`home.js`（同步失败重试）、`ticket.js` / `ceremony.js`（保存相册）接入。
- 关联文件：`53f2d62`（frontend 侧 48 个文件）。
- 测试结果：全部改动 `.js` 通过 `node --check`；静态核对无原生方法调用入 WXML；微信运动 openSetting 全流程标注为**待真机人工验证**（见 §9 第 3 条）。
