# design.md · 长征运动挑战前端（原生微信小程序）设计文档

本文档描述本目录（frontend）的**模块架构设计、核心数据模型与关键服务接口定义**，是前端迭代与前后端联调的技术基线。规则与约定另见 `AGENTS.md`。

## 1. 设计目标

- 「长征主题运动 + 每日答题」原生微信小程序，**无构建工具、无后端依赖**，本地 Storage 做 Mock；
- 服务层（`services/`）对外返回结构与后端 `../backend`（FastAPI）接口**完全一致**，未来切换后端时页面层零改动；
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
│  services/（Mock 服务层，对应后端 api/routes + services）    │
│  auth / sport / march / quiz / points / medal / org / rank │
│  + store.js（唯一数据源：Storage + 会话级内存缓存）          │
└───────┬──────────────────────────────┬───────────────────┘
        │ 读写（仅 store.js）           │ 只读
┌───────▼───────────────┐   ┌──────────▼──────────────────┐
│ Storage                │   │ mock/data.js                 │
│ lm_data_{userId}       │   │ ROUTE_NODES(10) / QUESTIONS  │
│ lm_login_user          │   │ (15) / MEDALS(6)             │
└───────────────────────┘   └─────────────────────────────┘
```

### 2.2 页面清单与职责

| 页面 | 类型 | 职责 |
| --- | --- | --- |
| `pages/home/home` | tab | 首页：步数概况、每日任务入口、积分与勋章概览 |
| `pages/march/march` | tab | 长征地图：双模式（默认实景 `<map>` + 可切 Canvas 星空插画），节点点击进详情、点亮进度 |
| `pages/quiz/quiz` | tab | 答题入口：今日答题状态、开始答题 |
| `pages/mine/mine` | tab | 我的：用户信息、积分、勋章、组织，入口（运动记录/答题记录） |
| `pages/login/login` | 子页 | 微信登录：`chooseAvatar` 头像 + `nickname` 输入，登录后发每日登录积分 |
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
| `auth.js` | `wxLogin(profile)` / `getLocalUser()` / `clearLocalUser()` / `persistAvatar()` | `POST /api/auth/login` | 登录态管理；头像临时路径转持久路径 |
| `sport.js` | 今日步数 / `syncToday()` / `addSteps()` / 最近记录 | `/api/sport/today, sync, recent, add` | 步数按「用户+日期」覆盖；模拟步数 |
| `march.js` | `getRoute()` / `getNodeDetail()` / `lightUpNodes()` | `/api/march/route, node/{id}, light-up` | 累计步数点亮节点（永久保留）、节点状态 |
| `quiz.js` | `getDaily()` / `submit()` / 记录 / `resetToday()` | `/api/quiz/daily, submit, records, reset` | 每日抽 5 题（同日同套）、判分、每日一次 |
| `points.js` | `grantDailyLogin()` / 总额与流水 | `/api/points`、登录副链路 | 积分发放（同日同 reason 去重） |
| `medal.js` | `checkAndGrant()` / `getMedalList()` | `/api/medal/list, check` | 6 枚勋章判定与发放 |
| `org.js` | 组织树下钻 / 我的组织 / 选定组织 | `/api/org/children, mine, select` | 组织树（任意层级可选） |
| `rank.js` | `getStepsRank()` | `/api/rank/steps` | 全员工累计步数总榜 |
| `store.js` | `getUserData()` / `saveUserData()` / `clearCache()` | （后端无对应，落库到 DB） | 唯一数据源 + 会话级内存缓存 |

## 3. 核心数据模型

### 3.1 用户业务数据（Storage `lm_data_{userId}`）

```js
{
  dailySport:  { '2026-09-30': 8236, ... },   // 每日步数（用户+日期 唯一，同日覆盖）
  litNodes:    [1, 2, ...],                   // 已点亮节点 id（点亮后永久保留）
  quizRecords: { '2026-09-30': { totalCount, correctCount, score, points, wrongList, answerAt } },
  pointsLog:   [{ date, reason, delta }],     // 积分流水（同日同 reason 去重）
  medals:      ['first-step', ...],           // 已获得勋章 id
  firstSyncAt: '2026-09-30'                   // 首次同步步数日期
}
```

- 登录态单独存 `lm_login_user`：`{ id, openid, nickname, avatar, loginAt }`（`id === openid`，以 id 作为数据主键）。
- **内存缓存 `_cache`**：`getUserData` 优先命中缓存，`saveUserData` 同步更新缓存与 Storage；登出调 `clearCache()`。缓存返回的是共享对象，只读方禁止原地修改。

### 3.2 静态配置数据（`mock/data.js`，只读，正式上线由后台下发）

| 常量 | 内容 | 关键字段 |
| --- | --- | --- |
| `ROUTE_NODES` | 10 个长征路线节点（瑞金→…→吴起） | `id, name, targetSteps(累计步数要求), historicalTime, icon, description` |
| `QUESTIONS` | 15 道题库 | `id, type(single/judge), question, options, answer, analysis, score(20)` |
| `MEDALS` | 6 枚勋章定义 | `id, name, icon, desc`：first-step / learner / master / luding / snow / victory |

> 与后端 `app/data/seed.py` 一一对应，修改必须两边同步。

## 4. 关键流程设计

### 4.1 登录流程

```
login 页 → 点「微信授权登录」按钮(open-type="chooseAvatar")
  → 微信弹头像选择（选完回调 bindchooseavatar）
  → 昵称 <input type="nickname"> 采集
  → auth.wxLogin({nickname, avatar})
      ├─ wx.login() 拿 code（Mock：用 code 生成唯一 openid）
      └─ persistAvatar：https:// 直返；http://tmp / wxfile://tmp_ 经 saveFile 转持久路径
  → 写入 lm_login_user → app.setLoginUser(user) → points.grantDailyLogin(userId) → 跳转
```

### 4.2 步数同步与点亮链路

```
home/march 触发 → sport.syncToday()（写入 dailySport[今日]）
  → march.lightUpNodes()（累计步数 ≥ targetSteps 的节点点亮，发积分）
  → medal.checkAndGrant()（刷新勋章）
  → 页面 onShow 时 refresh() 拉最新数据展示
```

### 4.3 每日答题链路

```
quiz 页 → quiz.getDaily()（同日同套：首次随机 5 题写入当日缓存）
  → quiz-answer 逐题作答 → quiz.submit(answers)（判分、记分、发积分；每日仅一次）
  → quiz-result 展示得分与错题解析 → 返回后 quiz 页 refresh() 显示已完成
```

### 4.4 march 双模式地图

- **实景模式（默认）**：原生 `<map>` + `NODE_COORDS` 真实经纬度 → `markers`（节点）+ `polyline`（路线）+ `includePoints` 视野动画。
- **插画模式**：「星空远征」深色主题 Canvas 2D：静态层（底色/山峦/河流/路线底）经 `wx.createOffscreenCanvas` 烘焙一次；动态元素（云、星、光晕精灵、流光彗尾）每帧 rAF 绘制；渐变对象缓存复用；离屏调用包 try/catch 降级。

## 5. 核心业务规则（与后端完全一致，见 `../backend/design.md` §5）

| 域 | 规则 |
| --- | --- |
| 步数 | 「用户+日期」唯一，同日同步**覆盖**；模拟步数按「日期+用户」稳定生成（4000~12999） |
| 路线 | 累计步数 ≥ `targetSteps` 即点亮，**永久保留**；节点状态 `completed / current / unlocked` |
| 答题 | 每日随机 5 题、每题 20 分、满分 100；同用户同日仅一次提交 |
| 积分 | 登录 +1；运动 5000 步 +5、10000 步 +10；答题 +5、满分 +10；点亮节点 +10；完成路线 +100；同日同 reason 去重 |
| 勋章 | `first-step` 首次运动；`learner` 答题 10 次；`master` 积分≥500；`luding` 点亮 6 节点；`snow` 点亮 7 节点；`victory` 全部点亮 |

## 6. 关键设计决策与权衡

1. **Mock 服务层模拟后端**：页面只面向 service 的返回结构编程，Mock 与后端结构一致 ⇒ 切换后端仅改 service 内部（`wx.request`），页面零改动。
2. **store 单一数据源 + 会话缓存**：解决「一处更新多处不同步」与 Storage 重复 IO（实测一次页面刷新 Storage 读取从 6+ 降为 0）；代价是所有写入必须走 `saveUserData`。
3. **onShow + refresh() 统一刷新链**：以「页面显示即拉新」替代手写同步逻辑，杜绝热重载/后台恢复下的旧数据。
4. **Canvas 离屏静态层 + 降级**：插画地图 60fps 动画不阻塞 tap；低版本基础库自动回退每帧直绘，保证兼容。
5. **头像本地持久化**：`chooseAvatar` 临时路径经 `saveFile` 转持久路径，保证重启后头像仍可显示（生产化需上传后端换 URL，见 `../backend/README.md`）。
