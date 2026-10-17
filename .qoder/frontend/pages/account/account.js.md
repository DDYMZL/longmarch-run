# account.js（账号与绑定页 · 页面级合一：account.js / account.wxml / account.wxss / account.json）

## 1. 文件路径

- `frontend/pages/account/account.js`（79 行）
- `frontend/pages/account/account.wxml`（29 行）
- `frontend/pages/account/account.wxss`（104 行）
- `frontend/pages/account/account.json`（5 行）

按 `.qoder/README.md` §1「页面级合一」规则，四件套合并为本文档，WXML / WXSS / JSON 各设专章（§4-1 ～ §4-3）。

## 2. 文件职责

**已绑定身份管理页**（头注释 `account.js:1-3`）：展示当前账号已绑定的微信身份列表（渠道名/AppID/绑定时间），并支持解绑非主身份；`wx_mini` 小程序登录凭证为账号根身份，**不可解绑**。**不是账号注销页，也不是账号信息编辑页**——无注销、无资料修改逻辑（全文件仅 `listIdentities`/`unbind` 两个接口调用，`:32`、`:68`）。

**入口证据**：`app.json:23` 注册。`6ed1999` 交付时含「mine 入口」，后于 `2d20dc9`（2026-10-12）**隐藏**——提交信息「我的页隐藏『账号与绑定』入口（account 页与后端绑定接口保留），身份截图脚本改为直接导航 account 页」（`docs/迭代记录.md` 的 `2d20dc9` 条目）。实测 grep 全 frontend：除 app.json 注册外**无任何页面跳转指向本页**，当前小程序内无入口，仅测试脚本直接导航可达。

## 3. 业务需求

- 身份关联小程序侧（批次 5）`6ed1999`（2026-10-09）交付本页与 bind 扫码确认页（`.qoder/frontend/services/identity.js.md` §3）；后端 4 端点随批次 2 `b431e4d` 交付（`.qoder/backend/app/api/routes/identity.py.md` §3）。
- 业务场景：用户查看自己账号关联了哪些微信身份（小程序登录凭证 + 预留的网页授权身份），并管理（解绑）非根身份；解绑后果是「该身份将无法用于登录 PC 端管理后台」（确认弹窗文案 `account.js:63`）。

## 4. 核心功能（account.js）

### 4.1 模块级常量

`PROVIDER_NAMES`（`:8-12`）：渠道值 → 展示名映射，`wx_mini` → 「微信小程序」、`wx_web` → 「微信网页授权」；未知渠道回退显示原始值（`:37`）。`wx_web` 属半成品渠道——确认/列表/解绑半程就绪，但无生产入口创建绑定凭证（`.qoder/PROJECT.md` §8「架构级限制」第 10 项、identity.py.md §7 规则 5），该映射当前实际不会命中 `wx_web` 行。

### 4.2 `data` 状态字段（`:15-19`）

| 字段 | 说明 | 写入点 |
|---|---|---|
| `loading`（初值 true） | 列表加载中 | `loadList` 置 true（`:30`）、成功/失败复位（`:43`、`:46`） |
| `identities` | 视图行数组（映射见 §4.4） | `:43` |
| `empty` | 空态开关 | `:43`（`items.length === 0`） |

**无定时器、无动画句柄、无事件监听、无实例属性**——未定义 onHide/onUnload 亦无清理债务。

### 4.3 生命周期：`onShow`（`:21-27`）

登录守卫 `app.globalData.loggedIn` 为假 → `wx.reLaunch('/pages/launch/launch')`（`:22-25`，不带 redirect；`frontend/AGENTS.md` §4 不变量 5）；否则 `loadList()`（`:26`）——符合不变量 1「数据展示页必须 onShow + refresh」。无 onLoad。

### 4.4 `loadList()`（`:29-49`）——列表拉取与视图映射

`identity.listIdentities()`（`:32`，`GET /api/auth/identities`）→ 每行映射为视图对象（`:34-42`）：

- `providerName`：`PROVIDER_NAMES[row.provider] || row.provider`（`:37`）；
- `isPrimary`：`row.provider === 'wx_mini'`（`:39`）——**主身份判定在前端按渠道值推导**（后端下发的 `IdentityOut` 无 primary 字段，identity.py.md §4.3）；
- `verifiedAt/createdAt`：`util.formatTime(...)`（`:40-41`，`frontend/utils/util.js:37`；原为页内私有 `formatTime`，`e70b59f` 抽取到 util，§10）；
- 成功单次 setData `identities/empty/loading`（`:43`）；失败复位 loading + toast `err.message` 或「加载失败，请重试」（`:45-48`），**无整页错误态**（空列表与加载失败分别表现为空态卡与 toast）。

### 4.5 `handleUnbind(e)`（`:52-78`）——解绑（破坏性操作）与确认流

1. 从 `dataset` 取 `id/name`（`:53-54`，WXML `:19-20` 注入）；在 `identities` 中找回条目，找不到直接 return（`:55-56`）。
2. **主身份兜底拦截**：`item.isPrimary` → toast「微信登录凭证不可解绑」并终止（`:57-60`，`:51` 注释「主身份按钮不在页面渲染，此处兜底拦截」——WXML 对主身份只渲染「不可解绑」灰字，见 §4-1）。
3. **确认弹窗**：`wx.showModal`「解绑确认」，content 明示后果「解绑后该身份将无法用于登录 PC 端管理后台」，`confirmColor: '#C8102E'`（`:61-64`）。
4. 用户确认后 `identity.unbind(id)`（`:67-68`，`DELETE /api/auth/identities/{id}`）→ 成功 toast「已解绑」+ `loadList()` 重拉（`:69-72`）；失败 toast `err.message` 或「解绑失败，请重试」（`:73-75`）。取消弹窗不做任何事（`:66`）。

归属与主身份校验的权威在后端：非本人/不存在身份统一 400「身份不存在」（不泄露存在性）、`wx_mini` 400「微信登录凭证不可解绑」（identity.py.md §7 规则 2-3）；前端拦截只是交互层兜底，错误 message 经 toast 透传。

## 4-1. WXML 专章（account.wxml，29 行）

1. **页头提示**（`:2`）：「已绑定的微信身份，可用于登录 PC 端管理后台」。
2. **身份卡列表**（`:4-22`）：`wx:for="{{identities}}"` `wx:key="id"`。左部：渠道名 + 标签二选一——主身份「登录凭证」金标（`:8`）、否则 `verifiedAt` 为真时「已验证」绿标（`:9`）；两行 meta：`AppID：{{item.appId}}`、`绑定时间：{{item.createdAt || '—'}}`（`:11-12`）。右部互斥：主身份渲染灰字「不可解绑」（`:14`），否则「解绑」红边按钮 `bindtap="handleUnbind"` 携带 `data-id/data-name`（`:15-21`）。
3. **空态**（`:24-28`）：`wx:if="{{empty && !loading}}"`——🔐 图标 +「暂无已绑定身份」+ 副文案「微信登录后会自动同步小程序登录身份」（`wx_mini` 身份由登录/入驻自动采集，identity.py.md §7 规则 4）。

约定核对：表达式无原生方法调用（时间格式化在 js 完成）；`wx:key` 用 `id` 而非 index。**注意 `verifiedAt` 仅参与标签真值判断（`:9`），格式化后的文本本身未渲染**——现状事实（`:40` 的格式化产出只服务于该判断）。

## 4-2. WXSS 专章（account.wxss，104 行）

- **全部本地定义，不依赖 app.wxss 类**（无 card/btn-* 引用；解绑按钮是自绘 `view` 非 `<button>`）。
- 页面底色 `#F7F1E5`（`:1-6`，全局约定色）；`.identity-card` 白底 18rpx 圆角卡 + 红调浅阴影（`:14-23`）。
- 标签两态：`.identity-tag` 金底棕字（`:41-49`），`.identity-tag.verified` 绿系变体（`:51-55`）；`.identity-meta` 灰字单行 ellipsis 截断（`:57-64`）。
- 右侧操作区：`.identity-unbind` 红字红边胶囊（主色 `#C8102E`，`:66-74`）、`.identity-lock` 灰字（`:76-81`），均 `flex-shrink: 0`。
- 空态三行居中（`:83-104`）。单位全 rpx；无 keyframes、无动画。
- 无死选择器：15 个类名逐一与 account.wxml 比对均有使用。

## 4-3. JSON 专章（account.json，5 行）

仅 3 个键：`navigationBarTitleText: "账号与绑定"`、`navigationBarBackgroundColor: "#C8102E"`、`navigationBarTextStyle: "white"`——颜色与 `app.json` `window` 全局默认一致（`frontend/app.json:29-35`，转引自 `.qoder/frontend/pages/home/home.js.md` §4-3 实测记录），属冗余声明、改动无行为差异。无 `usingComponents`、无下拉刷新配置。

## 5. 输入与输出

- **入参**：无（不读 query，无 onLoad）。
- **出参（页面调用的 service 与后端路径）**：

| service 调用 | account.js 行号 | 后端路径 |
|---|---|---|
| `identity.listIdentities()` | `:32` | `GET /api/auth/identities`（`.qoder/frontend/services/identity.js.md` §4 表行 3；响应 `IdentityOut` 不含 openid，identity.py.md §4.3） |
| `identity.unbind(id)` | `:68` | `DELETE /api/auth/identities/{id}`（同表行 4） |

- **错误出口**：列表失败与解绑失败均 toast（`:47`、`:74`）；401 静默重登由 request.js 链处理，页面不感知。

## 6. 依赖关系

- **require（`:4-6`，3 项全部有使用）**：`app = getApp()`（仅读 `globalData.loggedIn`）、`services/identity`（2 处调用见 §5）、`utils/util`（`formatTime`，`:40-41`）。零直接 `wx.request`、零 Storage 读写（`frontend/AGENTS.md` §3.1/§6.5）。
- **被依赖**：`app.json:23` 注册；**当前无页面级入口**（§2，`2d20dc9` 隐藏 mine 入口后仅 automator 截图脚本直接导航，`frontend/test/automator/` 身份截图脚本，2d20dc9 提交信息）。
- **数据库表**：前端不触库；后端读/删 `user_identities`、写 `audit_logs`（identity.py.md §6）。

## 7. 业务规则

1. **登录守卫与缓存键**：本页不读写任何 Storage 键；守卫只认 `app.globalData.loggedIn`（`:22-25`）。
2. **主身份不可解绑双保险**：前端按 `provider === 'wx_mini'` 推导 `isPrimary`（`:39`）做渲染与兜底拦截（`:57-60`）；后端独立校验 400（identity.py.md §7 规则 3）。若后端新增渠道成为根身份，前端该推导需同步。
3. **破坏性操作确认流**：解绑必须经 `wx.showModal` 二次确认且文案明示后果（`:61-64`），确认后才发 DELETE。
4. **每次操作后重拉**：解绑成功不复用本地数组删行，而是 `loadList()` 全量重拉（`:71`）——列表以后端为准（不变量 2）。
5. **wx_web 行可渲染可解绑**：本页已备好该渠道的展示名与解绑路径，但生产环境不会出现 `wx_web` 行（凭证创建入口缺失，`.qoder/PROJECT.md` §8「架构级限制」第 10 项）。

## 8. 修改约束

1. `PROVIDER_NAMES` 与后端 provider 取值（`wx_mini`/`wx_web`，identity.py.md §7 规则 4）是展示契约；未知渠道回退原始值（`:37`），新增渠道无需改页但建议补映射。
2. `IdentityOut` 字段（`id/provider/appId/unionid/verifiedAt/createdAt`，不含 openid）是渲染契约（identity.py.md §8.3：不得新增 openid 字段）；`wx:key="id"` 依赖行 id 稳定。
3. 解绑错误 message 直接透传 toast（`:74`），后端「非本人 = 不存在」同文案安全设计（identity.py.md §8.4）依赖前端不做二次演绎——勿在页面按状态码区分提示。
4. `util.formatTime` 为共享工具（`e70b59f` 从本页抽取），改其行为会波及其他消费页，勿在本页内再复制私有实现（`frontend/AGENTS.md` §5.1）。
5. 若恢复入口（如重新挂回 mine 页），页面自身无需改动；入口增删属 mine 页职责（`2d20dc9` 先例）。

## 9. 当前实现状态

- **已实现**：列表 + 空态 + 主身份标识 + 解绑确认流全部可用，随 `6ed1999` 交付并经 automator 15/15 断言 + 6 截图验收（identity.js.md §9；报告 `frontend/test/docs/identity-bind-account-report.md`，identity.py.md §9 转引）。
- **存在问题 / 已知事项（事实陈述）**：
  1. **小程序内无入口**：`2d20dc9` 隐藏 mine 入口后，普通用户不可达本页（页面与后端接口保留，提交信息明示有意为之）；是否恢复入口属产品决策，**待确认**。
  2. `verifiedAt` 经 `util.formatTime` 格式化（`:40`）但格式化文本未渲染，仅真值参与「已验证」标签判断（WXML `:9`）——冗余计算极轻微，现状事实。
  3. 列表加载失败无整页错误态（仅 toast，`:45-48`）：首屏失败时 `identities=[]` 且 `empty` 保持初值 false（`:43` 未执行），页面只剩页头提示行、连空态卡都不出现；已有数据时重拉失败则保留旧列表——现状事实，是否需要错误态**待确认**。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/pages/account/`（**3 个提交**），均已核对存在于 `docs/迭代记录.md`。按时间倒序。

### 2026-10-11（`e70b59f`）
- 需求：小程序代码审查修复批次。
- 修改内容（涉本文件，diff 实读）：删除页内私有 `formatTime`，改用 `utils/util.js` 的 `util.formatTime`（`:6`、`:40-41`），属「禁止在多处复制同一工具函数」清理（`frontend/AGENTS.md` §5.1）。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目。

### 2026-10-11（`01e214a`）
- 需求：V1.0 启动页自动登录并取消强制选组织。
- 修改内容（涉本文件，diff 实读）：onShow 未登录守卫由 `reLaunch /pages/login/login` 改为 `reLaunch /pages/launch/launch`（现 `:23`）。
- 测试结果：见 `docs/迭代记录.md` 的 `01e214a` 条目。

### 2026-10-09（`6ed1999`）
- 需求：身份关联小程序侧（批次 5）。
- 修改内容（涉本目录）：创建四件套（身份列表 + 解绑 + mine 入口）；同批交付 bind 扫码确认页、`services/identity.js` 与 login redirect 支持（提交信息）。
- 关联文件：`frontend/pages/bind/bind.js`、`frontend/services/identity.js`、`backend/app/api/routes/identity.py`。
- 测试结果：automator 15/15 断言 + 6 截图验收（提交信息）；详见 `docs/迭代记录.md` 的 `6ed1999` 条目。

**关联提交（不改本目录）**：`2d20dc9`（2026-10-12）隐藏 mine 页「账号与绑定」入口、身份截图脚本改为直接导航本页——本目录四件套无 diff（`git log --follow` 未命中），见 `docs/迭代记录.md` 的 `2d20dc9` 条目。
