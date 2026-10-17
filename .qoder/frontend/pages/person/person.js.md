# person.js（页面级合一：person.js / person.wxml / person.wxss / person.json）

## 1. 文件路径

- `frontend/pages/person/person.js`（47 行）
- `frontend/pages/person/person.wxml`（45 行）
- `frontend/pages/person/person.wxss`（114 行）
- `frontend/pages/person/person.json`（3 行）

子页（非 tabBar，`frontend/app.json:19` 注册）。按 `.qoder/README.md` §1「页面级合一例外」规则合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

「长征人物志」详情页（需求 §14，docstring `person.js:1-5`）：按 `?id=` 展示单个**长征历史人物**（后台种子维护的 `persons` 表记录，共 13 位，`.qoder/backend/app/api/routes/persons.py.md` §6——**不是登录用户**）的头像/名称/简介与相关历史事件卡；点击事件卡跳转对应路线节点详情，构成「节点 → 人物 → 节点」双向路径（§14.3，docstring `:4`）。

## 3. 业务需求

- P1-8「长征人物志与答题连胜效果」交付：`2a178b7`（2026-10-03），台账内容「人物/关联表+人物志页+即时判题连胜反馈」（`docs/迭代记录.md` 的 `2a178b7` 条目）。
- 产品路径：人物入口在节点详情的相关人物列表（列表随节点详情下发，本域无 `/persons` 列表端点，`.qoder/backend/app/api/routes/persons.py.md` §7 第 1 条）；本页只做详情。

## 4. 核心功能（person.js）

### 4.1 `data` 状态字段（`:10-15`）

| 分组 | 字段 | 说明 |
|---|---|---|
| 加载态 | `loading`（初始 true）、`errorMsg` | 加载提示 / 错误文案 |
| 内容 | `person`（后端 `PersonDetailOut` 原样入 data：`id/name/avatar/brief/nodes[]`）、`initial`（姓名首字，头像缺失时占位，`:33`） | 无字段裁剪（单人详情体量小） |

### 4.2 生命周期：仅 `onLoad(options)`（`:17-40`）

1. 登录守卫：`!app.globalData.loggedIn` → `wx.reLaunch('/pages/launch/launch')` 并 return（`:18-21`；`frontend/AGENTS.md` §4 不变量 5，守卫由 `e70b59f` 审查批次补齐，`docs/迭代记录.md` 的 `e70b59f` 条目「人物志…页补登录守卫」）。
2. `parseInt(options.id)`，无有效 id 时置 `errorMsg: '人物不存在'`（`:22-26`）。
3. `person.getPerson(id)` 成功：回填 `person`/`initial`，并 `wx.setNavigationBarTitle` 把导航标题改为人名（`:27-36`）；失败统一置「人物加载失败，请稍后重试」（`:37-39`，**不透出后端 detail**）。
4. **无 `onShow/onHide/onUnload`**：人物详情是静态百科内容（后端不随用户/活动变化，`.qoder/backend/app/api/routes/persons.py.md` §4.4、§7 第 4 条），只在进入时拉取一次，未实现不变量 1 的「onShow + refresh()」；页面无定时器/动画/监听器，无需清理。

### 4.3 `goNode(e)`（`:42-46`）

读事件卡 `data-id`（路线节点 id），`wx.navigateTo('/pages/node-detail/node-detail?id=' + id)`；无 id 直接 return。

## 4-1. WXML 专章（person.wxml，45 行）

- 三态：`loading` →「人物加载中…」；`errorMsg` → 错误文案（复用全局 `empty-tip` 样式，`frontend/app.wxss:83`）；否则内容 `block`（`:2-5`）。**错误态无重试按钮**。
- 头部（`:7-14`）：圆形头像，有 `person.avatar` 用 `<image aspectFill>`、否则 `initial` 首字占位（`:9-10`）；名称 + 副题「长征人物志」。
- 人物简介卡（`:17-20`）：`wx:if="{{person.brief}}"`，无简介整卡不渲染。
- 相关历史事件卡（`:23-43`）：`wx:for="{{person.nodes}}" wx:key="id"`，每行 = 节点图标 `item.icon` + 名称 + 历史时间 `item.historicalTime` + 简述 `item.brief`（可选）+ 箭头 `›`；`data-id` + `bindtap="goNode"`；`nodes` 为空时显「暂无关联历史事件」（`:25`）。
- 两张卡带 `anim-card` 入场动画类与递增 `animation-delay`（60ms/140ms，`:17`、`:23`；动画定义在全局 `frontend/app.wxss:300`）。表达式无原生方法调用（`initial` 已在 js 预处理）。

## 4-2. WXSS 专章（person.wxss，114 行）

页面底色 `#f5f3ee`（`:4`）；头部长征红渐变 `#c8102e→#a00d24`（`:13`）；头像 144rpx 圆形、半透明白边、缺图时金底红字首字占位（`:16-37`）；事件行 flex 布局、行间 1rpx 分隔线且末行去线（`:60-69`）；历史时间强调色 `#a00d26`（`:95-100`）。卡片容器样式（`card`/`card-title`）复用全局（`frontend/app.wxss:14`、`:22`），本页未重复定义。

## 4-3. JSON 专章（person.json，3 行）

仅 `navigationBarTitleText: "长征人物志"`——作为进入时的默认标题，加载成功后被 `wx.setNavigationBarTitle` 覆盖为人名（`person.js:35`）。导航栏配色沿用全局 `#C8102E`/white（`frontend/app.json:30-32`）。

## 5. 输入与输出

- 输入：`options.id`（人物 id，int 主键，`.qoder/backend/app/api/routes/persons.py.md` §8 第 2 条）。
- 输出：`GET /api/persons/{id}` → `{id, name, avatar, brief, nodes[]}`（节点含 `id/name/icon/historicalTime/brief`，`.qoder/frontend/services/person.js.md` §5、`.qoder/backend/app/api/routes/persons.py.md` §4.2）。
- 错误路径：401 静默重登（request.js）；404「人物不存在」/403 停用等一律落入 `catch` 显示统一失败文案（`:37-39`）；`nodes[]` 只含启用节点（后端 `is_enabled` 过滤，persons.py.md §7 第 2 条）。

## 6. 依赖关系

- 依赖：`frontend/services/person.js`（`:7`，唯一 service）；`getApp().globalData.loggedIn`（`:6`、`:18`）。**不读写 Storage、无缓存键**。
- 入口（grep 页面路径实测）：节点详情页相关人物 `frontend/pages/node-detail/node-detail.js:210-214`（`goPerson`，注释标「§14.3 节点详情 → 人物」）。自动化测试亦以 `reLaunch('/pages/person/person?id=…')` 直达（`frontend/test/automator/p1-persons-quiz.cjs:286`）。
- 跳出：`node-detail`（事件卡，`:45`）。人物与节点互为出入口，无其他跳转。

## 7. 业务规则

1. **人物数据后端唯一来源**：头像/简介/关联事件均由后台种子与 `person_nodes` 关联表维护，前端只读展示、不本地造数（`frontend/AGENTS.md` §3.1；`.qoder/backend/app/api/routes/persons.py.md` §7）。
2. **`avatar` 是人物图片 URL，不适用用户头像缺口**：与 `.qoder/frontend/services/person.js.md` §7 第 2 条一致——该字段是后端下发的人物头像（只读展示），与「用户头像不上传后端」的架构级限制（`.qoder/PROJECT.md` §8「架构级限制」第 7 项）无关；本页代码亦无任何用户头像读写，仅 `wx:if` 判空 + 首字兜底（wxml `:9-10`）。
3. 静态内容与用户、活动状态无关：后端仅登录鉴权、无活动闸门（`.qoder/backend/app/api/routes/persons.py.md` §4.4），活动结束仍可查阅。

## 8. 修改约束

1. 返回结构 camelCase 硬契约（`historicalTime` 等），改动需与后端 persons 路由/service/schema 及本页同步（`.qoder/frontend/services/person.js.md` §8）。
2. `id` 为数据库自增 int 主键且直接拼 URL（service 未 encodeURIComponent），入口方必须传数值 id（`.qoder/backend/app/api/routes/persons.py.md` §8 第 2 条；`node-detail.js:211-213`）。
3. 登录守卫不得移除（不变量 5）；若人物数据将来改为可后台变更，需按不变量 1 补 `onShow + refresh()`。
4. `wx:key="id"`、无原生方法调用等 WXML 约定（`frontend/AGENTS.md` §5.2）。

## 9. 当前实现状态

- **已实现**：详情展示、首字头像兜底、导航标题动态化、事件卡跳节点、空关联/无简介/无 id/加载失败四种边界；随 `2a178b7` 交付（验证见 §10）。
- **事实陈述（非缺陷）**：① `catch` 丢弃后端错误 detail（如 404「人物不存在」），统一显示「人物加载失败」（`:37-39`），且无重试按钮，用户需返回重进；② 仅 `onLoad` 拉取、无 `onShow` 刷新，基于静态内容属性（§4.2）。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/person`（2 个提交）。按时间倒序。

### 2026-10-11（`e70b59f`）
- 需求：小程序代码审查修复（逻辑/冗余/大数据量性能）。
- 修改内容（涉本页面）：台账明载「答题、结果、人物志、组织选择页补登录守卫；卸载时清理计时器」（`docs/迭代记录.md` 的 `e70b59f` 条目）；本页现行 `onLoad` 守卫（`:18-21`）即该批次产物，本页无计时器故无清理代码。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目（`s16-review-smoke.cjs` 18/18，含 person 页直达项，`frontend/test/automator/s16-review-smoke.cjs:182`）。

### 2026-10-03（`2a178b7`）
- 需求：P1-8 长征人物志（需求 §14）。
- 修改内容（涉本页面）：创建本页面四件套（台账「人物/关联表+人物志页」，`docs/迭代记录.md` 的 `2a178b7` 条目；页面形态另见 `frontend/test/docs/p1-persons-quiz-report.md`）。
- 关联文件：`frontend/services/person.js`、后端 `app/api/routes/persons.py`、`person_service.py`、`seed.py`。
- 测试结果：该台账条目未记录验证字段（待确认）；自动化验收见 `frontend/test/automator/p1-persons-quiz.cjs`。
