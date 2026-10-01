# design.md · 长征运动挑战前端（原生微信小程序）设计文档

本文档描述本目录（frontend）的**模块架构设计、核心数据模型与关键服务接口定义**，是前端迭代与前后端联调的技术基线。规则与约定另见 `AGENTS.md`。

## 1. 设计目标

- 「长征主题运动 + 每日答题」原生微信小程序，**无构建工具**；
- **全量对接后端** `../backend`（FastAPI）：登录、组织、步数、路线、答题、积分、勋章、排名均走真实接口，业务数据统一落库 openGauss；
- 服务层对外返回结构与后端接口**完全一致**（camelCase，见 `../backend/AGENTS.md` 架构不变量 1）；
- 路线节点采用三级降级：网络 → Storage 缓存 → 内置 Mock（`mock/data.js`），保证离线可用；
- 兼顾低端机性能：Storage 会话缓存 + Canvas 离屏静态层 + 渐变复用（详见 `AGENTS.md` §4）。

## 2. 模块架构设计

### 2.1 分层架构

```
┌──────────────────────────────────────────────────────────┐
│  pages/（11 页，4 tab + 7 子页）                            │
│  展示与交互；onShow + refresh() 刷新；未登录守卫            │
└───────────────┬──────────────────────────────────────────┘
                │ 调用服务层 API（只依赖返回值结构）
┌───────────────▼──────────────────────────────────────────┐
│  services/（真实后端封装层）                                │
│  auth / sport / march / quiz / points / medal / org / rank │
│  + request.js（统一 wx.request 封装、JWT、401 清理）        │
│  + config.js（API 地址集中配置）                            │
│  + store.js（遗留：登录数据迁移 migrateUserData）           │
└───────┬──────────────────────────┬───────────────────────┘
        │ HTTP /api/*（JWT）       │ 只读 / 路线节点离线降级
┌───────▼───────────────┐   ┌──────▼──────────────────────┐
│ 后端 ../backend        │   │ mock/data.js                 │
│ FastAPI + openGauss   │   │ ROUTE_NODES(10)              │
│ （业务数据唯一数据源）  │   │ 离线兜底，结构同后端种子      │
└───────────────────────┘   └─────────────────────────────┘
```

### 2.2 页面清单与职责

| 页面 | 类型 | 职责 |
| --- | --- | --- |
| `pages/home/home` | tab | 首页：步数概况、每日任务入口、积分与勋章概览 |
| `pages/march/march` | tab | 长征地图：双模式（默认实景 `<map>` + 可切 Canvas 星空插画），节点点击进详情、点亮进度 |
| `pages/quiz/quiz` | tab | 答题入口：今日答题状态、开始答题 |
| `pages/mine/mine` | tab | 我的：用户信息（昵称修改入口，每人仅一次）、积分、勋章、组织，入口（运动记录/答题记录） |
| `pages/login/login` | 子页 | 微信登录：`chooseAvatar` 头像 + `nickname` 输入一键填入微信昵称，直接以微信名称登录，登录后发每日登录积分 |
| `pages/node-detail/node-detail` | 子页 | 节点历史详情（任意状态可看，含未解锁） |
| `pages/quiz-answer/quiz-answer` | 子页 | 答题过程（单选/判断、逐题作答） |
| `pages/quiz-result/quiz-result` | 子页 | 答题结果（得分、错题解析） |
| `pages/sport-records/sport-records` | 子页 | 最近运动记录 |
| `pages/quiz-records/quiz-records` | 子页 | 答题历史记录 |
| `pages/medals/medals` | 子页 | 勋章墙（已获/未获） |

> 数据展示页统一「`onShow` → `refresh()`」刷新；非 tab 子页自行判断 `app.globalData.loggedIn`。

### 2.3 服务层与后端接口映射

| 前端 service | 主要方法 | 对应后端接口 | 核心业务 |
| --- | --- | --- | --- |
| `auth.js` | `wxLogin(profile)` / `getLocalUser()` / `updateNickname(name)` / `updateLocalUser()` / `clearLocalUser()` / `persistAvatar()` | `POST /api/auth/login`、`PUT /api/auth/nickname` | 登录态管理；wx.login → 后端换 JWT；头像临时路径转持久路径；昵称修改（每人仅一次，后端校验） |
| `sport.js` | 今日步数 / `syncToday()` / `addSteps()` / 最近记录 | `/api/sport/today, sync, recent, add` | 步数按「用户+日期」覆盖；模拟步数 |
| `march.js` | `refreshRouteNodes()` / `getRouteNodes()` / `getRoute()` / `getNodeDetail()` / `lightUpNodes()` | `/api/march/route-nodes, route, node/{id}, light-up` | 三级降级获取节点配置；步数达标由后端点亮并广播 |
| `quiz.js` | `getDaily()` / `submit()` / 记录 / `resetToday()` | `/api/quiz/daily, submit, records, reset` | 每日抽 5 题（同日同套）、判分、每日一次 |
| `points.js` | `grantDailyLogin()` / 总额与流水 | `/api/points`、登录副链路 | 积分发放（同日同 reason 去重） |
| `medal.js` | `checkAndGrant()` / `getMedalList()` | `/api/medal/list, check` | 6 枚勋章判定与发放 |
| `org.js` | 组织树下钻 / 我的组织 / 选定组织 | `/api/org/children, mine, select` | 组织树（任意层级可选） |
| `rank.js` | `getStepsRank()` | `/api/rank/steps` | 全员工累计步数总榜 |
| `store.js` | `migrateUserData()` / `clearCache()` | （后端无对应，落库到 DB） | 遗留：登录时 Mock→真实用户 ID 数据迁移 |
| `request.js` | `request(options)` / `getToken()` | — | 统一 wx.request 封装：Bearer JWT、401 清理、FastAPI 错误解析 |
| `config.js` | `API_BASE_URL` | — | API 地址集中配置：开发者工具用 `127.0.0.1:8010/api`，真机自动切换 `http://<电脑局域网IP>:8010/api`（LAN_IP 常量，电脑 IP 变化时需同步更新） |

## 3. 核心数据模型

### 3.1 用户业务数据（后端 openGauss 落库，前端不再本地存储）

业务数据全部落库后端 openGauss（表结构见 `../backend/app/models/models.py` 与 `../docker/init/*.sql`）：`DailySport`（用户+日期唯一，同日覆盖）、`LitNode`（点亮永久保留）、`QuizRecord`（同日唯一）、`PointsLog`（同日同 reason 去重）、`UserMedal`。前端仅保留登录态与路线缓存。

- 登录态单独存 `lm_login_user`：`{ id, nickname, avatar, orgId, loginAt }`；JWT 存 `lm_auth_token`，两者同时存在才视为已登录。
- **用户数据迁移**：从 Mock 登录切换到真实后端时，`store.migrateUserData(oldId, newId)` 一次性复制旧用户的 Storage 数据到新 ID 下（仅在新 ID 无数据时执行），保留旧 key 不删除。

### 3.2 静态配置数据（`mock/data.js`，只读，网络不可用时降级兜底）

| 常量 | 内容 | 关键字段 |
| --- | --- | --- |
| `ROUTE_NODES` | 10 个长征路线节点（瑞金→…→延安） | `id, name, targetSteps, historicalTime, icon, description, latitude, longitude, sortOrder, isEnabled` |
| `QUESTIONS` | 15 道题库 | `id, type(single/judge), question, options, answer, analysis, score(20)` |
| `MEDALS` | 6 枚勋章定义 | `id, name, icon, desc`：first-step / learner / master / master / luding / snow / victory |

> 路线节点在后台保存后由 `GET /api/march/route-nodes` 下发；`mock/data.js` 仅在无网络且无 Storage 缓存时使用。结构与后端 `app/data/seed.py` 一一对应，修改必须两边同步。

## 4. 关键流程设计

### 4.1 登录流程

```
login 页 → 点「微信授权登录」按钮(open-type="chooseAvatar")
  → 微信弹头像选择（选完回调 bindchooseavatar）
  → 昵称 <input type="nickname"> 点击一键填入微信昵称（登录直接使用微信名称，无需手动起名）
  → auth.wxLogin({nickname, avatar})
      ├─ wx.login() 拿 code
      ├─ persistAvatar：https:// 直返；http://tmp / wxfile://tmp_ 经 saveFile 转持久路径
      └─ request.js POST /api/auth/login {code, nickname, avatar}
         → 后端返回 {token, user}（昵称仅首次创建时写入，后续登录不覆盖）
  → setStorageSync('lm_auth_token', token)
  → store.migrateUserData(oldUserId, newUserId)  // 首次切后端，旧 Mock 数据迁移
  → setStorageSync('lm_login_user', user) → app.setLoginUser(user) → 跳转
  → 无 orgId 时 redirectTo 组织选择页，否则 switchTab 首页

### 4.2 昵称修改（每人仅一次）

mine 页昵称旁「✎ 修改昵称」入口（仅 `user.nicknameChangedAt` 为空时展示，弹窗明确提示仅可修改一次）
  → auth.updateNickname(name) → PUT /api/auth/nickname {nickname}
  → 成功：后端返回最新用户（含 nicknameChangedAt），更新本地登录态与全局 user
  → 已修改过的用户不再展示修改按钮（后端同样以 400 兜底）
```

### 4.3 步数同步与点亮链路

```
home/march 触发 → sport.syncToday()（POST /api/sport/sync 后端落库）
  → march.lightUpNodes()（POST /api/march/light-up，后端点亮并发放积分）
  → medal.checkAndGrant()（POST /api/medal/check，后端判定发放）
  → 页面 onShow 时 refresh() 拉最新数据展示；后端同步向管理端广播 data_changed
```

### 4.4 每日答题链路

```
quiz 页 → quiz.getDaily()（GET /api/quiz/daily，后端从题库随机抽 5 题、按用户+日期固定）
  → quiz-answer 逐题作答 → quiz.submit(answers)（POST /api/quiz/submit 后端判分、记分、发积分；每日仅一次）
  → quiz-result 展示得分与错题解析 → 返回后 quiz 页 refresh() 显示已完成
```

### 4.5 march 双模式地图

- **路线节点配置**：`march.js` 维护模块级 `routeNodes` 变量，读取顺序为 `GET /api/march/route-nodes`（成功后写入 Storage `lm_route_nodes`）→ Storage 缓存 → 内置 `mock/data.js`。每次路线页 `onShow` 先用缓存即时渲染，再异步刷新，成功后重绘。请求序号防止旧响应覆盖。
- **实景模式（默认）**：原生 `<map>` + 节点 `latitude/longitude`（来自后端配置）→ `markers`（节点三态图标）+ `polyline`（路线）+ `includePoints` 视野动画。
- **插画模式**：「星空远征」深色主题 Canvas 2D；节点画布坐标由 `getCanvasNodePositions()` 按经纬度边界归一化计算（非硬编码），兼容任意节点数量和排列；静态层经 `wx.createOffscreenCanvas` 烘焙一次；动态元素（云、星、光晕精灵、流光彗尾）每帧 rAF 绘制；渐变对象缓存复用；离屏调用包 try/catch 降级。

## 5. 核心业务规则（与后端完全一致，见 `../backend/design.md` §5）

| 域 | 规则 |
| --- | --- |
| 步数 | 「用户+日期」唯一，同日同步**覆盖**；模拟步数按「日期+用户」稳定生成（4000~12999） |
| 路线 | 累计步数 ≥ `targetSteps` 即点亮，**永久保留**；节点状态 `completed / current / unlocked`；后台可启停节点，停用节点不可见但已有 `LitNode` 记录保留 |
| 答题 | 每日随机 5 题、每题 20 分、满分 100；同用户同日仅一次提交 |
| 积分 | 登录 +1；运动 5000 步 +5、10000 步 +10；答题 +5、满分 +10；点亮节点 +10；完成路线 +100；同日同 reason 去重 |
| 勋章 | `first-step` 首次运动；`learner` 答题 10 次；`master` 积分≥500；`luding` 点亮 6 节点；`snow` 点亮 7 节点；`victory` 全部点亮 |

## 6. 关键设计决策与权衡

1. **服务层封装后端**：页面只面向 service 的返回结构编程；后端响应与历史 Mock 结构一致（camelCase）⇒ 全量切换真实后端（auth/march/quiz/rank/sport/points/medal/org）后页面零改动，仅 service 内部改走 `request.js`。
2. **后端单一数据源**：Mock 阶段的 store 会话缓存已随全量切换退役（仅保留登录数据迁移）；「一处更新多处不同步」由「后端落库 + 各页 onShow 刷新 + 管理端 WebSocket 广播」解决。
3. **onShow + refresh() 统一刷新链**：以「页面显示即拉新」替代手写同步逻辑，杜绝热重载/后台恢复下的旧数据。
4. **Canvas 离屏静态层 + 降级**：插画地图 60fps 动画不阻塞 tap；低版本基础库自动回退每帧直绘，保证兼容。
5. **头像本地持久化**：`chooseAvatar` 临时路径经 `saveFile` 转持久路径，保证重启后头像仍可显示（生产化需上传后端换 URL，见 `../backend/README.md`）。
6. **三级降级路线配置**：网络成功结果 → Storage `lm_route_nodes` 缓存 → 内置 `mock/data.js`；无网络时小程序仍可正常展示路线地图。
7. **用户数据无损迁移**：Mock 用户 ID → 后端真实用户 ID 切换时，`store.migrateUserData` 保证本地步数、点亮、积分、勋章不丢失。
