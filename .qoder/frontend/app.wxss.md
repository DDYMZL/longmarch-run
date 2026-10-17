# app.wxss

## 1. 文件路径

`frontend/app.wxss`（326 行）

## 2. 文件职责

小程序的**全局样式层**：定义 `page` 基线（背景/字色/字号/行高/字体族）、一套跨页面复用的组件类与工具类（卡片、按钮、文字色、占位、分割线、进度条、答题进度点），以及一个集中的 `@keyframes` 动画库 + 4 个动画工具类 + 减弱动效降级。微信框架把它自动应用于全部 25 个注册页面（`frontend/app.json:2-28`），页面级 `<页>.wxss` 在其之后层叠覆盖。文件头 `:1-4` 自述主题：「红色主色 + 金色辅助 + 米白背景，历史感 + 运动感」。

## 3. 业务需求

- 视觉基线（导航栏主色 `#C8102E`、背景 `#F7F1E5`）来自 `frontend/AGENTS.md` §2 表「视图」行；§5.2 明确「复用全局样式放 `app.wxss`」「页面级样式不覆盖 tabBar 与导航栏约定色」。
- 「答题逐题进度点」服务于 90 秒逐题限时答题（`docs/迭代记录.md` 的 `44eb77b` 条目，V2.0）；「彩带飘落（满分庆贺）」`:277` 服务于答题满分反馈。
- 减弱动效降级（`:317-326`）为无障碍/低性能设备兜底。

## 4. 核心功能

按层归纳，不逐条罗列规则。

### 4.1 基线层：`page`（`:5-11`）

`background: #F7F1E5`（`:6`，与 `frontend/app.json:33` 的 `window.backgroundColor` 同值，下拉回弹无色差）、`color: #333333`（`:7`）、`font-size: 28rpx`（`:8`）、`line-height: 1.6`（`:9`）、`font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif`（`:10`）。全站 rpx 单位（`frontend/AGENTS.md` §2）。

### 4.2 共享组件/工具类（`:13-120`）

| 类 | 行 | 要点 | 实测使用面（页面 WXML 命中文件数） |
|---|---|---|---|
| `.card` | `:14-20` | 白底、圆角 20rpx、内边距 30rpx、外边距 `20rpx 30rpx`、暖红低透阴影 `rgba(140,30,30,0.06)` | 12（含 `class="card ..."` 组合；calendar/home/mine/node-detail/person/points/profile/quiz/quiz-answer/quiz-records/quiz-result/sport-records） |
| `.card-title` | `:22-30` | 30rpx/600/深红 `#5A1A1A`，`flex + space-between`（便于右侧挂 `.link-more`） | 9 |
| `.btn-primary` | `:33-42` | 红渐变 `linear-gradient(135deg,#C8102E,#A00D26)`、圆角 48rpx、红色投影 | 12 |
| `.btn-primary::after` | `:44-46` | `border: none`，去掉原生 `<button>` 默认边框 | — |
| `.btn-primary[disabled]` | `:48-52` | 灰底 `#CCCCCC`、去投影 | — |
| `.btn-ghost` | `:55-63` | 白底红字红边（2rpx）次级按钮 | 5 |
| `.btn-ghost::after` | `:65-67` | 同上去边框 | — |
| `.text-gold` / `.text-red` / `.text-gray` | `:70-72` / `:74-76` / `:78-80` | 金 `#D4A017` / 红 `#C8102E` / 灰 `#999999` 文字色工具类 | 3 / 1 / 1 |
| `.empty-tip` | `:83-88` | 居中灰字空态占位（26rpx，上下 60rpx） | 10 |
| `.divider` | `:91-95` | 1rpx 米色 `#F0E6D2` 分割线 | 6 |
| `.progress-bar` / `.progress-inner` | `:98-104` / `:106-113` | 20rpx 高轨道 + 金渐变填充，`transition: width 0.4s ease`；`:97` 注释标「首页/profile 共用」 | 2 / 2（实测仅 `pages/home/home.wxml`、`pages/profile/profile.wxml`） |
| `.link-more` | `:116-120` | 卡片标题右侧「更多」链接，26rpx 红字、`font-weight: normal` 抵消 `.card-title` 的 600 | 2 |

### 4.3 答题逐题进度点（`:122-164`）

`:122` 注释标「quiz 页 / 答题页共用」（该注释在 `0052108` 由「情报 tab / 答题页共用」改写，见 §10）。容器 `.quiz-dots`（`:123-126`，flex 居中）+ 圆点 `.quiz-dot`（`:128-138`，44rpx 正圆、`#B8A27A` 字色、`rgba(240,230,210,0.9)` 底）。5 个状态修饰类，与后端判题结果一一对应：

| 状态类 | 行 | 底色 | 语义 |
|---|---|---|---|
| `.quiz-dot.answering` | `:140-144` | `#D4A017` + 6rpx 金色光环 | 当前作答中 |
| `.quiz-dot.done` | `:146-149` | `#8C97A3` | 已作答未判（`2ea4797` 新增，见 §10） |
| `.quiz-dot.right` | `:151-154` | `#2E9E5B` | 答对 |
| `.quiz-dot.wrong` | `:156-159` | `#C8102E` | 答错 |
| `.quiz-dot.timeout` | `:161-164` | `#8A8A8A` | 超时 |

实测消费方恰好 2 个页面：`pages/quiz/quiz.wxml`、`pages/quiz-answer/quiz-answer.wxml`，与注释一致。状态值由 js 侧算好后作为类名拼接下发（WXML 不支持原生方法调用，见 `frontend/AGENTS.md` §5.2）。

### 4.4 全局动画体系（`:166-326`）

`:166` 为分节注释。**11 个 `@keyframes`**（定义在全局，页面 wxss 亦可直接按名引用）：

| 关键帧 | 行 | 效果 | 实测消费方 |
|---|---|---|---|
| `cardIn` | `:169-178` | 上移 50rpx + 缩放 0.96 淡入 | `pages/march/march.wxss` |
| `fadeUp` | `:181-190` | 上浮 36rpx 淡入 | `.anim-card`（`:302`）+ login/march/node-detail/quiz-answer/quiz-result 的 wxss |
| `fadeLeft` | `:193-202` | 左滑 50rpx 淡入 | **无任何消费方**（见 §9 第 1 项） |
| `popIn` | `:205-217` | 0.2→1.12→1 弹性弹出 | `.anim-pop`（`:306`）+ home/login/march 的 wxss |
| `spinIn` | `:220-229` | 旋转 -200° + 缩放 0.3 入场 | `pages/home/home.wxss`、`pages/march/march.wxss` |
| `pulseGlow` | `:232-239` | 金色呼吸光晕（box-shadow 16↔40rpx） | `.anim-glow`（`:314`）+ `pages/march/march.wxss` |
| `pulseRed` | `:242-249` | 红色脉冲扩散（0→18rpx 淡出） | `pages/home/home.wxss`、`pages/march/march.wxss` |
| `floaty` | `:252-259` | 上下 14rpx 悬浮 | `.anim-float`（`:310`），无页面级直接引用 |
| `starPop` | `:262-275` | 星星逐个点亮（0→1.5→1 带旋转） | `pages/quiz-result/quiz-result.wxss` |
| `confettiFall` | `:278-287` | 彩带飘落（-120→1050rpx + 660° 旋转），`:277` 注释标「满分庆贺」 | `pages/quiz-result/quiz-result.wxss` |
| `shimmer` | `:290-297` | 进度条流光（translateX -120%→320%） | `pages/home/home.wxss` |

**4 个动画工具类**（`:299-315`，`:299` 注释「通用动画工具类」）：`.anim-card`（`:300-303`，`opacity: 0` + `fadeUp 0.55s ease forwards`）、`.anim-pop`（`:305-307`，`popIn 0.5s cubic-bezier(0.34,1.56,0.64,1) both`）、`.anim-float`（`:309-311`，`floaty 3.2s ease-in-out infinite`）、`.anim-glow`（`:313-315`，`pulseGlow 2.4s ease-in-out infinite`）。实测 WXML 命中：`.anim-card` 9 个页面、`.anim-pop` 6 个、`.anim-float` 2 个、`.anim-glow` 2 个；四者合计覆盖 12 个页面（activity、calendar、home、march、medals、mine、node-detail、person、points、profile、quiz、quiz-result）。

**减弱动效降级**（`:317-326`）：`@media (prefers-reduced-motion: reduce)` 中对上述 4 个工具类统一 `animation: none !important; opacity: 1 !important;`。`:317` 注释明确「内容直接可见」——`opacity: 1` 的覆盖是必要的，否则 `.anim-card` 的初始 `opacity: 0`（`:301`）会让内容在关闭动画后永久不可见。

### 4.5 **本文件不含 CSS 自定义属性**

通读 326 行 + grep 核实：`app.wxss` 中**没有任何** `--*` 变量声明或 `var(...)` 引用，全部颜色（`#C8102E`、`#D4A017`、`#F7F1E5`、`#5A1A1A`、`#F0E6D2`、`#8C97A3`、`#2E9E5B`、`#8A8A8A` 等）与尺寸均为**字面量硬编码**。仓库内唯一的自定义属性出现在页面级：`frontend/pages/home/home.wxss:492-493`（`.lit-particle.p1/.p2` 的 `--dx`/`--dy` 粒子位移）。因此「改主题色」需要在本文件多处字面量 + `frontend/app.json:30`、`:33` + 各页面 wxss 同步替换，无单点开关（见 §8 第 3 条）。

## 5. 输入与输出

- 输入：无（纯声明式样式，无 `@import`、无 WXSS 变量、无预处理器）。
- 输出：作用于全部页面的样式规则；页面 `<页>.wxss` 按「后加载覆盖」规则层叠在其上（`frontend/AGENTS.md` §5.2 约束页面级不得覆盖导航栏/tabBar 约定色）。
- 生效范围：全局类名与关键帧对所有页面可见；关键帧被 6 个页面 wxss 按名直接引用（§4.4 表），删名即断。

## 6. 依赖关系

- **依赖**：无外部依赖。
- **被依赖（类名消费方，实测 grep 页面 WXML/WXSS）**：12 个页面用 `.card`（清单见 §4.2）、12 个用 `.btn-primary`、10 个用 `.empty-tip`、9 个用 `.card-title` 与 `.anim-card`、6 个用 `.anim-pop`、5 个用 `.btn-ghost`、2 个用 `.progress-bar`/`.progress-inner`/`.link-more`/`.quiz-dots`/`.anim-float`/`.anim-glow`；关键帧被 home、march、login、node-detail、quiz-answer、quiz-result 的页面 wxss 直接引用。
- **配色契约**：与 `frontend/app.json:30`（导航栏 `#C8102E`）、`:33`（窗体 `#F7F1E5`）、`:37-38`（tabBar `#999999`/`#C8102E`）互为约定色；`:6` 的 `page` 背景与 `app.json:33` 必须同值。
- 不涉及后端接口、数据库、服务层。

## 7. 业务规则

1. **答题状态 → 颜色映射是业务语义**（§4.3 表）：绿=对、红=错、灰=超时/未判、金=作答中。改配色即改用户对判题结果的读法，需与后端判题字段口径同步（判题与限时规则见 `frontend/AGENTS.md` §4 第 4 条「业务规则与前端 Mock 一致」及 `docs/迭代记录.md` 的 `44eb77b` 条目）。
2. **`.anim-card` 依赖 `animation-fill-mode: forwards`**（`:302`）把终态 `opacity: 1` 保留；若改成 `none` 或删除，元素会回落到 `:301` 的 `opacity: 0` 而消失。同理 `.anim-pop` 用 `both`（`:306`）。
3. **减弱动效不是可选装饰**：`:317-326` 的 `opacity: 1 !important` 是 §7 第 2 条的必要配套，两者必须同时修改。
4. **Canvas 绘制不走本文件**：march 页星空远征插画地图、ticket 页纪念票、ceremony 页仪式动画均在 js 内用 Canvas 2D 绘制（`frontend/AGENTS.md` §4 第 6 条），本文件的 `@keyframes` 对画布内容无效，只作用于 DOM/WXML 节点。

## 8. 修改约束

1. **禁止删除或重命名仍被页面 wxss 按名引用的关键帧**（`cardIn`、`spinIn`、`pulseRed`、`pulseGlow`、`starPop`、`confettiFall`、`shimmer`、`fadeUp`、`popIn`；消费方见 §4.4 表）——本文件的 `@keyframes` 是跨文件共享符号，重命名不会有任何编译期报错，只会在真机上静默失去动画。
2. **新增全局类前先 grep 页面 wxss 是否已有同名类**：页面级同名规则会覆盖全局（层叠顺序），造成「改了 app.wxss 不生效」的假象。
3. 主题色为字面量硬编码（§4.5），改色需同步本文件多处 + `frontend/app.json` 的 `window`/`tabBar` + 各页面 wxss；`frontend/AGENTS.md` §5.2 禁止页面级覆盖约定色，即改色的权威落点在本文件与 `app.json`。
4. 单位统一 rpx（`frontend/AGENTS.md` §2、§5.2）；本文件唯一非 rpx 数值是 `page` 的 `line-height: 1.6`（无单位倍数，`:9`）与 `transition: width 0.4s`（`:110`）、动画时长（`:302`、`:306`、`:310`、`:314`）。
5. 动画性能：`.anim-float`/`.anim-glow` 为 `infinite`（`:310`、`:314`），只应用于少量元素；根 `agents.md` §2.4 要求关注列表渲染性能，长列表逐项挂无限动画会持续占用合成线程。

## 9. 当前实现状态

- **已实现**：基线 + 12 组共享类 + 答题进度点 5 态 + 11 个关键帧 + 4 个动画工具类 + 减弱动效降级，均有真实消费方（§4.2、§4.3、§4.4 的实测命中数）。
- **存在问题 / 已知事项**：
  1. **`fadeLeft`（`:193-202`）为零引用死代码**：本文件的工具类未用它，6 个页面 wxss 也无命中（grep `frontend/pages/**/*.wxss`）。可删；是否保留待后续页面复用属**待确认**。
  2. **命名与实现不符**：`.anim-card`（`:300-303`）实际用的是 `fadeUp` 而非 `cardIn`；`cardIn` 只被 `pages/march/march.wxss` 直接引用。类名易误导维护者。
  3. **无主题变量层**（§4.5）：主题色散落为字面量，缺少 `--lm-red` 之类的单点开关；`frontend/pages/home/home.wxss:492-493` 已局部使用自定义属性，说明技术上可行。是否引入全局变量层**待确认**（引入需评估低版本基础库对 WXSS 自定义属性的支持面）。
  4. `.text-red`、`.text-gray` 实测各仅 1 个页面 WXML 命中（§4.2），复用度低但属正常工具类冗余，不建议删（页面 wxss 可能以组合类名间接命中，本次统计口径为 WXML 子串匹配）。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/app.wxss`，共 **5 个提交**。按时间倒序。`0052108`、`2ea4797` 两项经 `git show` 逐行核实；其余据提交信息与本文件现存内容推断，已标注。

### 2026-10-17（`0052108`，11:06）
- 需求：新增 AI 历史助手聊天页，底部「情报」tab 替换为「AI 问答」（答题降级为首页情报卡入口子页）。
- 修改内容（`git show` 核实）：**仅改 1 行注释**——`:122` 由「答题逐题进度点（情报 tab / 答题页共用）」改为「答题逐题进度点（quiz 页 / 答题页共用）」，随 quiz 从 tab 降级为子页同步措辞。无样式规则变更。
- 关联文件：`frontend/app.json`（tab 替换）、`frontend/pages/ai-chat/*`（新建）。
- 测试结果：见 `docs/迭代记录.md` 的 `0052108` 条目。

### 2026-10-13（`2ea4797`，15:18）
- 需求：情报 tab 新增「情报2·交卷看解析」答题交互，供对比演示。
- 修改内容（`git show` 核实）：新增 `.quiz-dot.done`（现 `:146-149`，底色 `#8C97A3`）——「已作答但未判题」状态需要区别于对/错的中间色，配合「交卷后统一看解析」的交互。
- 关联文件：`frontend/pages/quiz/*`、`frontend/pages/quiz-answer/*`。
- 测试结果：见 `docs/迭代记录.md` 的 `2ea4797` 条目。

### 2026-10-13（`44eb77b`，13:25）
- 需求：V2.0 小程序——答题 90 秒逐题限时、积分排行榜、我的积分卡与积分明细页、我的长征荣誉卡、活动状态页与查看拦截、组织锁定只读；新增 v2 自动化验收（14/14）与报告。
- 修改内容（涉本文件，据提交信息推断）：为 V2.0 新页面补全局共享类/动画。**具体新增哪些规则未逐行核对 diff，待确认**；现存 `.quiz-dot.answering`/`.timeout`（`:140-144`、`:161-164`）与「90 秒逐题限时」语义相符，可能属本批。
- 关联文件：`frontend/pages/points/*`、`frontend/pages/activity/*`、`frontend/pages/rank/*`、`frontend/app.json`。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目（提交信息记为 v2 自动化验收 14/14）。

### 2026-10-02（`7e587c9`，11:13）
- 需求：小程序页面高级化升级（首页重组/档案/行军日历/到达动画/情报化/勋章墙）。
- 修改内容（涉本文件，据提交信息推断）：引入「全局动画体系」分节（现 `:166-326`）与卡片/进度条等共享类，支撑「到达动画」「勋章墙」等高级化视觉。**具体新增范围未逐行核对 diff，待确认**。
- 关联文件：`frontend/pages/home/*`、`frontend/pages/profile/*`、`frontend/pages/calendar/*`、`frontend/pages/medals/*`、`frontend/app.json`。
- 测试结果：见 `docs/迭代记录.md` 的 `7e587c9` 条目。

### 2026-09-30（`a94e685`，18:05）
- 需求：项目初始化（`feat: init`）。
- 修改内容（涉本文件）：创建本文件，含 `page` 基线与初版通用类。初始内容未逐行核对。
- 关联文件：全仓初始骨架。
- 测试结果：初始提交；本文件单独的验证结论**待确认**（见 `docs/迭代记录.md` 的 `a94e685` 条目）。
