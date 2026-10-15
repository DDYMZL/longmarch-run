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
│  pages/（24 页，5 tab + 19 子页/首页面）                    │
│  展示与交互；onShow + refresh() 刷新；未登录守卫            │
└───────────────┬──────────────────────────────────────────┘
                │ 调用服务层 API（只依赖返回值结构）
┌───────────────▼──────────────────────────────────────────┐
│  services/（真实后端封装层）                                │
│  auth / sport / march / quiz / points / medal / org /     │
│  rank / profile / person / quote / broadcast / ws /       │
│  activity / identity（扫码确认 + 身份绑定）                 │
│  + request.js（统一 wx.request 封装、JWT、401 清理、        │
│    活动守卫 403 跳活动状态页）                              │
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
| `pages/home/home` | tab | 首页：今日行军卡（20000 步目标、状态分档文案/击败百分比/下一站提示/连续行军行）、今日寄语卡（§16，有出处语录+可跳关联节点，按天循环轮换）、长征进度、连续行军卡、今日长征情报入口、长征记忆卡、勋章行、⚡实时行军动态卡（LIVE）、🚩组织同行卡（同行人数/今日共同前进/同行者列表）、🚀集体长征卡（组织进度条/当前到达与下一站/节点pct芯片）、🌍全员同行卡（全员累计中文大数/进度/下一阶段/里程碑✓○芯片）、抵达事件卡弹层 |
| `pages/march/march` | tab | 长征地图：双模式（默认实景 `<map>` + 可切 Canvas 星空长征），节点点击进详情、点亮进度、到达动画（金光扩散+粒子+抵达事件卡）；星空长征（§13）：节点三态星形、星河轨迹星尘、点亮四阶段动画、拖动/捏合缩放/双击复位（view 变换+命中逆变换+边界钳制）；区域氛围（§12）：星空画布按节点区域主题生成环境粒子（每节点 3 粒封顶 30，ember/mist/snow/star），实景选中卡套主题柔和高光+区域标签；完成仪式（§20）：`ceremonyPending` 时待抵达弹窗播完自动进仪式页，完成横幅为永久入口 |
| `pages/quiz/quiz` | tab | 今日长征情报：顶部答题交互模式切换（情报1 即时判定 / 情报2 交卷看解析，规则文案随模式变化，进度点交卷模式不揭示对错）、期号、破译规则、答题状态、知识画像（总正确率 + 分类正确率） |
| `pages/mine/mine` | tab | 我的：用户信息（昵称修改入口，每人仅一次）、V2.0「我的积分」卡（总积分 = 步行 + 答题、今日获得、积分排名，点卡进积分明细、点排名进排行榜）、勋章、组织（已选定显示 🔒，仅管理员可改），入口（积分明细/我的长征/行军日历/组织架构/运动记录/答题记录）；统计卡「累计运动(步)」展示计分口径 `scoredTotalSteps`（各日封顶 20000 求和，与步行积分同口径）；「账号与绑定」入口已隐藏（account 页与后端绑定接口保留，仅无前端入口） |
| `pages/points/points` | 子页 | 积分明细（V2.0）：总积分/排名/步行/答题/今日获得、今日进度（规则文案由 `/points` 的 `rules` 下发拼装，前端不写死数值）、每日明细表（日期/步数/步行/答题/合计）分页触底加载，下拉刷新 |
| `pages/activity/activity` | 子页 | 活动状态页（V2.0）：未发布/未开始/进行中/已结束四态（图标、状态标签、活动时间、结束标题与提示）；`allowView` 时可进首页/查看排行，否则仅「刷新状态」；查看类请求被活动守卫拦截（403 + `X-Activity-Status`）时统一 reLaunch 至此 |
| `pages/profile/profile` | 子页 | 我的长征档案：V2.0 荣誉卡（长征步迹·荣耀征程、积分排名徽章、总积分与步行/答题拆分、点亮/勋章/连续，点击进积分明细）、加入天数/阶段标签、运动/答题/勋章统计、成就总览六格（§18 行军/路线/情报/连续/勋章/积分，点击直达详情）、数据画像雷达（§17 五维 canvas 雷达图，仅数据不评价）、路线完成度、足迹地图（§7 点亮节点链/点击展开抵达详情：日期+当日步数+累计步数）、足迹时间轴 |
| `pages/calendar/calendar` | 子页 | 行军日历：月视图（步数热力等级/答题/点亮标记）、月统计、当日详情弹层 |
| `pages/launch/launch` | 首页面 | 启动页兼邀请码扫码落地页：`parseInviteFromScene(scene)` 取 `i=<CODE>` → `auth.ensureLogin()` 分流：active 进首页（支持 `?redirect=`）；disabled 显示停用提示；unregistered 无邀请码时 blocked 态「仅对受邀人员开放」+「重新扫码/退出」，有邀请码则 `verifyInvite` 后 redirectTo 入驻页 |
| `pages/login/login` | 子页 | 主动退出后的手动登录：`chooseAvatar` 头像（页面不采集昵称），登录后发每日登录积分（后端 /auth/login 内发放）；status=active 直达首页，unregistered/disabled 捕获 admission 后 reLaunch 启动页；支持 `?redirect=` |
| `pages/onboard/onboard` | 子页 | 入驻信息收集：读取 `?invite=<CODE>&rootId=&rootName=`，填写真实姓名 + 组织（点选组织跳 org-select pickMode=onboard，仅允许 rootId 及其下级，用 eventChannel orgPicked 回传）→ `auth.onboard` 一次性建号写 Token → switchTab 首页 |
| `pages/org-select/org-select` | 子页 | 组织选择（逐级下钻）：from=home 引导卡（未改名时顶部采集姓名）/ from=mine 修改所属组织 → 落库返回来源页；pickMode=onboard 入驻态由 `rootId`/`rootName` 限定可选范围（栈底锁定为 root，不能回到更上级），不要求已登录，选定后用 `eventChannel.emit('orgPicked', {...})` 回传入驻页 |
| `pages/node-detail/node-detail` | 子页 | 节点历史详情：图片轮播/英雄图标、关键词、历史时间/地点、一句话简介、历史故事、历史意义、相关人物（figures 文本 + persons 人物志 chip，点击进人物详情 §14）、路线位置小地图（坐标优先取节点详情，旧接口缺失时按节点 ID 从 `/march/route` 补齐；仍无有效点位则显示空态）、「🎫 生成纪念票」入口（§19，仅已点亮节点可见）；区域氛围（§12）：hero 按节点区域主题渐变 + `#atmoCanvas` 氛围粒子（≤24 粒，onHide 停止），标题区显示区域标签 |
| `pages/ceremony/ceremony` | 子页 | 长征完成仪式（§20）：约 8.1s 时间轴（逐段点亮 → 末节点辉光 → 金线扫过 → 全亮脉冲 → 星空展开 →「我的长征/完成了」→ 完成数据卡：行军/运动天数/答题/路线/勋章/积分，取 `/march/route` + `/profile/summary`）；可跳过；首次确认后 `POST /march/ceremony` 标记，再进为「已完成长征」静态回顾；收尾快照最终帧为静态图并移除画布，数据卡浮于快照上（原生 canvas 层会盖住 DOM） |
| `pages/ticket/ticket` | 子页 | 节点纪念票（§19）：纯 Canvas 2d 绘制（米黄纸面/红头/虚线撕裂线/编号），数据取 `/march/node/{id}` + `/march/footprints`（点亮日期/当日步数/累计），未点亮节点显示提示；保存相册走 `canvasToTempFilePath`（传 canvas 节点）+ `saveImageToPhotosAlbum` |
| `pages/person/person` | 子页 | 长征人物志详情（§14）：头像（无图姓名首字占位）/名称/简介、相关历史事件卡（节点事件+历史时间+简述），点击事件卡回跳节点详情（人物 → 节点双向） |
| `pages/quiz-answer/quiz-answer` | 子页 | V2.0 逐题限时，两种交互模式（由情报 tab 经 `?mode=` 传入）：进入即 `quiz.start()` 开题（幂等，中途返回继续当前题）→ 90 秒环形倒计时（最后 10 秒警示色，截止时间 = 收到响应时刻 + 服务器 `remainingMs`，切后台回来按 `Date.now` 重算）→ 选择并提交（每题一次）；`instant` 即时判定：提交后反馈对错/正确答案/解析/得分 → 下一题，进度点 right/wrong/timeout 三态；`review` 交卷看解析（情报2）：作答中不揭示对错（进度点 answered 显示 done 中性态）、提交后逐题静默推进，最后一题提交进入交卷态 → 跳 quiz-result 统一查看全部解析；倒计时归零进入超时态不可提交 |
| `pages/quiz-result/quiz-result` | 子页 | 情报任务结果（V2.0）：答对题数、正确率滚动、答题积分、超时题数、逐题结果（题干/我的答案/正确答案/正确·错误·超时/本题积分/解析）；历史记录无 details 时回退错题解析；全对彩带 |
| `pages/sport-records/sport-records` | 子页 | 最近运动记录 |
| `pages/quiz-records/quiz-records` | 子页 | 答题历史记录 |
| `pages/medals/medals` | 子页 | 勋章墙：按入门/路线/挑战/完成分组，隐藏勋章未获得时显示「神秘勋章」，点击查看详情弹层 |
| `pages/rank/rank` | tab | 积分排行榜（V2.0，与 PC 同源 `/rank/points`）：前三名金银铜领奖台（2-1-3 排布）、4-10 名卡片、11 名起分页列表（触底加载）、本人高亮，本人 >10 名时底部常驻「我的排名」条；下拉刷新/错误重试 |
| `pages/bind/bind` | 子页 | 扫码确认：解析 `?scene=`（L{token} PC 登录 / B{token} 身份绑定），未登录先经启动页自动登录（redirect 返回）；`qrInfo` 查询后按状态渲染确认卡（pending/scanned）/完成态（confirmed/used/cancelled）/错误态（failed 展示后端原因、凭证失效/格式非法）；确认/取消提交防重复 |
| `pages/account/account` | 子页 | 账号与绑定：已绑定身份列表（渠道名/AppID/验证时间/绑定时间），wx_mini 登录凭证不可解绑，wx_web 可解绑（showModal 确认），空态提示 |

> 数据展示页统一「`onShow` → `refresh()`」刷新；非 tab 子页自行判断 `app.globalData.loggedIn`。

### 2.3 服务层与后端接口映射

| 前端 service | 主要方法 | 对应后端接口 | 核心业务 |
| --- | --- | --- | --- |
| `auth.js` | `ensureLogin()` / `wxLogin(profile)` / `verifyInvite(code)` / `onboard({inviteCode,nickname,orgId,avatar})` / `updateNickname(name)` / `setInitialNickname(name)` / `updateLocalUser()` / `clearLocalUser()` / `persistAvatar()` / `savePendingInvite()` / `readPendingInvite()` / `clearPendingInvite()` | `POST /api/auth/login`、`POST /api/auth/invite/verify`、`POST /api/auth/onboard`、`PUT /api/auth/nickname`、`PUT /api/auth/nickname/initial` | 登录态管理；/auth/login 返回 `{status, token?, user?}` 分流：active 写登录态；disabled/unregistered 抛 `err.admission` 由启动页处理；邀请码扫码落地由 launch 保存 `lm_pending_invite`、入驻页读取并 `verifyInvite` + `onboard`（后端条件 UPDATE 原子核销）；`updateLocalUser(patch)` 同时写 `lm_login_user` 与 `app.globalData.user`（组织名称等仅前端缓存字段由此回显到「我的」页）；request.js 401 单飞重登，403 `X-Account-Status: disabled` 直接清态回启动页 |
| `sport.js` | 今日步数 / `syncToday()` / 最近记录 / `getCalendar(month)` | `/api/sport/today, sync, recent, calendar` | wx.getWeRunData 加密数据由后端按北京时间补录最近 7 日；页面只展示今天，缺失日提示待重试；滚动发布期间旧响应由 service 补齐明细数组与积分默认值 |
| `march.js` | `getRoute()` / `getNodeDetail(id)` / `lightUpNodes()` / `getGlobalGoal()` / `getFootprints()` / `markCeremony()` / `hasPlayedIntro()` / `markIntroPlayed()` | `/api/march/route, node/{id}, light-up, global, footprints, ceremony` | 路线进度与节点配置由 `/march/route` 统一下发；步数达标由后端点亮、发放勋章并广播（light-up 返回 newlyLit / newlyCompletedChapters / newMedals）；全员共同长征目标（全员累计/总目标/里程碑）；`getFootprints()` 我的长征足迹；`markCeremony()` 标记完成仪式已观看（§20.4）；开场动画播放标记（Storage `lm_march_intro_played`，页面不直接读写 Storage） |
| `quiz.js` | `getDaily()` / `start()` / `answer(questionId, label)` / 记录 / `resetToday()` / `getKnowledge()` | `/api/quiz/daily, start, answer, records, reset, knowledge` | 后端按当前用户个人历史分轮随机、同日固定且不重复；题库不足 5 道按实际题量提示。逐题 90 秒、单次提交、服务端判定与积分规则不变 |
| `points.js` | `getSummary()` / `getDaily(page, pageSize)` | `/api/points, /api/points/daily` | 总/步行/答题/今日/排名 + `walkCarry` 步数结余 + 规则参数；积分只由后端计算 |
| `activity.js` | `getStatus()` / `formatRange(status)` | `/api/activity/status`（公开） | 活动状态（未发布/未开始/进行中/已结束 + allowParticipate/allowView/结束标题与提示），写 `app.globalData.activity`；请求带 `skipActivityRedirect` 避免自身被守卫重定向 |
| `medal.js` | `getMedalList()` | `/api/medal/list` | 勋章墙（分类/隐藏/排序由后端下发；判定发放由后端在同步/点亮/答题副链路完成） |
| `profile.js` | `getSummary()` / `getTimeline(limit)` | `/api/profile/summary, timeline` | 我的长征档案聚合与足迹时间轴 |
| `person.js` | `getPerson(id)` | `/api/persons/{id}` | 长征人物志详情（§14，含相关历史事件节点） |
| `quote.js` | `getToday()` | `/api/quotes/today` | 今日寄语（§16、V1.1）：后台启用寄语按排序号自循环起始日期起每天轮换一条，同一天所有用户相同；无启用寄语返回 null（首页寄语卡隐藏） |
| `broadcast.js` | `getToday()` / `getActivities(limit)` / `toActivityView(item)` | `/api/broadcast/today, activities` | 今日长征播报（期号/全局汇总/彩蛋/个人状态）；实时行军动态（REST 快照与 WS 消息共用视图模型：图标/昵称/相对时间） |
| `ws.js` | `subscribe(fn)` | `WS /api/ws/updates?token=` | 实时推送客户端：单连接全局复用、断线指数退避重连（1s 起封顶 15s）；页面订阅 `activity` 等消息，全部退订后 30s 空闲自动断开且不再重连，再次订阅时重建 |
| `org.js` | 组织树下钻 / `getMine()` / 选定组织 / `getCompanions(limit)` / `getOrgMarch()` | `/api/org/children, mine, select, companions, march` | 组织树（任意层级可选）；V2.0 组织锁定：`/org/mine` 返回 `locked`，已选定后 `POST /org/select` 返回 403 `ORG_LOCKED`，仅管理员可在后台调整（留审计）；同组织同行者；组织共同长征目标 |
| `rank.js` | `getPointsRank(page, pageSize)` | `/api/rank/points?page=&page_size=` | V2.0 积分总榜（与 PC 同源）：`top`（1-10）、`list`（11 名起分页）、`me`、`hasMore`、`total` |
| `identity.js` | `qrInfo(scene)` / `qrConfirm(scene, action)` / `listIdentities()` / `unbind(id)` | `/api/auth/qr/info, qr/confirm, identities, identities/{id}` | 扫码确认（L 登录/B 绑定场景查询与确认取消）与身份绑定管理（列表/解绑，主身份禁解绑） |
| `store.js` | `migrateUserData()` | （后端无对应，落库到 DB） | 遗留：登录时 Mock→真实用户 ID 数据迁移 |
| `request.js` | `request(options)` / `getToken()` / `setReauthHandler(fn)` | — | 统一 wx.request 封装：Bearer JWT、401 静默重登并重试一次（`skipAuthRetry` 跳过）、失败清理回启动页、错误分类（`statusCode` / `network` / `activityStatus`）、FastAPI 错误解析；活动守卫 403（header `X-Activity-Status`）：GET 查看类请求 3s 防抖 reLaunch 活动状态页（`skipActivityRedirect` 跳过），写操作仅抛错由页面展示后端提示 |
| `config.js` | `API_BASE_URL` | — | API 地址集中配置：`ENV` 常量一键切换联调环境——`'remote'`（默认）直连已部署后端 `https://swkjdj.sz-watech.com/api`（HTTPS，走默认 443；域名须与公众平台「服务器域名 → request 合法域名」一致，否则体验版/正式版报「网络异常」），开发者工具与真机一致；`'local'` 走本机后端，开发者工具用 `127.0.0.1:8010/api`，真机自动切换 `http://<电脑局域网IP>:8010/api`（LAN_IP 常量，电脑 IP 变化时需同步更新） |

## 3. 核心数据模型

### 3.1 用户业务数据（后端 openGauss 落库，前端不再本地存储）

业务数据全部落库后端 openGauss（表结构见 `../backend/app/models/models.py` 与 `../docker/init/*.sql`）：`DailySport`（用户+日期唯一，同日覆盖）、`LitNode`（点亮永久保留）、`QuizRecord`（同日唯一）、`PointsLog`（同日同 reason 去重）、`UserMedal`、`UserIdentity`（微信身份关联，登录采集/扫码绑定）、`AdminUserRole`（后台角色授权）。前端仅保留登录态。

- 登录态单独存 `lm_login_user`：`{ id, nickname, avatar, orgId, nicknameChangedAt, orgName?, orgFullName? }`；JWT 存 `lm_auth_token`；主动退出标记 `lm_logged_out`。本地缓存**不代表已登录**：`app.globalData.loggedIn` 仅在启动页经后端 `/auth/me` 校验通过或登录成功后置 true。
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
【扫码入驻（V1.0 邀请码准入）】app.json 首页面 = launch 页（也是管理后台「入驻邀请码」生成的小程序码落地页，scene 为 `i=<CODE>`，长度 ≤32，不含任何身份信息）
launch 页 onLoad(options) → parseInviteFromScene(options.scene) 取 `inviteCode`（兼容 ?invite= 快捷参数、?redirect= 原路跳转）
  → auth.ensureLogin()（单飞）
      ├─ 有本地 Token：GET /api/auth/me 后端校验（本地缓存不代表登录）
      │    ├─ 200 → 以后端用户为准合并缓存 → 后端若携 X-Account-Status: disabled 则 clearSession() 并抛 admission=disabled → 进 disabled 态
      │    └─ 401 → 删 Token → 静默重登（下）
      ├─ 无 Token：静默重登 auth.relogin()：wx.login → POST /api/auth/login {code}（不传昵称/头像）
      │    ├─ 200 status=active：写 Token/user → loggedIn=true → 回原页 / 首页
      │    ├─ 200 status=disabled：throw admission=disabled → 启动页 disabled 态「账号已停用，请联系活动管理员」
      │    └─ 200 status=unregistered：throw admission=unregistered → 走准入分流
      ├─ unregistered + 无 inviteCode：启动页 blocked 态「当前小程序仅对受邀人员开放，请联系活动管理员获取有效入驻二维码。」+「重新扫码 / 退出」
      ├─ unregistered + 有 inviteCode：POST /api/auth/invite/verify 校验（不核销）
      │    ├─ 400（无效/停用/过期/用满）：blocked 态同上
      │    └─ 200 返回 {name, orgId, orgName}：redirectTo /pages/onboard/onboard?invite=<CODE>&rootId=&rootName= 填写姓名+组织（org-select pickMode=onboard 下只允许该组织及其下级）
      │       → auth.onboard({inviteCode, nickname, orgId}) → POST /api/auth/onboard：后端条件 UPDATE 原子核销 + 建号 + 审计；openid 唯一约束冲突回滚复用已存在用户；成功写 Token/user → switchTab 首页
      ├─ wx.login 失败 / 后端 502：启动页提示 +「重新进入」，不写入登录态
      ├─ 网络异常：提示重试，保留本地 Token
      └─ 用户主动退出过（lm_logged_out）：redirectTo login 页手动登录
【使用中 Token 失效】request.js 收到 401 → 调 auth 注册的 relogin（并发 401 合并为一次）→ 重试原请求一次；
  收到 403 且 header X-Account-Status: disabled → 不重登，clearSession + reLaunch 启动页 disabled 态
  重登失败（非网络）或重试仍 401 → 清登录态 reLaunch 启动页

【手动登录】login 页（仅主动退出后使用；支持 `?redirect=`）
  → 点「微信授权登录」按钮(open-type="chooseAvatar")
  → auth.wxLogin({avatar})（内部 wx.login + POST /api/auth/login）
      ├─ status=active：写 Token/user → 回原页 / 首页
      └─ status=unregistered | disabled：捕获 admission 错误 → reLaunch 启动页，由启动页按准入分流
  → setStorageSync('lm_auth_token', token)、合并 user、清退出标记 → 跳转
```

### 4.2 组织选择（选填）

首页未选组织时展示「选择所属组织」引导卡（`orgChecked && !orgName`），或「我的」页进入
org-select 页（from=home 引导入口）→ 未改名时顶部展示姓名采集（`input type="nickname"`，可跳过；「请输入真实姓名」提示在输入框旁侧，不写入 placeholder）
  → 逐级下钻 / 直接选定任一组织
  → 确认选定：先 `auth.setInitialNickname(昵称)`（PUT /api/auth/nickname/initial，不消耗改名机会，失败不阻塞）
    → `org.select(orgId)`（POST /api/org/select 后端落库）
    → 合并最新用户进本地登录态与全局 user → navigateBack 返回来源页
  → V2.0 锁定：非 pickMode 进入时先 `org.getMine()`，`locked=true` 则只读展示「我的所属组织」+ 🔒「所属组织选定后已锁定，如需调整请联系管理员」，不再渲染下钻列表

### 4.3 昵称修改（每人仅一次）

mine 页昵称旁「✎ 修改昵称」入口（仅 `user.nicknameChangedAt` 为空时展示；弹窗标题即提示「请输入真实姓名」，输入框内不放 placeholderText；editable 弹窗 content 在模拟器与输入框叠层，故提示不放 content）
  → auth.updateNickname(name) → PUT /api/auth/nickname {nickname}
  → 成功：后端返回最新用户（含 nicknameChangedAt），更新本地登录态与全局 user
  → 已修改过的用户不再展示修改按钮（后端同样以 400 兜底）
```

### 4.4 步数同步与点亮链路

```
home/march 触发 → sport.syncToday()（授权 scope.werun → wx.login 取 code → wx.getWeRunData 取加密数据，POST /api/sport/sync {code, encryptedData, iv} 后端解密落库并维护连续行军；授权/取数失败即报错不发请求）
  → march.lightUpNodes()（POST /api/march/light-up，后端点亮并判定勋章，返回 newlyLit + newlyCompletedChapters + newMedals，一次请求完成，不再单独调 /medal/check；V2.0 起点亮不再发积分）
  → 有新点亮/新完成章节时按队列播放「节点抵达事件卡 → 章节完成仪式卡」（utils/arrivePopup.js 共用播放器；march 页另有 Canvas 金光扩散动画）
  → 页面 onShow 时 refresh() 拉最新数据展示；后端同步向管理端广播 data_changed / activity
```

### 4.5 每日答题链路

```
quiz 页（顶部切模式：情报1 即时判定 / 情报2 交卷看解析）→ quiz.getDaily()（GET /api/quiz/daily，后端从题库随机抽 5 题、按用户+日期固定，返回逐题进度）
  → quiz-answer（?mode=instant|review，后端链路完全一致）：quiz.start()（POST /api/quiz/start，幂等开当前题，返回 remainingMs）→ 90s 倒计时内选择并 quiz.answer()（POST /api/quiz/answer，服务端判超时/对错/记分，每题仅一次）
      → instant：反馈（对错/正确答案/解析/本题积分）→ 下一题再 start；review：不揭示对错，静默推进下一题
      → 倒计时归零进入超时态（后端在下次 start 时判该题超时）
  → 5 题结束 redirectTo quiz-result 展示答对数/正确率/积分/超时数与逐题结果（即情报2 的「统一解析」）→ 返回后 quiz 页 refresh() 显示已完成
```

### 4.5b 活动时间窗口（V2.0）

```
launch 登录成功 → activity.getStatus()（失败按可进入处理，后端守卫兜底）
  ├─ allowView=false（已结束且不允许结束后查看 / 未发布等）→ reLaunch 活动状态页
  └─ 否则进入首页；首页 activityBanner：非进行中时展示状态条（已结束：「成绩可查看，不再计分」）
使用中：GET 查看类 403 + X-Activity-Status → request.js 防抖 reLaunch 活动状态页；
        POST 参与类（同步步数/答题/选组织）403 → 页面展示后端提示，不跳转
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
- **星空分层闪烁**：远景微星 110 颗随静态层烘焙（零帧开销，位于山峦之后）；中近景 64 颗（含 9 颗带十字光芒的亮星）在同一 rAF 循环内错峰闪烁——每颗独立周期（约 4.5~18s）/亮度区间/色调（冷白·暖白·淡蓝），约半数用三次方曲线呈「长时间微暗→缓慢增亮→渐暗」呼吸感；位置为均匀散布 + 斜向银河带混合采样并避让节点 16px；当前节点在脉冲环外叠加一层慢呼吸红色柔光。`onHide`/切实景模式即停循环，`onShow` 恢复。
- **tabBar 图标**：原生 tabBar `iconPath`/`selectedIconPath`，资源在 `images/tabbar/<tab>.png`（灰色线框）与 `<tab>-active.png`（主题红实心），81×81 PNG；由 `test/gen-tabbar-icons.cjs` 零依赖生成，改图标改该脚本后重新运行。
- **行军轨迹（006 P0）**：绘制进度统一取后端 `routeProgress`（旧接口降级为步数比例，见 `calcRouteProgress`/`currentRatio`）；步数刷新只从旧进度插值推进到新进度（约 800ms，`progressAnim`），仅首次渲染播放完整入场描画；当前行军点为「呼吸光点（光晕缩放）+ 3 颗上升光尘 + 摆动红旗」。
- **长征章节（006 P0-3）**：章节视图（状态/点亮数/进度/介绍）由后端 `GET /api/march/route` 随路线统一下发；地图上方固定展示当前章节卡（标题 + 已点亮/总数 + 进度条，`progressPct` 渲染前预计算）；章节完成仪式卡由 light-up 响应驱动，与节点抵达卡共用 `utils/arrivePopup.js` 队列播放器（章节卡含历史介绍停留 3400ms，节点卡 2400ms），home 页步数同步弹层同源。
- **开场动画（006 P0-4，需求 §5）**：首次进入长征 Tab 播放完整开场（1934/瑞金 → 长征开始 → 你的长征旅程正式开始，纯 CSS 淡入叠加，无图片无 rAF，总时长约 3.35s），点击任意处跳过；播放标记写 Storage `lm_march_intro_played`；非首次仅 500ms 过渡纱幕（`pointer-events:none` 不拦截操作）。开场期间地图加载/refresh 并发不阻塞；实景镜头俯冲与抵达事件队列延至开场结束补播（`dismissIntro`）。
- **区域氛围（P2-2，需求 §12）**：`data/node-themes.js` 为前端主题映射配置（§12.3 明确允许），10 节点 → 5 区域（瑞金/赤水/泸定/雪山/延安），每主题含渐变色三段与环境粒子配置（ember/mist/snow/star）；应用于节点详情 hero（渐变 + 氛围粒子画布）、星空长征画布（每节点 3 粒环境粒子封顶 30）、实景模式选中节点卡（柔和高光 + 区域标签）。
- **完成仪式（P2-2，需求 §20）**：`GET /march/route` 返回 `ceremonyPending` 时，待抵达/章节弹窗队列播完（`_popupMs`）自动 `navigateTo` 仪式页；开场期间暂缓、离开页面清定时器可重试；仪式页复用 `utils/routeCanvas.js`（从 march.js 抽取的 Catmull-Rom 路线采样/星形/圆角矩形等纯函数，星空长征同源）；确认后 `POST /march/ceremony` 幂等标记，再进为静态回顾态。

### 4.7 扫码确认与身份绑定（微信身份关联）

```
PC 管理后台登录页生成小程序码（POST /api/admin/wechat/qr，mock 模式直接展示 scene 明文）
  → 手机扫码进 bind 页（?scene=L{token}）
      ├─ 未登录：reLaunch launch?redirect=<bind 页带 scene 的完整路径>，自动登录成功 redirectTo 原路返回
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
  → account 页（mine 页入口已隐藏，页面与接口保留）：GET /api/auth/identities 列表
      ├─ wx_mini 登录凭证：isPrimary 标识，不渲染解绑按钮（后端 400 兜底）
      └─ wx_web：showModal 确认后 DELETE /api/auth/identities/{id} 解绑 → 空态
```

## 5. 核心业务规则（与后端完全一致，见 `../backend/design.md` §5）

| 域 | 规则 |
| --- | --- |
| 步数 | 「用户+日期」唯一；一次同步由后端按北京时间处理微信实际返回的最近 7 日，缺失日不写 0 且可重试；首页只展示今天，历史日只影响后端记录/积分 |
| 路线 | 累计步数 ≥ `targetSteps` 即点亮，**永久保留**；节点状态 `completed / current / unlocked`；后台可启停节点，停用节点不可见但已有 `LitNode` 记录保留 |
| 章节 | 5 章配置于后端 `march_service.CHAPTERS`（每章 2 节点，划分可配置）；章内启用节点全点亮即完成，状态 `COMPLETED / ACTIVE / LOCKED`；完成写 `CHAPTER_COMPLETE` 事件并触发前端章节完成仪式，不改变既有节点点亮与积分规则 |
| 答题 | 后端按用户个人历史分轮随机，未使用题优先，同日固定且不重复；不足 5 题按实际题量明确提示。逐题 90 秒服务器计时、每题单次提交规则不变 |
| 积分 | 总积分 = 步行 + 答题：每日最多 20000 步参与计分，按日期累计每满 1000 步 1 分，零头结余到下一条记录（页面展示 walkCarry）；答题每对 1 题 2 分、每日上限 10；后端幂等重算 |
| 组织 | 入驻/首次选定后锁定，用户端不可再改（403 `ORG_LOCKED`），仅管理员后台调整并留审计 |
| 活动 | 后台配置活动时间窗口；未开始/已结束不允许参与（同步、答题、选组织 403）；结束后是否可查看由 `allow_view_after_end` 控制 |
| 连续行军 | 当日步数 ≥ 5000 即完成当日行军；连续天数/最长连续由后端维护并下发 |
| 勋章 | 12 枚分入门/路线/挑战/完成四类（详见 `../backend/design.md` §5）；`fearless` 为隐藏勋章，未获得时展示「神秘勋章」 |
| 身份关联 | 认证（JWT）/身份关联/后台授权三层分离，绑定身份成功**不等于**拥有后台权限；绑定确认页按 scene 前缀分流 L/B 场景；场景凭证单次有效（终态后确认/取消返回错误态）；bind/account 页未登录守卫先经启动页自动登录 |

## 6. 关键设计决策与权衡

1. **服务层封装后端**：页面只面向 service 的返回结构编程；后端响应与历史 Mock 结构一致（camelCase）⇒ 全量切换真实后端（auth/march/quiz/rank/sport/points/medal/org）后页面零改动，仅 service 内部改走 `request.js`。
2. **后端单一数据源**：Mock 阶段的 store 会话缓存已随全量切换退役（仅保留登录数据迁移）；「一处更新多处不同步」由「后端落库 + 各页 onShow 刷新 + 管理端 WebSocket 广播」解决。
3. **onShow + refresh() 统一刷新链**：以「页面显示即拉新」替代手写同步逻辑，杜绝热重载/后台恢复下的旧数据。
4. **Canvas 离屏静态层 + 降级**：星空长征 60fps 动画不阻塞手势；静态背景离屏缓存、星点/星尘/粒子数量固定（粒子单节点≤14、总量≤64，低端减半）、仅当前节点持续动画；低版本基础库自动回退每帧直绘，保证兼容。
5. **头像本地持久化**：`chooseAvatar` 临时路径经 `saveFile` 转持久路径，保证重启后头像仍可显示（生产化需上传后端换 URL，见 `../backend/README.md`）。
6. **路线配置随路线接口统一下发**：节点配置不再内置前端，由后端 `GET /api/march/route` 统一返回，管理后台修改保存后小程序下次刷新即生效。
7. **用户数据无损迁移**：Mock 用户 ID → 后端真实用户 ID 切换时，`store.migrateUserData` 保证本地步数、点亮、积分、勋章不丢失。
8. **扫码确认页单页双模式**：bind 页按 scene 前缀分流 L/B 两种确认卡（文案/操作/结果语义不同），共用加载/完成/错误态；未登录用 launch redirect 自动登录后原路返回而非新流程，场景凭证有效期短不打断。
