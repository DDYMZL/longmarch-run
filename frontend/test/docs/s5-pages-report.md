# S5 小程序页面与交互升级验收报告

日期：2026-10-02 ｜ 阶段：S5（小程序页面与交互）｜ 结论：**通过（断言 11/11，截图 12/12）**

## 1. 升级内容

| 页面 | 改动 |
| --- | --- |
| `pages/home` | 按 PRD 重组：今日行军卡（击败比例/距下一站）→ 迷你长征路线 → 连续行军卡（🔥+里程碑）→ 今日长征情报卡（第 N 期）→ 长征记忆卡 → 我的勋章行；点亮弹层升级为「抵达事件卡」（🎉恭喜抵达/历史时间/+N 积分/距下一站 N 步） |
| `pages/profile`（新） | 我的长征档案：头部（头像/昵称/组织/参与第 N 天/阶段称号）→ 核心数据 5+5 格 → 长征进度条+当前/下一站 → 历史数据 → 长征足迹时间轴 |
| `pages/calendar`（新） | 行军日历：月历四档色阶（0/1-4999/5000-9999/10000+）、答题📝与点亮⭐标记、月统计条、点击日期弹当日详情 |
| `pages/march` | 到达动画：refresh 内先 light-up（幂等）再拉路线；新点亮时插画地图节点发光扩散（双层金环+光晕）+ 逐个播放「抵达事件卡」；已点亮节点点击仅查看详情不进动画 |
| `pages/node-detail` | 历史事件卡改版：图片区(swiper/插画)→标题+关键词→时间/地点→数据卡→简介→历史故事→历史意义→相关人物→路线位置小地图 |
| `pages/quiz*` | 情报化：标题「今日长征情报」+ 第 N 期徽章、破译文案、结果页「情报任务完成/完美通关」、入口页知识画像区块（三分类正确率，接 /quiz/knowledge） |
| `pages/medals` | 勋章墙：按分类分组（入门/路线/挑战/完成）、隐藏未获得 🔒 神秘态、点击弹详情（名称/获得条件/获得时间） |
| `pages/mine` | 数据区改引 /profile/summary 聚合口径；新增「我的长征」「行军日历」入口 |
| `app.json` / `app.wxss` | tab「答题→情报」「排名→排行」；注册 profile/calendar 两新页；progress-bar/link-more 提升为全局共享类 |

数据全部来自后端真实接口（services → request.js → FastAPI 8010），无本地业务数据生成。

## 2. 自动化断言（frontend/test/automator/s5-pages.cjs → results-s5.json）

| # | 用例 | 结果 | 关键数据 |
| --- | --- | --- | --- |
| S5-01 | 首页重组字段齐备（beatPercent/issueNo/连续行军/勋章行/记忆卡） | PASS | issueNo=32 streak=0 memory=飞夺泸定桥 |
| S5-02 | 档案页 summary 聚合 + 阶段称号 + 足迹时间轴 | PASS | joinDays=2 stage=红军新兵 progress=10 timeline=1 |
| S5-03 | 行军日历月历格子 + 月统计条 | PASS | 31 天，title=2026 年 10 月 |
| S5-04 | 日历点击日期弹当日详情 | PASS | date=2026-10-01 |
| S5-05 | 情报页期号 + 知识画像三分类 | PASS | cats=event,figure,route overallRate=0 |
| S5-06 | 勋章墙分类分组 + 计数 | PASS | 入门3/路线2/挑战6/完成1，owned=0 |
| S5-07 | 勋章详情弹层（名称/条件/时间） | PASS | 初次出发 · 完成第一次运动同步 |
| S5-08 | 节点详情简介/时间地点/意义/人物/关键词/小地图 | PASS | brief/keywords=出发地,红色故都,中华苏维埃 |
| S5-09 | 长征页 light-up 幂等（无重复点亮弹层） | PASS | lit=1/10 litPopup=null |
| S5-10 | 长征页插画地图模式切换（到达动画画布就绪） | PASS | mode=canvas |
| S5-11 | 我的：profile 口径 + 我的长征/行军日历入口 | PASS | 两入口均到达目标页 |

执行环境：微信开发者工具自动化端口 9420（执行前按既定协议清理 21 个僵尸 IDE 进程）、后端 8010 真实数据、复用持久登录测试用户（orgId=1）。

## 3. 截图证据（frontend/test/images/，与断言分离独立巡礼 s5-shots.cjs，12/12）

| 文件 | 状态 |
| --- | --- |
| s5-01-home.png | 首页重组（今日行军卡/迷你路线/连续行军/情报/记忆/勋章行） |
| s5-02-home-arrive-card.png | 「抵达事件卡」弹层（合成数据演示：遵义/1935年1月/+10 积分/距下一站 5000 步） |
| s5-03-profile.png | 我的长征档案页 |
| s5-04-calendar.png | 行军日历（月统计条 + 四档色阶 + 图例） |
| s5-05-calendar-detail.png | 日历当日详情弹层 |
| s5-06-quiz.png | 今日长征情报入口（第 N 期 + 知识画像） |
| s5-07-medals.png | 勋章墙分类分组 |
| s5-08-medal-detail.png | 勋章详情弹层 |
| s5-09-node-detail.png | 节点历史事件卡 |
| s5-10-march-canvas.png | 插画地图（星空远征 canvas） |
| s5-11-march-arrive-card.png | 长征页抵达事件卡弹层 |
| s5-12-mine.png | 我的（新入口 + 聚合口径） |

## 4. 过程中修复

- 开发库节点 1 名称被早前管理端测试污染为「瑞金1」，经 admin route-nodes PUT 接口（应用层）恢复为「瑞金」，已复核接口返回正确。
- home.wxss 三处 GBK 乱码注释重写；progress-bar/progress-inner/link-more 由页面级提升为 app.wxss 全局共享（profile/calendar 复用）。

## 5. 遗留说明

- quiz-answer/quiz-result 仅文案与标题情报化，交互逻辑未改（沿用既有满分/零分/重置回归用例）。
- 截图巡礼中「抵达事件卡」以合成节点数据触发（纯 UI 演示，不改业务数据）；真实触发链路已由 S5-09（light-up 幂等）与 S3 冒烟（newlyLit 扩展字段）覆盖。
