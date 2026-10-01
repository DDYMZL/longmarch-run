# 长征步迹 · 高级化功能增强实施计划

> 依据：《长征步迹 · 小程序高级化功能增强需求》(PRD，2026-10-01 附件)
> 现状基线：backend(FastAPI + SQLAlchemy + openGauss) / frontend（原生微信小程序，13 页 4 tab) / admin(Vue3 + Element Plus，无独立 dashboard)
> 决策记录：补签机制本次**跳过**（用户确认），数据模型预留 `is_makeup` / `makeup_at` 字段；年度视图不做，只做活动周期视图。

---

## 0. PRD 功能 → 现状差距总览

| # | PRD 功能 | 现状 | 差距 |
| --- | --- | --- | --- |
| 1 | 我的长征档案 | mine 页仅 4 格统计 | 缺聚合档案页、连续行军、足迹时间轴 |
| 2 | 节点到达动画 | home 页简单弹层逐个播放 | 缺完整动画序列与「抵达事件卡」数据 |
| 3 | 行军日历 | 无 | 全新页面 + 日历接口 |
| 4 | 连续行军机制 | 无 | users 加连续天数字段 + 判定副作用链 |
| 5 | 历史事件卡 | node-detail 仅 description | route_nodes 扩展 7 个内容字段 + 页面改版 |
| 6 | 每日长征播报 | 无 | 新聚合接口（全局 + 个人 + 历史） |
| 7 | 今日长征彩蛋 | 无 | 复用节点历史数据按日期匹配 |
| 8 | 答题升级「今日长征情报」 | quiz 三页，规则已符 | 文案改版 + 期号 + 知识画像（题目加分类） |
| 9 | 勋章体系升级 | 6 枚，无分类/隐藏 | medal_defs 加分类/隐藏/排序 + 新勋章 + 勋章墙 |
| 10 | 管理端活动驾驶舱 | 无 dashboard，进入即排名页 | 新 dashboard 接口 + 新页面 + ECharts |
| 11 | 活动数据大屏 | 无 | 新聚合接口 + 全屏轮播页 |

---

## 1. 数据模型扩展（`docker/init/005_upgrade.sql` + `app/models/models.py` 同步）

### 1.1 users 表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `continuous_days` | INTEGER DEFAULT 0 | 当前连续行军天数（冗余缓存，sport 写入时维护） |
| `max_continuous_days` | INTEGER DEFAULT 0 | 历史最长连续行军天数 |

PRD 建议字段的处理决策：
- `first_login_at`：**不新增**，语义由现有 `created_at` 承担（首次登录即建用户）。
- `nickname_changed_at`：已存在（004 迁移）。
- `first_step_at`：**不新增**，从 `user_event` 的 `FIRST_STEP` 事件 / `daily_sport` 最早记录推导。

### 1.2 daily_sport 表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `distance` | NUMERIC(10,2) DEFAULT 0 | 估算距离（km) = steps × 步长；步长走 `Settings.stride_m`（默认 0.7m，后续可后台配置） |
| `is_goal_completed` | BOOLEAN DEFAULT FALSE | 当日是否达到行军目标（`Settings.streak_goal_steps`，默认 5000)，连续行军判定依据 |
| `is_makeup` | BOOLEAN DEFAULT FALSE | **预留**：补签标记（本次不实现） |
| `makeup_at` | TIMESTAMP NULL | **预留**：补签时间 |

`date` 列即 PRD 的 `step_date`，不改名（避免全链路破坏性变更）。

### 1.3 lit_nodes 表（即 PRD「节点点亮记录」）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `step_snapshot` | INTEGER DEFAULT 0 | 点亮时刻的累计步数快照 |

现有 `lit_at` 即 PRD 的 `unlock_at`，不改名。

### 1.4 route_nodes 表（功能 5 历史事件卡内容字段）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `brief` | VARCHAR(200) DEFAULT '' | 简短描述（列表/彩蛋卡片用） |
| `significance` | TEXT DEFAULT '' | 历史意义 |
| `figures` | VARCHAR(500) DEFAULT '' | 相关人物 |
| `location` | VARCHAR(100) DEFAULT '' | 地理位置文字（如「四川泸定」） |
| `images` | JSON DEFAULT [] | 历史图片 URL 列表 |
| `audio` | VARCHAR(500) DEFAULT '' | 音频 URL |
| `keywords` | VARCHAR(200) DEFAULT '' | 关键词（彩蛋匹配/检索用） |

现有 `description` 继续作为完整历史描述。`seed.py` 同步为 10 个节点补充历史内容（与 `frontend/mock/data.js` 兜底结构同步）。

### 1.5 questions 表（功能 8 知识画像）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `category` | VARCHAR(20) DEFAULT 'event' | 题目分类：`event` 历史事件 / `route` 长征路线 / `figure` 历史人物 |

种子 15 题回填分类。`quiz_records.wrong_list` 元素结构增加 `questionId`、`category`（配合 `daily_questions.question_ids` 全集推导各分类答题总数，算出分类正确率）。

### 1.6 medal_defs 表（功能 9 勋章体系）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `category` | VARCHAR(20) DEFAULT 'starter' | `starter` 入门 / `route` 路线 / `challenge` 挑战 / `complete` 完成 |
| `hidden` | BOOLEAN DEFAULT FALSE | 隐藏勋章（未获得时不公开条件） |
| `sort_order` | INTEGER DEFAULT 0 | 勋章墙排序 |

勋章清单（保留现有 6 枚 + 新增，种子幂等写入）：

| id | 名称 | 分类 | 判定条件 | 积分 |
| --- | --- | --- | --- | --- |
| first-step | 万里第一步 | starter | 有任意运动记录（现有） | — |
| learner | 求知若渴 | starter | 答题 ≥10 次（现有） | — |
| persistence | 坚持不懈 | starter | 连续行军 7 天（**新**） | +10 |
| luding | 飞夺泸定 | route | 点亮节点 6（现有） | — |
| snow | 翻越雪山 | route | 点亮节点 7（现有） | — |
| day-10k | 日行万里 | challenge | 单日 ≥10000 步（**新**） | +10 |
| steps-100k | 十万征程 | challenge | 累计 ≥10 万步（**新**） | +20 |
| steps-500k | 五十万征程 | challenge | 累计 ≥50 万步（**新**） | +50 |
| streak-30 | 铁血行军 | challenge | 连续行军 30 天（**新**） | +30 |
| master | 长征学者 | challenge | 总积分 ≥500（现有） | — |
| fearless | 不畏艰险 | challenge·**隐藏** | 连续 7 天每天 ≥10000 步（**新**） | +50 |
| victory | 大会师 | complete | 点亮全部启用节点（现有） | — |

### 1.7 user_event 表（新增，PRD 16.3 统一事件化）

```sql
CREATE TABLE IF NOT EXISTS user_event (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    event_type VARCHAR(30) NOT NULL,
    event_time TIMESTAMP NOT NULL,
    event_data JSON
);
CREATE INDEX IF NOT EXISTS ix_user_event_user_id ON user_event (user_id);
CREATE INDEX IF NOT EXISTS ix_user_event_time ON user_event (event_time);
```

事件类型枚举（写入点见 §3）：

```
FIRST_STEP          首次运动            data: {steps}
DAILY_GOAL          当日首次达行军目标   data: {date, steps, streak}
NODE_UNLOCK         点亮节点            data: {nodeId, nodeName, stepSnapshot}
BADGE_UNLOCK        获得勋章            data: {medalId, medalName, hidden}
QUIZ_COMPLETE       完成答题            data: {date, score, correctCount}
QUIZ_FULL_SCORE     满分               data: {date}
STREAK_3/7/14/30/60 连续行军里程碑      data: {days}
STEP_10000          单日破万            data: {date, steps}
TOTAL_STEPS_100000  累计破 10 万        data: {totalSteps}
COMPLETE_ROUTE      完成长征路线        data: {totalSteps}
```

- 「我的长征足迹」(§2 接口）直接由该表生成；
- 管理端实时动态（功能 10.6/11.4）同源：WS 推送事件文案 + `GET /admin/activities` 拉最近 N 条（关联 users 取昵称，PRD 明确「不一定永久保存全部动态」，本表即动态源）。

---

## 2. 小程序端接口（camelCase 契约，全部 `Depends(get_current_user)`）

### 2.1 新增 `GET /api/profile/summary`（功能 1 档案聚合）

```jsonc
{
  "user": { "nickname", "avatar", "orgName", "createdAt", "joinDays": 28 },
  "stats": {
    "totalSteps": 128392, "totalDistance": 86.7, "sportDays": 28,
    "currentStreak": 7, "maxStreak": 18, "maxDaySteps": 23821,
    "avgDailySteps": 4585, "progress": 72,
    "litCount": 7, "totalCount": 10,
    "currentNode": { "id", "name", "icon" },
    "nextNode": { "id", "name", "icon", "remain": 12382 }
  },
  "quiz": { "totalCount": 25, "correctRate": 82, "fullScoreCount": 6 },
  "medals": { "ownedCount": 4, "totalCount": 12 },
  "points": { "total": 320 }
}
```

### 2.2 新增 `GET /api/profile/timeline?limit=50`（功能 2.6 足迹）

```jsonc
{ "items": [{ "eventType": "NODE_UNLOCK", "eventTime": "...", "text": "点亮「飞夺泸定桥」", "data": {} }] }
```

`text` 由后端按事件类型生成，前端直接展示。

### 2.3 新增 `GET /api/sport/calendar?month=2026-10`（功能 3 行军日历）

```jsonc
{
  "month": "2026-10",
  "days": [{ "date": "2026-10-01", "steps": 12382, "level": 3,
             "goalCompleted": true, "quizDone": true, "quizScore": 100,
             "litNodes": ["飞夺泸定桥"] }],
  "stats": { "monthSteps": 0, "sportDays": 0, "avgSteps": 0, "maxSteps": 0, "currentStreak": 7 }
}
```

`level`：0=0 步 / 1=1~4999 / 2=5000~9999 / 3=10000+，颜色由前端按 UI 定。

### 2.4 扩展 `GET /api/sport/today`（功能 4 首页连续行军卡）

新增字段：`currentStreak`、`maxStreak`、`streakGoal`(5000)、`todayGoalCompleted`、`nextStreakMilestone`(10)、`streakRemain`(3)。

### 2.5 扩展 `POST /api/march/light-up`（功能 2 到达动画数据）

`newlyLit[]` 每个节点元素新增：`gainedPoints`(10)、`litAt`、`nextNode: {name, remain} | null`。前端据此播放动画序列并弹「抵达事件卡」（🎉 恭喜抵达 / 历史时间 / +N 积分 / 距离下一站 N 步），无需再发请求。

### 2.6 扩展 `GET /api/march/node/{id}`（功能 5 历史事件卡）

新增字段：`brief`、`significance`、`figures`、`location`、`images[]`、`audio`、`keywords`。未解锁查看规则不变。

### 2.7 新增 `GET /api/broadcast/today`（功能 6 播报 + 功能 7 彩蛋）

```jsonc
{
  "global": { "todayUsers": 1286, "todaySteps": 8392821, "todayLitCount": 326,
              "todayQuizUsers": 982, "totalUsers": 2381 },
  "personal": { "todaySteps": 8382, "beatPercent": 76, "remainToNext": 1618,
                "nextNodeName": "夹金山" },
  "memory": { "nodeId": 6, "title": "飞夺泸定桥", "historicalTime": "1935年5月29日",
              "brief": "……" }        // 按当天 月-日 匹配 route_nodes.historical_time，无匹配则轮转推荐
}
```

### 2.8 扩展 `GET /api/quiz/daily` + 新增 `GET /api/quiz/knowledge`（功能 8）

- `quiz/daily` 新增 `issueNo`（第 N 期 = 当天 − `Settings.activity_start_date`（默认 2026-09-01）天数 + 1）。答题规则不变（5 题 × 20 分、+5/满分 +10、答案不下发）。
- `quiz/knowledge`：

```jsonc
{ "categories": [{ "key": "event", "name": "历史事件", "rate": 82 },
                 { "key": "route", "name": "长征路线", "rate": 91 },
                 { "key": "figure", "name": "历史人物", "rate": 73 }],
  "overallRate": 82 }
```

### 2.9 扩展 `GET /api/medal/list`（功能 9 勋章墙）

`medals[]` 元素新增：`category`、`hidden`、`sortOrder`、`grantedAt`、`conditionDesc`（隐藏且未获得时返回「获得条件暂未公布」）。

---

## 3. 后端服务层改动（业务规则）

| 文件 | 改动 |
| --- | --- |
| `services/event_service.py`（新） | `record(db, user_id, event_type, data)` 写 user_event + WS 广播 `activity` 消息（含文案）；`build_text()` 生成动态文案 |
| `services/streak_service.py`（新） | 连续行军判定与维护：当日首次达标时 `continuous_days` 续接/重置、`max_continuous_days` 更新、STREAK 里程碑（3/7/14/30/60）发积分+勋章判定+事件；隐藏勋章「连续 7 天每天 ≥10000」判定 |
| `services/sport_service.py` | sync/add 写入 `distance`、`is_goal_completed`；副作用链挂 streak_service + 事件（FIRST_STEP/STEP_10000/TOTAL_STEPS_100000）；today 响应扩展 streak 字段；新增 calendar 查询 |
| `services/march_service.py` | light-up 响应扩展 + NODE_UNLOCK/COMPLETE_ROUTE 事件；node detail 扩展字段 |
| `services/quiz_service.py` | issueNo；wrong_list 元素加 questionId/category；knowledge 聚合；QUIZ_COMPLETE/QUIZ_FULL_SCORE 事件 |
| `services/medal_service.py` | 新勋章判定（day-10k/steps-100k/steps-500k/streak-30/persistence/fearless）；BADGE_UNLOCK 事件；list 扩展字段 |
| `services/profile_service.py`（新） | summary / timeline 聚合 |
| `services/broadcast_service.py`（新） | 今日播报聚合 + 长征记忆按日匹配 |
| `core/ws.py` | 广播消息新增 `{"type":"activity", "text", "eventType", "userId", "at"}`（管理端动态流）；保留现有 `data_changed` |
| `core/config.py` | 新增 `stride_m=0.7`、`streak_goal_steps=5000`、`activity_start_date="2026-09-01"` |

**不变量遵守**：积分只走 `points_service.grant`；写操作后仍触发 `medal_service.check_and_grant`；事件写入不替代既有副作用链，只是挂接。

---

## 4. 管理端接口（snake_case 契约，`get_current_admin`）

| 接口 | 说明 |
| --- | --- |
| `GET /api/admin/dashboard` | 驾驶舱聚合：metrics（参与人数/今日参与/累计步数/平均步数/节点完成率/答题人数/勋章发放数）+ route_overview（每节点点亮人数/完成率）+ org_stats（组织人数/参与率/累计步数） |
| `GET /api/admin/dashboard/trend?days=7\|30` | 运动趋势：每日总步数/参与人数/新增用户/新增点亮 |
| `GET /api/admin/activities?limit=50` | 实时动态（user_event 关联昵称，倒序） |
| `GET /api/admin/screen` | 大屏聚合（dashboard + activities + 组织榜，单接口减少大屏请求数） |
| 扩展 `GET/POST/PUT /api/admin/route-nodes` | 增改 §1.4 七个内容字段 |
| 扩展 `GET/POST/PUT /api/admin/questions` | 增改 `category` |

WS 复用 `/ws/updates`：驾驶舱/大屏监听 `data_changed` 触发重拉，监听 `activity` 直接插入动态列表。

---

## 5. 小程序端改动（frontend）

### 5.1 tabBar 调整（PRD 十四）

`首页 / 长征 / 情报 / 排行 / 我的`（5 tab）：quiz 页文案改「今日长征情报」（路径不变），rank 由子页升级为 tab。

### 5.2 services 层

- 新增 `profile.js`(summary/timeline)、`broadcast.js`(getToday)；
- 扩展 `sport.js`(getCalendar、today 新字段）、`march.js`(lightUp/detail 新字段）、`quiz.js`(issueNo/getKnowledge)、`medal.js`（新字段透传）。

### 5.3 页面

| 页面 | 改动 |
| --- | --- |
| `pages/home` | 按 PRD 十四重组：今日行军卡（含 beatPercent、remainToNext）→ 我的长征迷你路线 → 连续行军卡（🔥+进度+里程碑）→ 今日长征情报卡 → 今日长征记忆卡（彩蛋，联动 node-detail/quiz) → 我的勋章行；点亮弹层升级为完整「抵达事件卡」 |
| `pages/profile`（新，子页） | 功能 1 完整档案：头部（头像/昵称/组织/参与第 N 天/阶段称号）→ 核心数据 5 格 → 长征进度条+迷你路线 → 历史数据区（正确率/满分次数等）→ 长征足迹时间轴；mine 页加入口 |
| `pages/calendar`（新，子页） | 功能 3 行军日历：月历四档色阶、月统计条、点击日期弹当日详情；profile/首页进入 |
| `pages/march` | 功能 2 到达动画：lightUp 返回后播放序列（轨迹推进→节点发光扩散→图标激活→抵达卡）；已点亮节点点击仅反馈不进动画 |
| `pages/node-detail` | 功能 5 改版：图片→标题→时间/地点→简介→历史意义→相关人物→路线位置（小地图） |
| `pages/quiz`、`quiz-answer`、`quiz-result` | 功能 8 情报化：「今日长征情报 第 N 期」、结果页「情报任务完成/完美通关」、错题解析保留、知识画像区块（接 quiz/knowledge) |
| `pages/medals` | 功能 9 勋章墙：按分类分组、隐藏勋章 🔒 态、点击弹详情（名称/获得时间/条件） |
| `pages/mine` | 数据区改引 profile summary 口径；加「我的长征」「行军日历」入口 |

每页遵守既有不变量：`onShow + refresh()`、数据全部走后端、WXML 无原生方法调用、`wx:key` 用唯一字段。

---

## 6. 管理端改动（admin）

| 项 | 说明 |
| --- | --- |
| `pages/DashboardView.vue`（新） | 功能 10 驾驶舱：指标卡行 → 长征路线总览（节点点亮人数/完成率条形）→ 趋势折线图（引入 **echarts** 依赖，7/30 天切换）→ 组织数据表 → 实时动态（WS activity 流，滚动插入） |
| `pages/ScreenView.vue`（新） | 功能 11 数据大屏：独立全屏路由（不走 AdminLayout)，深色系；中央长征路线 Canvas（复用节点经纬度投影）、四角指标卡、组织排行、实时动态；自动轮播 5 视图（总体/路线/组织/趋势/动态），`?auto=0` 可关 |
| 路由/菜单 | `/dashboard` 注册并设为 `/` 默认重定向；`/screen` 独立路由；AdminLayout 菜单加「驾驶舱」「数据大屏」 |
| `RouteNodesView` | 表单/表格扩展 §1.4 内容字段（图片列表 JSON 编辑用 textarea+校验） |
| `QuestionsView` | 增加分类筛选与编辑 |
| `api/admin.ts` | 新增 dashboard/trend/activities/screen 封装与类型 |

验收按 admin/agents.md：`npm run build` + dev server 浏览器实测（登录、驾驶舱、大屏轮播、WS 动态、筛选、窄屏）。

---

## 7. 实施顺序（每阶段验证通过立即 commit + push）

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| **S1 数据层** | 005_upgrade.sql + models.py + seed.py（节点历史内容/勋章扩展/题目分类）+ mock/data.js 结构同步 | docker init 重跑幂等；TestClient 冒烟 |
| **S2 事件与连续行军** | user_event 链路、event_service、streak_service、sport/quiz/march/medal 副作用挂接 | 冒烟脚本覆盖 streak 续接/中断、事件写入 |
| **S3 小程序接口** | profile/summary、timeline、sport/calendar、sport/today 扩展、light-up 扩展、node detail 扩展、broadcast/today、quiz issueNo+knowledge、medal list 扩展 | TestClient 冒烟 + `backend/test/docs/` 报告 |
| **S4 管理端接口** | admin/dashboard、trend、activities、screen、WS activity、route-nodes/questions 字段扩展 | 冒烟 + WS 验证记录入 docs |
| **S5 小程序页面** | services → home 重组 → profile → calendar → march 动画 → node-detail → quiz 情报化 → medals 墙 → tab 调整 | 微信开发者工具机型测试 + `frontend/test/` 报告截图 |
| **S6 管理端页面** | DashboardView + ScreenView + 节点/题库字段扩展 + echarts | `npm run build` + 浏览器验收 + `admin/test/` 报告截图 |
| **S7 文档收尾** | 三端 design.md/README 同步、根 AGENTS.md 无需改 | 全链路回归（automator 可选） |

---

## 8. 明确不做 / 后续迭代

- **补签（行军补给）**：本次跳过，`is_makeup`/`makeup_at` 字段预留，接口与后台记录后续迭代。
- **年度视图**：活动周期较短，只做月度日历 + 活动周期统计（含在 calendar/profile 接口）。
- **勋章后台配置页**：勋章定义走种子配置，管理端配置页（含隐藏勋章）列 P2。
- **电子纪念证书**（PRD 十七）：完成长征后简版证书卡（前端绘制）列 P2，本次先保证 COMPLETE_ROUTE 事件与 victory 勋章链路。
- **平均步长后台配置**：本期走 `Settings.stride_m` 环境变量，后台配置 UI 列 P2。

## 9. 风险与注意

1. **openGauss JSON 默认值**：005 SQL 中 JSON 列默认值写法需按 openGauss 语法验证（参照 001 现有写法，必要时省略微默认值由 ORM 兜底）。
2. **存量数据回填**：005 需回填 `daily_sport.distance`（steps×0.7/1000)、`is_goal_completed`(steps≥5000)、`lit_nodes.step_snapshot`（无法还原历史快照，回填该用户点亮时未知→填 0 或当前累计，取 0 并在档案接口判空）。
3. **连续天数回填**：`users.continuous_days/max_continuous_days` 由 005 后的一次性回填 SQL（或启动时惰性重算）从历史 daily_sport 计算，避免老用户从 0 开始。
4. **echarts 新依赖**：admin 首次引入，需用户网络可装包；体积按需引入（echarts/core + LineChart)。
5. **契约红线**：小程序接口 camelCase、admin snake_case；答案不下发；积分只走 points_service；种子幂等。
