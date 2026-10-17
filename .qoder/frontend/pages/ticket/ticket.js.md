# ticket.js（节点纪念票 · 页面级合一：ticket.js / ticket.wxml / ticket.wxss / ticket.json）

## 1. 文件路径

- `frontend/pages/ticket/ticket.js`（168 行）
- `frontend/pages/ticket/ticket.wxml`（20 行）
- `frontend/pages/ticket/ticket.wxss`（57 行）
- `frontend/pages/ticket/ticket.json`（6 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

**「节点纪念票」页（需求 §19，`ticket.js:1-5` 头注释自标）**——这里的 ticket **不是入场券/邀请码凭证/分享卡片**，而是**已点亮长征节点的数字纪念票**：票面含长征步迹标识、节点名、历史日期、「我于{点亮日期}完成该历史节点」宣言、当日/累计步数与合成票号（`:2-3` 注释、`:71-141` 绘制实现）。**Canvas 2D 本地绘制，不依赖服务端图片**（`:4` 注释），可保存到相册（`:143-167`）。与「扫码准入」无关——邀请码链路在 `pages/launch`/`pages/onboard`（§6）。

**入口证据**：生产环境唯一入口是节点详情页「纪念票」跳转 `wx.navigateTo('/pages/ticket/ticket?id=' + node.id)`（`frontend/pages/node-detail/node-detail.js:227`）；本页在 `app.json:20` 注册（非 tab 页）。automator 测试直接 reLaunch（`frontend/test/automator/shot-ticket.cjs:22`、`p2-quote-ticket.cjs:218`）。

## 3. 业务需求

- `71d1b9b`（2026-10-03）「每日寄语与节点纪念票（P2-1）——后台维护有出处语录、首页寄语卡、Canvas 节点纪念票」创建本页（`git log --diff-filter=A` 实测本目录首个提交；`docs/迭代记录.md` 的 `71d1b9b` 条目；验收脚本 `frontend/test/automator/p2-quote-ticket.cjs`、报告 `frontend/test/docs/p2-quote-ticket-report.md`）。
- 需求 §19 原始条目本文档不复制（`.qoder/README.md` §2 分工）；页内证据为 `:2` 注释与 `frontend/design.md` 页面清单「节点纪念票（§19）」行。
- 业务定位：步数点亮节点后的**仪式感/留存物**，与抵达弹层（首页）、完成仪式页（ceremony）同属激励链路（`.qoder/frontend/utils/routeCanvas.js.md` §3 同源绘制工具背景）。

## 4. 核心功能（ticket.js）

### 4.1 `data` 状态字段（`:12-17`）与实例属性

| 分组 | 字段 | 说明 |
|---|---|---|
| 渲染态 | `ready`（`:13`） | 初值 false；数据齐备且开始绘制时置 true（`:41`），驱动 WXML 三态 |
| 错误态 | `error`（`:14`） | 未点亮（`:29`）或加载失败（`:46`）文案 |
| 标题 | `nodeName`（`:15`） | `:41` 写入，**WXML 未渲染**（导航栏标题经 `wx.setNavigationBarTitle` 设置，`:42`）——冗余字段，§9 第 1 条 |
| 保存态 | `saving`（`:16`） | 保存相册防重入（`:147-148`、`:165`） |

实例属性（非 data）：`this._ticket`（`:32-40`，票面视图模型）、`this._canvas`（`:66`，Canvas 节点引用，供 `canvasToTempFilePath` 使用）。

### 4.2 生命周期：仅 `onLoad`（`:19-48`），无 onShow/onHide/onUnload

1. **登录守卫**：`app.globalData.loggedIn` 为假即 `wx.reLaunch('/pages/launch/launch')`（`:20-23`；子页自守卫约定 `frontend/AGENTS.md` §4 不变量 5；reLaunch 目标由 login 改为 launch 见 §10 `01e214a`）。不带 `?redirect=`，登录后不回跳本页（现状事实）。
2. **数据加载**：`Promise.all([march.getNodeDetail(id), march.getFootprints()])`（`:25`，两接口并发单次拉取）；从足迹列表按 id 找点亮记录（`:27`）。
3. **准入门槛**：`node.status !== 'completed'` 或无足迹记录 → `error: '该节点尚未点亮，完成后可生成纪念票'`（`:28-30`）——纪念票**只对已点亮节点开放**，比 node-detail「任意节点可看历史」（不变量 8）更严，二者定位不同不冲突。
4. **票面视图模型 `this._ticket`**（`:32-40`）：`icon/name/historicalTime` 取节点详情；`litDate`（缺省兜底「未知日期」）/`daySteps/cumSteps` 取足迹；`serial` 前端合成票号 `'NO.' + litDate去横杠 + '-' + id补零2位`（`:39`，纯展示字段，不落库）。
5. 置 `ready` + `nodeName`（`:41`）、导航栏标题改「{节点名}纪念票」（`:42`）、`drawTicket()`（`:43`）。任一步骤 reject → `error: '纪念票数据加载失败，请稍后重试'`（`:45-47`）。

本页为一次性生成页（纪念票内容静态），无 onShow 刷新；无定时器、无动画句柄、无 WS 订阅——**无任何需要清理的资源**，`_canvas/_ticket` 引用随页面销毁（对照首页的清理契约 `.qoder/frontend/pages/home/home.js.md` §8 第 1 条，本页无此负担）。

### 4.3 `drawTicket()`（`:50-69`）——Canvas 2D 初始化

`wx.createSelectorQuery().in(this).select('#ticketCanvas').fields({node, size})`（`:54-57`）取 Canvas 节点与 CSS 尺寸；**dpr 适配**：`wx.getSystemInfoSync().pixelRatio || 2`，节点物理尺寸 = CSS 尺寸 × dpr 后 `ctx.scale(dpr, dpr)`（`:61-65`，`:51` 注释「与画像雷达图一致」）；节点引用存 `this._canvas`（`:66`）后调 `paint`（`:67`）。查询失败（无节点）静默 return（`:59`）。走 **Canvas 2D 新接口**（`node.getContext('2d')`，`:64`），全仓无旧版 `createCanvasContext`（`.qoder/frontend/utils/routeCanvas.js.md` §4）。

### 4.4 `paint(ctx, w, h)`（`:71-141`）——票面绘制（自上而下）

| 票面区块 | 行号 | 内容 |
|---|---|---|
| 纸面外框 | `:75-82` | `routeCanvas.drawRoundRect` 圆角矩形（复用共用工具，`:77`），米黄 `#FBF3DC` 填充 + 主色 `#C8102E` 2px 描边 |
| 红色票头 | `:84-94` | 深红 `#A00D26` 圆角头 + `fillRect` 补直角下沿（`:88` 行注释），鎏金 `#F5D9A0` 文字「长征步迹」/「节 点 纪 念 票」 |
| 节点区 | `:96-105` | 44px emoji 图标（缺省 ★ 兜底，`:99`）、节点名（`#5A1A1A`）、历史日期（`#B8860B`） |
| 打孔撕裂线 | `:107-121` | `setLineDash([6,5])` 虚线 + 两侧半圆缺口（双 `arc` 一 fill，`:117-121`）——票根视觉效果 |
| 完成宣言 | `:123-127` | 「我于 {litDate}」/「完成该历史节点」两行 |
| 步数区 | `:129-135` | 当日步数大字（`util.formatNumber` 千分位，`:132`）+ 小字「当日步数 · 累计 N 步」（`cumSteps > 0` 才拼累计段，`:135`） |
| 票号 | `:137-140` | `t.serial` 置底部 |

坐标单位为 CSS px（dpr 已由 `:65` scale 承担，`.qoder/frontend/utils/routeCanvas.js.md` §2 同款约定）；数字格式化用 `util.formatNumber`（`.qoder/frontend/utils/util.js.md` §4 第 3 项，其调用方清单含本页）。

### 4.5 `handleSave()`（`:143-167`）——保存到相册

守卫 `saving || !ready || !_canvas`（`:147`）→ `wx.canvasToTempFilePath({canvas: this._canvas})`（**新接口传 canvas 节点**而非旧版 canvasId，`:149-150`）→ `wx.saveImageToPhotosAlbum`（`:152-162`）：成功 toast「已保存到相册」；失败按 errMsg 匹配 `/auth|authorize/` 区分「请授权保存到相册」与「保存失败」（`:155-160`）；导图失败 toast「生成图片失败」（`:164`）；`complete` 复位 `saving`（`:165`）。**无分享能力**：全文件无 `onShareAppMessage`/`onShareTimeline`（通读核实），纪念票的传播路径是保存相册图片而非小程序分享卡片。

## 4-1. WXML 专章（ticket.wxml，20 行）

三态互斥（`error` → `wx:if`，`ready` → `wx:elif`，否则 loading，`:2-19`）：

1. **错误块**（`:2-5`）：🎫 图标 + `{{error}}` 文案。
2. **票面块**（`:7-17`）：`.ticket-stage` 红渐变票夹内嵌 `<canvas type="2d" id="ticketCanvas">`（`:9-11`，id 与 `:56` SelectorQuery 耦合）；提示文案「长按或点击下方按钮，保存你的长征纪念票」（`:13`，**「长按」无对应事件绑定**，§9 第 2 条）；保存按钮 `loading/disabled="{{saving}}"` + `bindtap="handleSave"`（`:14-16`）。
3. **加载态**（`:19`）：「纪念票生成中…」。

绑定字段仅 `error/ready/saving` 三个；无列表、无原生方法调用（`frontend/AGENTS.md` §5.2）。

## 4-2. WXSS 专章（ticket.wxss，57 行）

- `.ticket-stage`：640×880rpx 固定票夹，红渐变 `linear-gradient(160deg, #C8102E, #7A0E20)` + 20rpx 内衬 + 红色投影（`:10-18`）；`.ticket-canvas` 宽高 100%（`:20-23`）——**画布 CSS 尺寸由该容器决定**，与 `drawTicket` 读取的 size 联动。
- 提示文字鎏金 `#8C6D2F`（`:25-29`）、保存按钮 640rpx 通栏（`:31-34`，`.btn-primary` 复用全局 `frontend/app.wxss`）。
- 错误块/加载态居中排版（`:36-57`）。**选择器逐一核对：无死选择器**（9 个类均在 wxml 出现，两文件已通读）。单位全 rpx。

## 4-3. JSON 专章（ticket.json，6 行）

4 个键：`navigationBarTitleText: "节点纪念票"`（`:2`，运行时被 `ticket.js:42` 按节点名覆写，此值为初始/兜底）、导航栏红底白字（`:3-4`）与 `backgroundColor: "#F7F1E5"`（`:5`）——后三键与 `app.json` `window` 全局默认一致（`frontend/app.json:29-35`），属冗余声明。无 `usingComponents`。

## 5. 输入与输出

- **入参（`onLoad(options)`）**：`id`（节点 id，`parseInt(options.id, 10)`，`:24`；**无 NaN 显式校验**，非法 id 经接口失败落入 `:45-47` 错误态）。
- **出参（调用的 service 与后端路径）**：

| service 调用 | ticket.js 行号 | 后端路径 |
|---|---|---|
| `march.getNodeDetail(id)` | `:25` | `GET /api/march/node/{id}`（`.qoder/frontend/services/march.js.md` §4 表第 2 项；含坐标回退链，本页不消费坐标） |
| `march.getFootprints()` | `:25` | `GET /api/march/footprints`（同表第 5 项；返回已点亮节点 `{id,name,icon,litAt,litDate,daySteps,cumSteps}` 列表，§4.4） |
| `util.formatNumber` | `:132`、`:135` | 纯函数，无请求 |
| `routeCanvas.drawRoundRect` | `:77`、`:85` | 纯函数，无请求 |

- **输出**：Canvas 票面（屏显）+ 相册临时图片（`canvasToTempFilePath` → `saveImageToPhotosAlbum`）。
- **错误出口**：未点亮 / 加载失败两类 `error` 文案；保存链路三类 toast（§4.5）。401 与活动拦截由 request.js 链统一处理（GET 类请求遇 `X-Activity-Status` 403 防抖 reLaunch 活动状态页，`.qoder/frontend/services/march.js.md` §5），页面不感知。

## 6. 依赖关系

- **require（`:6-9`）**：`getApp()`（登录守卫）、`services/march`、`utils/util`、`utils/routeCanvas` 四项，全部有使用。零直接 `wx.request`、零 Storage 读写（`frontend/AGENTS.md` §3.1）。
- **被依赖**：`app.json:20` 注册；`frontend/pages/node-detail/node-detail.js:227` 唯一生产入口（node-detail 文档见 `.qoder/frontend/pages/node-detail/node-detail.js.md`）；`routeCanvas.drawRoundRect` 的第三个消费页（march/ceremony 之外，`.qoder/frontend/utils/routeCanvas.js.md` §2）；`util.formatNumber` 调用方之一（`.qoder/frontend/utils/util.js.md` §6）。
- **测试**：`frontend/test/automator/p2-quote-ticket.cjs`（`:204-246` 纪念票断言与截图）、`shot-ticket.cjs`、`s16-review-smoke.cjs:184`（巡检清单含 ticket）；WXML 配平检查清单含 `ticket.wxml`（`frontend/test/wxml-balance-check.cjs:3`）。
- **数据库表（经接口，不直接触库）**：`route_nodes`、`lit_nodes`、`daily_sport` 等由后端 march 域路由读取（`.qoder/backend/app/api/routes/march.py.md`）。

## 7. 业务规则

1. **仅已点亮节点可生成纪念票**：节点 `status === 'completed'` 且足迹中存在该节点记录，双条件缺一即错误态（`:28-30`）；点亮判定与「点亮永久保留」在后端（`.qoder/frontend/services/march.js.md` §7 第 1 条），本页只读。
2. **票面数据全部来自后端，前端不造业务数据**（`frontend/AGENTS.md` §4 不变量 2）：日期/步数取足迹接口，`serial` 是纯视图合成字段（`:39`）不落库不上送。
3. **登录守卫**：非 tab 子页自守卫 `app.globalData.loggedIn`（不变量 5），未登录 reLaunch 启动页（`:20-23`）；本页不读写登录态 Storage 键（`lm_auth_token`/`lm_login_user` 仅 auth.js/request.js 管理）。
4. **保存相册需用户授权**：授权失败给专项提示（`:156-157`），不代用户调 `openSetting`（现状事实）。
5. **一次性拉取**：详情 + 足迹在 onLoad 并发拉取一轮，页内无重试/刷新入口（错误态仅文案，无「重试」按钮，WXML `:2-5`）——重新进入页面即重试。

## 8. 修改约束

1. **`this._ticket` 字段集与 `paint` 逐字段耦合**（`:32-40` ↔ `:71-141`）：增删票面元素两处同步；`litDate` 兜底「未知日期」（`:36`）与 `serial` 的 `replace(/-/g,'')` 依赖 `litDate` 为 `YYYY-MM-DD` 字符串格式（足迹接口契约，`.qoder/frontend/services/march.js.md` §4.4）。
2. **`#ticketCanvas` id、`type="2d"` 与 `canvasToTempFilePath({canvas})` 传节点**是新接口三件套（`:56`、WXML `:10`、`:150`），不得回退旧版 `canvas-id`/`canvasId` 写法（全仓已无旧接口，`.qoder/frontend/utils/routeCanvas.js.md` §4）。
3. **`drawRoundRect` 必须继续走 `utils/routeCanvas`**：本页曾有私有 `roundRect` 副本，`e70b59f` 审查批次删除并改用共用工具（§10）——不得复制回页面（`frontend/AGENTS.md` §5.1「禁止在多处复制同一工具函数」同旨）。
4. **`.ticket-stage` 的 640×880rpx 决定画布纵横比**：paint 内所有 y 坐标按此比例硬编码（`:75-140`），改容器尺寸需整体重排绘制坐标。
5. dpr 适配（`:61-65`）不得省略，否则真机票面模糊（`:51` 注释与画像雷达图同口径）。
6. 主色/鎏金配色与导航栏约定受全局约束（`frontend/AGENTS.md` §2/§5.3）。

## 9. 当前实现状态

- **已实现**：已点亮节点纪念票的数据加载、准入门槛、Canvas 2D dpr 绘制（纸面/票头/撕裂线/宣言/步数/票号）、保存相册（含授权失败提示）、动态导航栏标题。3 个提交（§10）。
- **存在问题 / 已知事项（事实陈述，均已通读四件套核实）**：
  1. **`data.nodeName` 冗余**：`:15` 声明、`:41` 写入，WXML 从未绑定（标题实际走 `wx.setNavigationBarTitle`，`:42`）——可删字段，现状无害。
  2. **WXML 提示与实现不符**：`:13` 文案「长按或点击下方按钮，保存你的长征纪念票」，但 canvas 未绑定任何长按事件（WXML `:10` 无 `bindlongpress`，js 无对应方法）——「长按保存」实际不可用，仅按钮可保存。是文案遗留还是待实现功能**待确认**。
  3. **`options.id` 无 NaN 校验**（`:24`）：缺失/非数字 id 会请求 `/march/node/NaN`，由后端报错落入 `:45-47` 通用错误态——不崩溃但提示不精确，现状事实。
  4. 登录守卫不带 `?redirect=`（`:21`），未登录用户登录后不回纪念票——与 `frontend/AGENTS.md` §4 不变量 5「需回原页时带 redirect」的可选项一致（本页未启用），现状事实。
  5. 无定时器/动画/订阅，无清理义务（§4.2）；`wx.getSystemInfoSync`（`:61`）为同步系统信息读取，与 march/ceremony 等页同款用法。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --oneline -- frontend/pages/ticket`（**3 个提交**，创建提交经 `--diff-filter=A` 核实；`01e214a`/`e70b59f` 两次对本文件的 diff 已逐一核对），与 `docs/迭代记录.md` 对应条目交叉。按时间倒序。

### 2026-10-11（`e70b59f`，19:18）
- 需求：小程序代码审查修复批次（删除冗余代码、工具函数收敛）。
- 修改内容（涉本文件，据 diff 核实）：删除页内私有 `roundRect` 方法（12 行），两处调用改为 `routeCanvas.drawRoundRect`（现 `:77`、`:85`），新增 `require('../../utils/routeCanvas')`（`:9`）——与 routeCanvas 由 march.js 抽取为共用工具同批（`.qoder/frontend/utils/routeCanvas.js.md` §2）。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目（报告 `frontend/test/docs/s16-miniprogram-review-fixes-report.md`）。

### 2026-10-11（`01e214a`，01:05）
- 需求：V1.0 启动页自动登录——登录守卫回退目标统一为启动页。
- 修改内容（涉本文件，据 diff 核实）：仅 1 行——onLoad 守卫的 `wx.reLaunch` 目标由 `/pages/login/login` 改为 `/pages/launch/launch`（现 `:21`）。
- 测试结果：见 `docs/迭代记录.md` 的 `01e214a` 条目（auth-flow-check 11/11 等，验证主体在启动页与 auth.js）。

### 2026-10-03（`71d1b9b`，23:39）
- 需求：每日寄语与节点纪念票（P2-1，需求 §19）。
- 修改内容（涉本文件）：**创建本页四件套**（`git log --diff-filter=A` 实测）——Canvas 票面绘制、足迹数据合成票号、保存相册；同批交付后台语录维护与首页寄语卡（提交信息）。
- 关联文件：`frontend/pages/home/home.js`（寄语卡）、backend/admin 语录域；`app.json` 注册本页。
- 测试结果：automator `p2-quote-ticket.cjs` 断言与截图（报告 `frontend/test/docs/p2-quote-ticket-report.md`，该报告将本页四件套列为新增范围）；详见 `docs/迭代记录.md` 的 `71d1b9b` 条目。
