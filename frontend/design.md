# design.md · 长征运动挑战前端（原生微信小程序）设计文档

本文档描述本目录（frontend）的**模块架构设计、核心数据模型与关键服务接口定义**，是前端迭代与前后端联调的技术基线。规则与约定另见 `AGENTS.md`。

## 1. 设计目标

- 「长征主题运动 + 每日答题」原生微信小程序，**无构建工具**；
- **全量对接后端** `../backend`（FastAPI）：登录、组织、步数、路线、答题、积分、勋章、排名均走真实接口，业务数据统一落库 openGauss；
- 服务层对外返回结构与后端接口**完全一致**（camelCase，见 `../backend/AGENTS.md` 架构不变量 1）；
- 路线节点配置（含经纬度与历史事件卡内容）随 `GET /api/march/route` 统一下发，前端无内置静态数据；
- 兼顾低端机性能：Storage 会话缓存 + Canvas 离屏静态层 + 渐变复用（详见 `AGENTS.md` §4）。

## 2. 模块架构设计

### 2.1 分层架构

```
┌──────────────────────────────────────────────────────────┐
│  pages/（20 页，5 tab + 15 子页）                           │
│  展示与交互；onShow + refresh() 刷新；未登录守卫            │
└───────────────┬──────────────────────────────────────────┘
                │ 调用服务层 API（只依赖返回值结构）
┌───────────────▼──────────────────────────────────────────┐
│  services/（真实后端封装层）                                │
│  auth / sport / march / quiz / points / medal / org /     │
│  rank / profile / person / quote / broadcast / ws /       │
│  identity（扫码确认 + 身份绑定）                            │
│  + request.js（统一 wx.request 封装、JWT、401 清理）        │
│  + config.js（API 地址集中配置）                            │
│  + store.js（遗留：登录数据迁移 migrateUserData）           │
└───────┬──────────────────────────┘
        │ HTTP /api/*（JWT）
┌───────▼───────────────┐
│ 后端 ../backend        │
│ FastAPI + openGauss   │
│ （业务数据唯一数据源）  │
└───────────────────────┘
```

### 2.2 页面清单与职责

| 页面 | 类型 | 职责 |
| --- | --- | --- |
| `pages/home/home` | tab | 首页：今日行军卡（状态分档文案/击败百分比/下一站提示/连续行军行）、今日寄语卡（§16，有出处语录+可跳关联节点，当天优先回退最近一条）、长征进度、连续行军卡、今日长征情报入口、长征记忆卡、勋章行、⚡实时行军动态卡（LIVE）、🚩组织同行卡（同行人数/今日共同前进/同行者列表）、🚀集体长征卡（组织进度条/当前到达与下一站/节点pct芯片）、🌍全员同行卡（全员累计中文大数/进度/下一阶段/里程碑✓○芯片）、抵达事件卡弹层 |
| `pages/march/march` | tab | 长征地图：双模式（默认实景 `<map>` + 可切 Canvas 星空长征），节点点击进详情、点亮进度、到达动画（金光扩散+粒子+抵达事件卡）；星空长征（§13）：节点三态星形、星河轨迹星尘、点亮四阶段动画、拖动/捏合缩放/双击复位（view 变换+命中逆变换+边界钳制）；区域氛围（§12）：星空画布按节点区域主题生成环境粒子（每节点 3 粒封顶 30，ember/mist/snow/star），实景选中卡套主题柔和高光+区域标签；完成仪式（§20）：`ceremonyPending` 时待抵达弹窗播完自动进仪式页，完成横幅为永久入口 |
| `pages/quiz/quiz` | tab | 今日长征情报：期号、破译规则、答题状态、知识画像（总正确率 + 分类正确率） |
| `pages/mine/mine` | tab | 我的：用户信息（昵称修改入口，每人仅一次）、积分、勋章、组织，入口（我的长征/行军日历/组织架构/账号与绑定/运动记录/答题记录） |
| `pages/profile/profile` | 子页 | 我的长征档案：加入天数/阶段标签、运动/答题/积分统计、成就总览六格（§18 行军/路线/情报/连续/勋章/积分，点击直达详情）、数据画像雷达（§17 五维 canvas 雷达图，仅数据不评价）、路线完成度、足迹地图（§7 点亮节点链/点击展开抵达详情：日期+当日步数+累计步数）、足迹时间轴 |
| `pages/calendar/calendar` | 子页 | 行军日历：月视图（步数热力等级/答题/点亮标记）、月统计、当日详情弹层 |
| `pages/login/login` | 子页 | 微信登录：`chooseAvatar` 头像（页面不采集昵称），登录后发每日登录积分；已选组织的用户直达首页，新用户转组织选择页；支持 `?redirect=` 参数（扫码确认等流程登录后原路返回） |
| `pages/org-select/org-select` | 子页 | 组织选择（逐级下钻，任意层级可选）；首次登录（未改名）时顶部采集姓名（`input type="nickname"`，可跳过，提示语「请输入真实姓名」放输入框旁侧、不占 placeholder），选定组织后落库并进首页 |
| `pages/node-detail/node-detail` | 子页 | 节点历史详情：图片轮播/英雄图标、关键词、历史时间/地点、一句话简介、历史故事、历史意义、相关人物（figures 文本 + persons 人物志 chip，点击进人物详情 §14）、路线位置小地图（任意状态可看，含未解锁）、「🎫 生成纪念票」入口（§19，仅已点亮节点可见）；区域氛围（§12）：hero 按节点区域主题渐变 + `#atmoCanvas` 氛围粒子（≤24 粒，onHide 停止），标题区显示区域标签 |
| `pages/ceremony/ceremony` | 子页 | 长征完成仪式（§20）：约 8.1s 时间轴（逐段点亮 → 末节点辉光 → 金线扫过 → 全亮脉冲 → 星空展开 →「我的长征/完成了」→ 完成数据卡：行军/运动天数/答题/路线/勋章/积分，取 `/march/route` + `/profile/summary`）；可跳过；首次确认后 `POST /march/ceremony` 标记，再进为「已完成长征」静态回顾；收尾快照最终帧为静态图并移除画布，数据卡浮于快照上（原生 canvas 层会盖住 DOM） |
| `pages/ticket/ticket` | 子页 | 节点纪念票（§19）：纯 Canvas 2d 绘制（米黄纸面/红头/虚线撕裂线/编号），数据取 `/march/node/{id}` + `/march/footprints`（点亮日期/当日步数/累计），未点亮节点显示提示；保存相册走 `canvasToTempFilePath`（传 canvas 节点）+ `saveImageToPhotosAlbum` |
| `pages/person/person` | 子页 | 长征人物志详情（§14）：头像（无图姓名首字占位）/名称/简介、相关历史事件卡（节点事件+历史时间+简述），点击事件卡回跳节点详情（人物 → 节点双向） |
| `pages/quiz-answer/quiz-answer` | 子页 | 情报破译过程（单选/判断、逐题作答）；连续答对反馈（§15：选项即判 `/quiz/check`，🔥连续N题徽章、对错即时提示、答错连胜清零；判题失败静默不影响作答） |
| `pages/quiz-result/quiz-result` | 子页 | 情报任务结果（得分、错题解析）；满分效果（§15.3：「🎉 今日情报完美通关」标题 + 5/5 · 100 分 + 彩带，积分/事件/勋章规则不变） |
| `pages/sport-records/sport-records` | 子页 | 最近运动记录 |
| `pages/quiz-records/quiz-records` | 子页 | 答题历史记录 |
| `pages/medals/medals` | 子页 | 勋章墙：按入门/路线/挑战/完成分组，隐藏勋章未获得时显示「神秘勋章」，点击查看详情弹层 |
| `pages/rank/rank` | 子页 | 全员工累计步数总榜 |
| `pages/bind/bind` | 子页 | 扫码确认：解析 `?scene=`（L{token} PC 登录 / B{token} 身份绑定），未登录先跳登录页（redirect 返回）；`qrInfo` 查询后按状态渲染确认卡（pending/scanned）/完成态（confirmed/used/cancelled）/错误态（failed 展示后端原因、凭证失效/格式非法）；确认/取消提交防重复 |
| `pages/account/account` | 子页 | 账号与绑定：已绑定身份列表（渠道名/AppID/验证时间/绑定时间），wx_mini 登录凭证不可解绑，wx_web 可解绑（showModal 确认），空态提示 |

> 数据展示页统一「`onShow` → `refresh()`」刷新；非 tab 子页自行判断 `app.globalData.loggedIn`。

### 2.3 服务层与后端接口映射

| 前端 service | 主要方法 | 对应后端接口 | 核心业务 |
| --- | --- | --- | --- |
| `auth.js` | `wxLogin(profile)` / `getLocalUser()` / `updateNickname(name)` / `setInitialNickname(name)` / `updateLocalUser()` / `clearLocalUser()` / `persistAvatar()` | `POST /api/auth/login`、`PUT /api/auth/nickname`、`PUT /api/auth/nickname/initial` | 登录态管理；wx.login → 后端换 JWT；头像临时路径转持久路径；昵称修改（每人仅一次，后端校验）；首次引导设置昵称（不消耗改名机会） |
| `sport.js` | 今日步数 / `syncToday()` / 最近记录 / `getCalendar(month)` | `/api/sport/today, sync, recent, calendar` | 步数按「用户+日期」覆盖；模拟步数；行军日历月聚合 |
| `march.js` | `getRoute()` / `getNodeDetail(id)` / `lightUpNodes()` / `getGlobalGoal()` / `getFootprints()` / `markCeremony()` | `/api/march/route, node/{id}, light-up, global, footprints, ceremony` | 路线进度与节点配置由 `/march/route` 统一下发；步数达标由后端点亮并广播；全员共同长征目标（全员累计/总目标/里程碑）；`getFootprints()` 我的长征足迹；`markCeremony()` 标记完成仪式已观看（§20.4） |
| `quiz.js` | `getDaily()` / `submit()` / `checkAnswer()` / 记录 / `resetToday()` / `getKnowledge()` | `/api/quiz/daily, submit, check, records, reset, knowledge` | 每日抽 5 题（同日同套）、判分、每日一次；`checkAnswer` 单题即时判题（无状态，连胜反馈用）；知识画像分类正确率 |
| `points.js` | `grantDailyLogin()` / 总额与流水 | `/api/points`、登录副链路 | 积分发放（同日同 reason 去重） |
| `medal.js` | `checkAndGrant()` / `getMedalList()` | `/api/medal/list, check` | 12 枚勋章判定与发放（分类/隐藏/排序由后端下发） |
| `profile.js` | `getSummary()` / `getTimeline(limit)` | `/api/profile/summary, timeline` | 我的长征档案聚合与足迹时间轴 |
| `person.js` | `getPerson(id)` | `/api/persons/{id}` | 长征人物志详情（§14，含相关历史事件节点） |
| `quote.js` | `getToday()` | `/api/quotes/today` | 今日寄语（§16）：当天优先、回退最近一条，无则 null（首页寄语卡隐藏） |
| `broadcast.js` | `getToday()` / `getActivities(limit)` / `toActivityView(item)` | `/api/broadcast/today, activities` | 今日长征播报（期号/全局汇总/彩蛋/个人状态）；实时行军动态（REST 快照与 WS 消息共用视图模型：图标/昵称/相对时间） |
| `ws.js` | `subscribe(fn)` | `WS /api/ws/updates?token=` | 实时推送客户端：单连接全局复用、断线指数退避重连（1s 起封顶 15s）；页面订阅 `activity` 等消息，退订即清理 |
| `org.js` | 组织树下钻 / 我的组织 / 选定组织 / `getCompanions(limit)` / `getOrgMarch()` | `/api/org/children, mine, select, companions, march` | 组织树（任意层级可选）；同组织同行者（组织信息/同行人数/今日共同前进/同行者列表）；组织共同长征目标（组织累计步数/路线进度/节点pct） |
| `rank.js` | `getStepsRank()` | `/api/rank/steps` | 全员工累计步数总榜 |
| `identity.js` | `qrInfo(scene)` / `qrConfirm(scene, action)` / `listIdentities()` / `unbind(id)` | `/api/auth/qr/info, qr/confirm, identities, identities/{id}` | 扫码确认（L 登录/B 绑定场景查询与确认取消）与身份绑定管理（列表/解绑，主身份禁解绑） |
| `store.js` | `migrateUserData()` | （后端无对应，落库到 DB） | 遗留：登录时 Mock→真实用户 ID 数据迁移 |
| `request.js` | `request(options)` / `getToken()` | — | 统一 wx.request 封装：Bearer JWT、401 清理、FastAPI 错误解析 |
| `config.js` | `API_BASE_URL` | — | API 地址集中配置：开发者工具用 `127.0.0.1:8010/api`，真机自动切换 `http://<电脑局域网IP>:8010/api`（LAN_IP 常量，电脑 IP 变化时需同步更新） |

## 3. 核心数据模型

### 3.1 用户业务数据（后端 openGauss 落库，前端不再本地存储）

业务数据全部落库后端 openGauss（表结构见 `../backend/app/models/models.py` 与 `../docker/init/*.sql`）：`DailySport`（用户+日期唯一，同日覆盖）、`LitNode`（点亮永久保留）、`QuizRecord`（同日唯一）、`PointsLog`（同日同 reason 去重）、`UserMedal`、`UserIdentity`（微信身份关联，登录采集/扫码绑定）、`AdminUserRole`（后台角色授权）。前端仅保留登录态。

- 登录态单独存 `lm_login_user`：`{ id, nickname, avatar, orgId, loginAt }`；JWT 存 `lm_auth_token`，两者同时存在才视为已登录。
- **用户数据迁移**：从 Mock 登录切换到真实后端时，`store.migrateUserData(oldId, newId)` 一次性复制旧用户的 Storage 数据到新 ID 下（仅在新 ID 无数据时执行），保留旧 key 不删除。

### 3.2 静态配置数据（后端 `app/data/seed.py` 种子，接口下发）

路线节点、题库、勋章定义等静态数据仅存于后端种子与 openGauss，由管理后台维护、接口下发；前端无内置静态数据文件。

| 数据 | 内容 | 下发接口 |
| --- | --- | --- |
| 路线节点 | 10 个长征节点（瑞金→…→延安），含历史事件卡 7 字段与经纬度 | 随 `GET /api/march/route` 统一下发；管理端经 `/api/admin/route-nodes` 维护 |
| 题库 | 15 道题（type single/judge，category event/route/figure） | `GET /api/quiz/daily` 抽题下发（不含答案，判分在服务端） |
| 勋章定义 | 12 枚（入门/路线/挑战/完成，含隐藏勋章） | `GET /api/medal/list` 下发 |

## 4. 关键流程设计

### 4.1 登录流程

```
login 页（支持 `?redirect=` 参数：已登录直接回跳；登录成功后优先回跳，扫码确认场景凭证有效期短不打断）
  → 点「微信授权登录」按钮(open-type="chooseAvatar")
  → 微信弹头像选择（选完回调 bindchooseavatar）（页面不展示昵称输入框）
  → auth.wxLogin({avatar})  // 登录页不采集昵称，新用户默认「长征小战士」
      ├─ wx.login() 拿 code
      ├─ persistAvatar：https:// 直返；http://tmp / wxfile://tmp_ 经 saveFile 转持久路径
      └─ request.js POST /api/auth/login {code, nickname: "", avatar}
         → 后端返回 {token, user}（openid 唯一建号；昵称仅首次创建时写入，后续登录不覆盖）
  → setStorageSync('lm_auth_token', token)
  → store.migrateUserData(oldUserId, newUserId)  // 首次切后端，旧 Mock 数据迁移
  → setStorageSync('lm_login_user', user) → app.setLoginUser(user) → 跳转
  → 有 redirect 时 redirectTo 原路返回（扫码确认等流程）；无 orgId 时 redirectTo 组织选择页，否则 switchTab 首页

### 4.2 组织选择（首次登录）

org-select 页 → 首次登录且未改名时顶部展示姓名采集（`input type="nickname"`，可跳过；「请输入真实姓名」提示在输入框旁侧，不写入 placeholder）
  → 逐级下钻 / 直接选定任一组织
  → 确认选定：先 `auth.setInitialNickname(昵称)`（PUT /api/auth/nickname/initial，不消耗改名机会，失败不阻塞）
    → `org.select(orgId)`（POST /api/org/select 后端落库）
    → 合并最新用户进本地登录态与全局 user → switchTab 首页

### 4.3 昵称修改（每人仅一次）

mine 页昵称旁「✎ 修改昵称」入口（仅 `user.nicknameChangedAt` 为空时展示；弹窗标题即提示「请输入真实姓名」，输入框内不放 placeholderText；editable 弹窗 content 在模拟器与输入框叠层，故提示不放 content）
  → auth.updateNickname(name) → PUT /api/auth/nickname {nickname}
  → 成功：后端返回最新用户（含 nicknameChangedAt），更新本地登录态与全局 user
  → 已修改过的用户不再展示修改按钮（后端同样以 400 兜底）
```

### 4.4 步数同步与点亮链路

```
home/march 触发 → sport.syncToday()（POST /api/sport/sync 后端落库，维护连续行军）
  → march.lightUpNodes()（POST /api/march/light-up，后端点亮并发放积分，返回 newlyLit + newlyCompletedChapters）
  → medal.checkAndGrant()（POST /api/medal/check，后端判定发放）
  → 有新点亮/新完成章节时按队列播放「节点抵达事件卡 → 章节完成仪式卡」（utils/arrivePopup.js 共用播放器；march 页另有 Canvas 金光扩散动画）
  → 页面 onShow 时 refresh() 拉最新数据展示；后端同步向管理端广播 data_changed / activity
```

### 4.5 每日答题链路

```
quiz 页 → quiz.getDaily()（GET /api/quiz/daily，后端从题库随机抽 5 题、按用户+日期固定）
  → quiz-answer 逐题作答（每题选择即 POST /api/quiz/check 即时判题，驱动 🔥 连胜反馈 §15）→ quiz.submit(answers)（POST /api/quiz/submit 后端判分、记分、发积分；每日仅一次）
  → quiz-result 展示得分与错题解析 → 返回后 quiz 页 refresh() 显示已完成
```

### 4.5a 实时行军动态（P1-1，需求 §8）

```
首页 onShow → ws.subscribe 订阅 /api/ws/updates（onHide/onUnload 退订）
  → refreshAll 拉 GET /api/broadcast/activities?limit=6 作权威快照（WS 期间的事件已落库，快照自含；失败不阻塞主数据）
  → 停留期间收到 WS activity 消息 → toActivityView 转视图模型后置顶插入（最多 6 条，单条小 setData）
卡片展示：⚡实时行军 + LIVE 呼吸灯；条目为 图标 + 昵称 + 行为文案 + 相对时间（util.formatRelative）
```

### 4.6 march 双模式地图

- **路线节点配置**：节点列表（含经纬度、三态、章节）随 `GET /api/march/route` 响应统一下发；路线页每次 `onShow` 调 `march.getRoute()` 拉取最新数据后渲染/重绘。
- **实景模式（默认）**：原生 `<map>` + 节点 `latitude/longitude`（来自后端配置）→ `markers`（节点三态图标 + 「🚩 我在这里」进度旗）+ `polyline`（灰色全程 + 金色已完成段，段内线性插值）+ `includePoints` 视野动画（仅首次进入播放，步数刷新不重播）。
- **插画模式**：「星空远征」深色主题 Canvas 2D；节点画布坐标由 `getCanvasNodePositions()` 按经纬度边界归一化计算（非硬编码），兼容任意节点数量和排列；静态层经 `wx.createOffscreenCanvas` 烘焙一次；动态元素（云、星、光晕精灵、流光彗尾）每帧 rAF 绘制；渐变对象缓存复用；离屏调用包 try/catch 降级。
- **行军轨迹（006 P0）**：绘制进度统一取后端 `routeProgress`（旧接口降级为步数比例，见 `calcRouteProgress`/`currentRatio`）；步数刷新只从旧进度插值推进到新进度（约 800ms，`progressAnim`），仅首次渲染播放完整入场描画；当前行军点为「呼吸光点（光晕缩放）+ 3 颗上升光尘 + 摆动红旗」。
- **长征章节（006 P0-3）**：章节视图（状态/点亮数/进度/介绍）由后端 `GET /api/march/route` 随路线统一下发；地图上方固定展示当前章节卡（标题 + 已点亮/总数 + 进度条，`progressPct` 渲染前预计算）；章节完成仪式卡由 light-up 响应驱动，与节点抵达卡共用 `utils/arrivePopup.js` 队列播放器（章节卡含历史介绍停留 3400ms，节点卡 2400ms），home 页步数同步弹层同源。
- **开场动画（006 P0-4，需求 §5）**：首次进入长征 Tab 播放完整开场（1934/瑞金 → 长征开始 → 你的长征旅程正式开始，纯 CSS 淡入叠加，无图片无 rAF，总时长约 3.35s），点击任意处跳过；播放标记写 Storage `lm_march_intro_played`；非首次仅 500ms 过渡纱幕（`pointer-events:none` 不拦截操作）。开场期间地图加载/refresh 并发不阻塞；实景镜头俯冲与抵达事件队列延至开场结束补播（`dismissIntro`）。
- **区域氛围（P2-2，需求 §12）**：`data/node-themes.js` 为前端主题映射配置（§12.3 明确允许），10 节点 → 5 区域（瑞金/赤水/泸定/雪山/延安），每主题含渐变色三段与环境粒子配置（ember/mist/snow/star）；应用于节点详情 hero（渐变 + 氛围粒子画布）、星空长征画布（每节点 3 粒环境粒子封顶 30）、实景模式选中节点卡（柔和高光 + 区域标签）。
- **完成仪式（P2-2，需求 §20）**：`GET /march/route` 返回 `ceremonyPending` 时，待抵达/章节弹窗队列播完（`_popupMs`）自动 `navigateTo` 仪式页；开场期间暂缓、离开页面清定时器可重试；仪式页复用 `utils/routeCanvas.js`（从 march.js 抽取的 Catmull-Rom 路线采样/星形/圆角矩形等纯函数，星空长征同源）；确认后 `POST /march/ceremony` 幂等标记，再进为静态回顾态。

### 4.7 扫码确认与身份绑定（微信身份关联）

```
PC 管理后台登录页生成小程序码（POST /api/admin/wechat/qr，mock 模式直接展示 scene 明文）
  → 手机扫码进 bind 页（?scene=L{token}）
      ├─ 未登录：reLaunch login?redirect=<bind 页带 scene 的完整路径>，登录成功 redirectTo 原路返回
      ├─ identity.qrInfo(scene)：查询场景（pending 置 scanned），按状态渲染
      │    pending/scanned → 登录确认卡（确认登录 PC 管理后台？）
      │    confirmed/used → 完成态；cancelled → 已取消；failed → 错误态（展示后端 failReason 如「无后台访问权限」）
      └─ 确认 → identity.qrConfirm(scene, 'confirm')
           → 无后台角色：后端 403（会话置 failed，PC 轮询展示原因）→ bind 页展示「未获授权」
           → 有角色：后端置 confirmed → PC 2s 轮询到 confirmed 单次签发管理员令牌自动登录
      （取消 → qrConfirm(scene, 'cancel') → 已取消完成态）

身份绑定（B 场景，wx_web 渠道阶段2）：
  → 扫码进 bind 页（?scene=B{token}）
  → qrInfo 返回 {type:'bind', status, target:{provider, appId, nickname?}} → 绑定确认卡
  → 确认 → qrConfirm(scene, 'confirm')：后端事务写 user_identities（unionid 冲突禁止自动合并）→ 完成态
  → mine 页「账号与绑定」→ account 页：GET /api/auth/identities 列表
      ├─ wx_mini 登录凭证：isPrimary 标识，不渲染解绑按钮（后端 400 兜底）
      └─ wx_web：showModal 确认后 DELETE /api/auth/identities/{id} 解绑 → 空态
```

## 5. 核心业务规则（与后端完全一致，见 `../backend/design.md` §5）

| 域 | 规则 |
| --- | --- |
| 步数 | 「用户+日期」唯一，同日同步**覆盖**；模拟步数按「日期+用户」稳定生成（4000~12999） |
| 路线 | 累计步数 ≥ `targetSteps` 即点亮，**永久保留**；节点状态 `completed / current / unlocked`；后台可启停节点，停用节点不可见但已有 `LitNode` 记录保留 |
| 章节 | 5 章配置于后端 `march_service.CHAPTERS`（每章 2 节点，划分可配置）；章内启用节点全点亮即完成，状态 `COMPLETED / ACTIVE / LOCKED`；完成写 `CHAPTER_COMPLETE` 事件并触发前端章节完成仪式，不改变既有节点点亮与积分规则 |
| 答题 | 每日随机 5 题、每题 20 分、满分 100；同用户同日仅一次提交；题目按 event/route/figure 分类支撑知识画像 |
| 积分 | 登录 +1；运动 5000 步 +5、10000 步 +10；答题 +5、满分 +10；点亮节点 +10；完成路线 +100；同日同 reason 去重 |
| 连续行军 | 当日步数 ≥ 5000 即完成当日行军；连续天数/最长连续由后端维护并下发 |
| 勋章 | 12 枚分入门/路线/挑战/完成四类（详见 `../backend/design.md` §5）；`fearless` 为隐藏勋章，未获得时展示「神秘勋章」 |
| 身份关联 | 认证（JWT）/身份关联/后台授权三层分离，绑定身份成功**不等于**拥有后台权限；绑定确认页按 scene 前缀分流 L/B 场景；场景凭证单次有效（终态后确认/取消返回错误态）；bind/account 页未登录守卫先跳登录页 |

## 6. 关键设计决策与权衡

1. **服务层封装后端**：页面只面向 service 的返回结构编程；后端响应与历史 Mock 结构一致（camelCase）⇒ 全量切换真实后端（auth/march/quiz/rank/sport/points/medal/org）后页面零改动，仅 service 内部改走 `request.js`。
2. **后端单一数据源**：Mock 阶段的 store 会话缓存已随全量切换退役（仅保留登录数据迁移）；「一处更新多处不同步」由「后端落库 + 各页 onShow 刷新 + 管理端 WebSocket 广播」解决。
3. **onShow + refresh() 统一刷新链**：以「页面显示即拉新」替代手写同步逻辑，杜绝热重载/后台恢复下的旧数据。
4. **Canvas 离屏静态层 + 降级**：星空长征 60fps 动画不阻塞手势；静态背景离屏缓存、星点/星尘/粒子数量固定（粒子单节点≤14、总量≤64，低端减半）、仅当前节点持续动画；低版本基础库自动回退每帧直绘，保证兼容。
5. **头像本地持久化**：`chooseAvatar` 临时路径经 `saveFile` 转持久路径，保证重启后头像仍可显示（生产化需上传后端换 URL，见 `../backend/README.md`）。
6. **路线配置随路线接口统一下发**：节点配置不再内置前端，由后端 `GET /api/march/route` 统一返回，管理后台修改保存后小程序下次刷新即生效。
7. **用户数据无损迁移**：Mock 用户 ID → 后端真实用户 ID 切换时，`store.migrateUserData` 保证本地步数、点亮、积分、勋章不丢失。
8. **扫码确认页单页双模式**：bind 页按 scene 前缀分流 L/B 两种确认卡（文案/操作/结果语义不同），共用加载/完成/错误态；未登录用 login redirect 原路返回而非新流程，场景凭证有效期短不打断。
