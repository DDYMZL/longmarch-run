# AGENTS.md · 长征运动挑战前端（原生微信小程序）

本文档面向在该目录下工作的 AI Agent 与人类开发者，规定**项目架构约定、编码规范与上下文约束规则**。任何代码生成、修改、重构都必须遵守本文档；与本文档冲突时，以本文档为准（若确实需要变更约定，先修改本文档并说明理由）。

## 1. 项目定位

本目录是「长征主题运动 + 每日答题」的**原生微信小程序**（WXML / WXSS / JS，**无任何构建工具**）。仓库根目录 `project.config.json` 已设 `miniprogramRoot=frontend/`，请使用**微信开发者工具**打开仓库根目录（根目录存在 `mini.project.json` 是支付宝遗留文件，**不要用支付宝开发者工具**打开）。

- 当前为**无后端阶段**：`services/` 是本地 Mock（读写 Storage），可独立运行；
- 后端 `../backend`（FastAPI）已就绪且响应结构与 Mock 完全一致，未来切换后端时**页面层零改动**；
- 因此「服务层返回结构稳定」是最高优先级约束：页面只依赖 service 的返回值结构，不依赖其内部实现。

## 2. 技术栈与工具链

| 项 | 约定 |
| --- | --- |
| 语言 | 原生小程序 JS（CommonJS `require` / `module.exports`，**不支持 ESM**） |
| 视图 | WXML + WXSS（rpx 单位，导航栏主色 `#C8102E`，背景 `#F7F1E5`） |
| 数据 | 本地 Storage（key 前缀 `lm_data_`）+ 会话级内存缓存 |
| 地图 | 原生 `<map>`（腾讯地图，无需 key）+ Canvas 2D 插画地图双模式 |
| 校验 | 无 ESLint 配置；改动后必须 `node --check` 逐个语法检查，并用 IDE 的 GetProblems 复核 |

## 3. 目录结构与分层约定

```
frontend/
├── app.js / app.json / app.wxss   # 应用入口：登录态恢复、全局样式、页面与 tabBar 注册
├── sitemap.json                   # 索引配置
├── mock/data.js                   # 静态数据：路线节点10 / 题库15 / 勋章6（正式上线由后台下发）
├── services/                      # Mock 服务层（对应后端 services/*.py 与 api/routes/*.py）
│   ├── store.js                   # 数据仓库：按 userId 读写 Storage + 内存缓存（唯一数据源）
│   ├── auth.js                    # 微信登录（头像昵称填写、头像持久化）
│   ├── sport.js / march.js / quiz.js / points.js / medal.js / org.js / rank.js
├── utils/util.js                  # 日期格式化、随机等纯工具
└── pages/                         # 11 个页面（4 tab + 7 子页），每个页面 4 件套 js/json/wxml/wxss
```

### 3.1 分层依赖规则（单向，禁止反向）

```
pages -> services -> store.js -> Storage( lm_data_{userId} )
pages -> mock/data.js（只读）
services -> mock/data.js + store.js
```

- **pages 层**：只做 UI 与交互，**不得直接读写 Storage**（登录态 key `lm_login_user` 除外，仅 auth.js 读写）；
- **services 层**：所有业务规则与数据读写；对外返回结构与后端接口一一对应；
- **store.js 是唯一数据源**：其他 service 一律通过 store 读写用户数据；
- **mock/data.js 只读**：页面与 service 不得修改其中的常量。

## 4. 架构不变量（改动时不得破坏）

1. **数据展示页必须 `onShow` + `refresh()`**：所有展示页在 `onShow` 中重新读取最新数据（仅 `onLoad` 的页面在热重载、后台恢复、页面栈复用场景会显示旧数据）。
2. **store 缓存一致性**：`store.getUserData` 返回内存缓存的**共享对象**——写入方必须统一走 `store.saveUserData`（同步更新缓存与 Storage），只读方**禁止原地修改**返回对象；新增 service 不得绕过 store 直接读写 Storage。登出/切换用户必须 `store.clearCache()`（`app.logout` 已处理）。
3. **Storage 键与结构**：用户数据键 `lm_data_{userId}`，结构为 `{ dailySport, litNodes, quizRecords, pointsLog, medals, firstSyncAt }`（见 design.md §3）；登录态键 `lm_login_user`。
4. **头像持久化**：`chooseAvatar` 返回临时路径（工具 `http://tmp/`、真机 `wxfile://tmp_`），**必须**经 `auth.persistAvatar`（`FileSystemManager.saveFile`）转持久路径，否则重启丢头像；仅 `https://` 网络头像直接返回。
5. **登录态守卫**：非 tab 页**没有**全局路由守卫，每个子页 `onShow/onLoad` 需自行判断 `app.globalData.loggedIn`，未登录跳转 login 页。
6. **march 双模式地图**：默认实景 `<map>`（真实经纬度 `NODE_COORDS` + polyline/markers），可切 Canvas 2D「星空远征」插画地图。Canvas 每帧绘制一律读 `this.routeData`；静态元素只在 `buildStaticLayer` 烘焙一次；渐变缓存（`_goldGrad`/`_flagGrad`）与光晕精灵须在画布重建时重置；离屏画布（`wx.createOffscreenCanvas`）相关调用**必须包 try/catch** 降级为低版本基础库每帧直绘路径。
7. **微信登录交互契约**：login 页「微信授权登录」按钮本身即 `<button open-type="chooseAvatar">`（点击先弹微信头像选择，选完在 `bindchooseavatar` 回调完成登录），昵称用 `<input type="nickname">` 采集；登录页**无独立「选择头像」按钮**。
8. **任意节点（含未解锁）可进 node-detail 看历史**：不得在入口处拦截未解锁节点。

## 5. 编码规范

### 5.1 JavaScript

- 模块用 CommonJS：顶部 `const x = require('./x')`，尾部 `module.exports = { ... }`；命名与后端 services 一致。
- 注释用中文；函数用 JSDoc 说明参数/返回值；关键业务（去重、覆盖、永久保留）必须写清。
- 页面文件内函数一律挂 `this`（Page 对象），禁止未使用的 require/方法残留（历史上多次清理过死代码）。
- 日期/文本等纯函数放 `utils/util.js`；禁止在多个 service 复制同一工具函数。

### 5.2 WXML / WXSS

- **WXML 不支持原生方法调用**：表达式不能写 `item.date.slice(5)`、`arr.length` 以外的原生调用等，需在 js 里预处理成展示字段（如 `text`）。
- **`wx:key` 勿用 `index`**：列表键用数据唯一字段（如 `id`、`question`），避免与数据项同名属性冲突导致渲染错乱。
- `<map>` 的折线属性名是 **`polyline`**（复数数据用变量 `polylines`），与文档常见写法不同。
- 样式用 rpx；复用全局样式放 `app.wxss`；页面级样式不覆盖 tabBar 与导航栏约定色。

### 5.3 页面四件套

- 每个页面 `page.json` 只声明页面自己的配置；新增页面必须同步在 `app.json` 的 `pages` 中注册（tab 页还需 tabBar 配置）。

## 6. AI Agent 上下文约束规则（执行任务前必读）

在 frontend 目录执行任何任务时：

1. **先读相关链路**：改某功能前，先读对应 `pages/<页>/<页>.js` + `services/<域>.js` + `store.js`（涉及静态数据再读 `mock/data.js`）；涉及与后端一致性时对照 `../backend/app/services/<域>_service.py` 与 `../backend/app/schemas/schemas.py`。
2. **优先增量修改**：对已有较大文件用 SearchReplace 做精准替换；**禁止整文件 Write 覆盖**（历史事故：覆盖 login.js 丢失 onLoad 自动跳转与每日登录积分逻辑）。
3. **数据一致性排查顺序**：出现「一处更新多处不同步」时，先用 Node 注入假宿主 API 跑服务层调用链、对 Storage 读取加计数器取证，**确认数据层无误后再动展示层**；不要靠逐文件读代码推断（历史上多次得出互相矛盾的错误结论）。
4. **改动后必做自校验**：
   - PowerShell 遍历所有改动 `.js` 执行 `node --check`；
   - 用 IDE 的 GetProblems 复核（注意：返回「无法检测代码问题 / lint 插件缺失」是**假阴性**，不能当作校验通过，`node --check` 才是独立证据）；
   - 微信开发者工具安装路径固定为 `D:\Program Files (x86)\Tencent\微信web开发者工具`；
   - 每次小程序功能开发或缺陷修复完成后，必须调用微信开发者工具进行机型测试，重点核对不同页面、弹窗、空状态及常见屏幕宽度下的布局；该调用已获默认授权，无需再次询问；
   - 核对注释中 unicode 转义书写正确（曾把 `\u886c` 错写为 `\u8877` 静默写入）。
5. **禁止行为**：
   - 禁止在页面里直接读写 Storage、绕过 store；
   - 禁止原地修改 `store.getUserData` 返回对象；
   - 禁止破坏「onShow + refresh()」刷新链；
   - 禁止给 WXML 表达式引入原生方法调用；
   - 禁止改动 `mock/data.js` 常量结构而不同步 `../backend/app/data/seed.py`；
   - 禁止删除 Canvas 离屏降级 try/catch。
6. **真机调试异常先查环境**：报 `tunneling socket could not be established / ECONNREFUSED 127.0.0.1:7893` 属本机代理残留（注册表 ProxyServer 指向已停用端口），解法是开发者工具「设置→代理设置」选「不使用任何代理」后重启工具，**不是代码问题**。
7. **同步文档**：页面、服务层、数据结构的变更需同步更新本目录 `design.md`（页面清单、服务层 API、数据模型）；涉及业务规则时同步 `../backend/design.md` 与 `README.md`。

## 7. 背景知识速查

- 4 个 tab：首页 `home` / 长征 `march` / 答题 `quiz` / 我的 `mine`；7 个子页：login、node-detail、quiz-answer、quiz-result、sport-records、quiz-records、medals。
- 登录态：`app.globalData.user / loggedIn`；登录成功调 `app.setLoginUser(user)`；登出调 `app.logout()`。
- 用户数据读写示例：`const data = store.getUserData(userId); data.dailySport[today] = steps; store.saveUserData(userId, data);`
