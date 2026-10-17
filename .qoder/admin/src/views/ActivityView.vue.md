# ActivityView.vue

## 1. 文件路径

`admin/src/views/ActivityView.vue`（317 行）

## 2. 文件职责

「活动设置」页（`<script setup>` 单文件组件）：维护 `activity_settings` 表的**唯一一行**活动配置——活动名称、起止时间（北京时间、精确到分钟）、「启用时间限制」总开关、「结束后可浏览」开关、结束页标题与寄语；并提供**发布 / 撤回**两个状态动作。页面用**服务端时间校准**（`clockOffset`）驱动秒级倒计时，倒计时归零自动重拉状态；实时展示后端派生的活动状态（未发布 / 未开始 / 进行中 / 已结束）、两项准入结果（小程序参与 / 小程序浏览）与拒绝文案，并预览结束页效果。本页是「活动时间窗口控制全小程序准入」这一 V2.0 需求在管理端的唯一控制台。

## 3. 业务需求

- 需求出处：`.qoder/REQUIREMENTS.md` §1「活动时间控制与准入」（§1.1 规则表各行、§1.2「前端行为」中关于本页 `clockOffset` 服务器时间校准的一条、§1.3 待确认）、§11.4「活动配置」（四行全部指向本文件）、§11.1「菜单与权限」。
- 数据库：`docker/init/016_activity_settings.sql` 建 `activity_settings` 表并在 `:36-38` 把 `activity` 菜单码插入 `admin_menus`（详见 `.qoder/docker/init/016_activity_settings.sql.md`）；ORM 模型见 `backend/app/models/models.py:108-123`；`start_at`/`end_at` 存 **UTC naive**。
- 演进（数据来源 `git log --follow --oneline -- admin/src/views/ActivityView.vue`）：**只有 1 个提交** `e197a28`（2026-10-13，「V2.0 管理后台——活动设置页（时间窗口/发布撤回/倒计时）…」），+317/-0 创建本文件，此后未再改动。同提交还给 `admin/src/main.ts` +10 行（新增 `Coin`/`Flag`/`Medal`/`Timer`/`Trophy` 五个图标的导入与注册），其中 `Flag`（本页菜单图标与发布状态图标）、`CircleCheck`/`Lock`（准入效果列表）、`Trophy`（结束页预览）为本页所用，**`Timer` 自该提交起即为死注册**（§3 于 `.qoder/admin/src/views/InvitesView.vue.md` 有完整取证）。

## 4. 核心功能

### 4.1 路由、菜单码与前后端权限守卫

- 路由：path `/activity`、name `activity`、`meta: { title: '活动设置', menu: 'activity' }`（`admin/src/router/index.ts:87-90`）；侧边栏条目「活动设置」+ `Flag` 图标（`admin/src/router/menus.ts:14`，`MENUS` 数组的**最后一项**，即无权限回退顺序中的最低优先级）。
- 前端守卫：`store/auth.ts:27-29` 的 `hasMenu('activity')`（超管恒真）→ 无权回退 `firstAllowedPath()`（`router/index.ts:9-12`）；侧边栏过滤 `layout/AdminLayout.vue:15`。
- 后端守卫：本页调用的 **3 个接口全部** `Depends(require_menu("activity"))`——`admin.py:1048`（GET）、`:1061`（PUT）、`:1080`（POST publish）。前端隐藏不是安全边界。
- **本页与后端口径完全一致**（都只要求 `activity`，且不调用任何跨权限接口），不存在 `.qoder/admin/src/views/AccessView.vue.md` §9 第 8 项那类错配。
- `activity` 码不在 `010_admin_identity.sql` 的初始 9 码内，由 `016_activity_settings.sql:36-38` 后补，故**老库必须先跑 016 迁移**，否则角色勾不到、非超管永久 403。

### 4.2 状态清单与服务端时间校准

| 状态 | 行 | 含义 |
|---|---|---|
| `loading` | `:9` | 页面级 `v-loading`（`:176`，挂在 `<main>` 上而非表格） |
| `loadError` | `:10` | 加载失败标志，驱动 `el-result` 兜底分支（`:177`） |
| `saving` / `publishing` | `:11-12` | 两个动作按钮的 `:loading`，同时兼作重入锁（`:124`、`:139`） |
| `setting` | `:13` | `ActivitySetting \| null`，后端返回的**权威状态**；为 `null` 时整个主体不渲染（`:181`） |
| `form` | `:14-22` | `reactive<ActivityForm>`，七字段可编辑副本 |
| `range` | `:25-31` | computed **getter/setter**，把 `el-date-picker` 的区间值与 `form.start_at`/`form.end_at` 双向映射；任一端为空即返回 `null` |
| `clockOffset` | `:34` | `Date.parse(server_time) - Date.now()`，服务端与本机时钟差（毫秒） |
| `now` | `:35` | 本机当前毫秒，`tick()` 每秒刷新，是倒计时的响应式驱动源 |
| `ticker` | `:36` | `setInterval` 句柄，`onBeforeUnmount` 清理（`:170-172`） |
| `reloading` | `:37` | 普通布尔（非 ref），倒计时归零自动重拉的**重入锁** |
| `toMinute` | `:39` | `iso.slice(0, 16)`，把后端 ISO 截成 `YYYY-MM-DDTHH:mm`（与 `value-format` 一致） |
| `countdown` | `:72-89` | computed，见 §4.7 |
| `dirty` | `:100-112` | computed，七字段逐一对比 `form` 与 `setting` |
| `effects` | `:114-121` | computed，两条准入结果（参与 / 浏览） |

- `fillForm(data)`（`:41-51`）：把 `ActivitySetting` 灌进 `form`，其中 `start_at`/`end_at` 经 `toMinute` 截断到分钟。
- `apply(data)`（`:53-58`）：**统一入口**——写 `setting`、重算 `clockOffset`、刷新 `now`、`fillForm`。`load()`（`:64`）、`handleSave`（`:131`）、`handlePublish`（`:155`）三处都走它，因此每次动作后 `form` 与 `dirty` 都会以服务端返回值为准重新对齐，不靠本地推算。

### 4.3 加载与错误兜底

- `load()`（`:60-70`）：`loading = true`、`loadError = false` → `apply((await fetchActivity()).data)` → `catch { loadError = true }` → `finally { loading = false }`。**本页是三个操作页里唯一有 `catch` 的加载函数**（对照 `OrgsView.vue:30-39`、`InvitesView.vue:46-57` 均无）。
- 兜底分支 `<el-result v-if="loadError && !setting" icon="error" …>`（`:177-179`）带「重新加载」按钮（`#extra` 插槽，`:178`）。**但 `ElResult` 未在 `admin/src/plugins/element-plus.ts` 的按需注册清单中**（清单见 `:94-133`，无 `ElResult`，也未引入 `element-plus/es/components/result/style/css`），触发该分支时 Vue 报「Failed to resolve component: el-result」，错误提示区不渲染。此为**已登记缺陷**，见 `.qoder/PROJECT.md` §8「代码级技术债」第 18 项、`.qoder/ARCHITECTURE.md` §15 第 10 项、`.qoder/REQUIREMENTS.md` §13 第 15 项、`.qoder/admin/src/plugins/element-plus.ts.md` §4.4 与 §9、`.qoder/admin/test/README.md`；引入点即 `e197a28`（该提交未同步修改 `plugins/element-plus.ts`）。
- **`loadError && !setting` 的合取条件意味着「已有数据后的重拉失败是完全静默的」**（§9 第 2 项）：`setting` 一旦非空，后续 `load()` 失败只会置 `loadError`，两个分支都不渲染错误提示，页面继续显示旧配置。倒计时归零触发的自动重拉（`:94-97`）走的正是这条静默路径。
- 主体渲染条件 `v-else-if="setting"`（`:181`）：首次加载中 `setting` 为 `null`，页面只有 `v-loading` 的空壳（`.activity-page` 有 `min-height:400px`，`:280`）。

### 4.4 顶部状态区（hero，`:182-197`）

- `<h1>{{ setting.name }}</h1>`（`:185`）；状态徽章 `:class="setting.status"` + `{{ setting.status_text }}`（`:187`），四态各有小圆点配色（`.badge.ongoing i` 绿色 + `pulse` 动画、`not_started` 金色、`ended` 红色，`:291-292`），并尊重 `prefers-reduced-motion`（`:316`）。
- `:188` 显示 `formatDateTime(setting.start_at) — formatDateTime(setting.end_at)`，后面**硬编码「（北京时间）」标签**。
- `:190` 显示「最近修改：`updated_by || '—'` · `formatDateTime(updated_at, '—', true)`」（第三参 `true` 即带秒）。
- 倒计时区见 §4.7；`countdown` 为 `null` 时显示 idle 文案「征程已圆满结束」（`status === 'ended'`）或「活动尚未发布」（`:196`）。

### 4.5 配置表单（`:200-238`）

| 字段 | 行 | 控件与约束 | 后端对应 |
|---|---|---|---|
| 活动名称 | `:203-205` | `el-input maxlength="64" show-word-limit`，`required` 星号 | `schemas.py:1606` `min_length=1, max_length=64`；`activity_service.py:168-170` 空则 400 |
| 活动时间 | `:206-218` | `el-date-picker type="datetimerange"`、`format="YYYY-MM-DD HH:mm"`、**`value-format="YYYY-MM-DDTHH:mm"`**（naive，无时区后缀）、`:clearable="false"`；旁注「按北京时间解释，精确到分钟；结束时刻起视为活动已结束」 | `schemas.py:1607-1608` `datetime`；`activity_service.py:164-165` 经 `local_to_utc` 并 `.replace(second=0, microsecond=0)` 截断秒 |
| 启用时间限制 | `:219-222` | `el-switch`；旁注「关闭后不论时间与发布状态，小程序均可正常参与（**仅用于应急**）」 | `activity_service._access:63-64`：`setting is None` 或 `not restrict_enabled` → 两项准入恒真 |
| 结束后可浏览 | `:223-226` | `el-switch` + **`:disabled="!form.restrict_enabled"`**（总开关关了就没意义）；旁注说明结束后仍可看排名与档案但不再产生步数积分与答题 | `_access:67`：`status != ended or allow_view_after_end` |
| 结束页标题 | `:227-229` | `el-input maxlength="64"`，占位给出默认文案 | `schemas.py:1611`；`activity_service.py:178` 空串 → `None` |
| 结束页寄语 | `:230-232` | `el-input type="textarea" :rows="3" maxlength="500" show-word-limit` | `schemas.py:1612`；`:179` 空串 → `None` |

- `<el-form label-width="120px" class="form" @submit.prevent>`（`:202`）**没有 `:model`/`:rules`/`ref`**：校验全在 `handleSave` 里命令式完成（§4.6），`required` 只画星号。`@submit.prevent` 防回车提交刷新页面。
- 面板头部有 `el-tag v-if="dirty" type="warning" effect="plain"`「有未保存的修改」（`:201`）；底部「保存设置」按钮 `:disabled="!dirty"`、「撤销修改」按钮 `:disabled="!dirty || saving"`（`:234-235`）——**未修改时不能保存**，这是本页的核心交互约束。
- `handleReset()`（`:162-164`）用 `fillForm(setting.value)` 把表单整体回滚到服务端值，不重新请求。

### 4.6 保存（`handleSave`，`:123-136`）

1. `if (saving.value) return`（`:124`）重入锁。
2. 三条命令式校验（`:125-127`）：名称 trim 后非空；起止都非空；`form.start_at >= form.end_at` 则拒绝——**字符串比较**，因 `value-format` 固定为 `YYYY-MM-DDTHH:mm`，字典序与时间序一致，成立。失败以 `return ElMessage.warning(...)` 结束，不发请求。
3. `saveActivity({ ...form, name/end_title/end_message 三处 trim })`（`:130`）→ PUT `/api/admin/activity`。
4. 成功后 `apply(data)`（`:131`）用**服务端返回的完整 `ActivitySetting`** 刷新（状态、准入、`server_time`、`updated_by` 全部由后端重算），再 `ElMessage.success('活动设置已保存，即时生效')`。
5. `finally { saving = false }`，**无 `catch`** → 后端 400 时产生未处理 rejection（仅控制台噪声，拦截器已弹 toast），`dirty` 仍为真、修改不丢。
- 后端 `activity_service.update`（`:156-187`）：`local_to_utc` 转 UTC naive 并截断秒 → 校验 `start < end`（`:166-167`）与名称非空（`:168-170`）→ `_ensure_setting` 取/建 id=1 单行（`:131-140`）→ `_snapshot` 取改前快照（`:143-153`）→ 写七字段 + `updated_at`/`updated_by` → **在同一事务内** `audit_service.record(..., "activity.update", ..., {operator, before, after})`（`:182-185`）→ `commit()` → 返回 `get_admin_view(db)`。

### 4.7 倒计时与自动重拉（`:72-98`）

- `countdown` computed：`setting` 为空、或 `start_at`/`end_at` 任一为空 → `null`；按 `status` 选目标时刻（`not_started` → `start_at`，`ongoing` → `end_at`，其余 → `null`）；`left = Math.max(0, Date.parse(target) - (now + clockOffset))`，拆成 天/时/分/秒 四段（`:82-87`），标签为「距开始」或「距结束」（`:80`）。
- **不受本机时钟与本机时区影响**：`Date.parse` 对后端返回的带 `+08:00` ISO 得到正确的绝对时间戳，`clockOffset`（`:55`）把本机时钟误差补偿掉。这是 `.qoder/REQUIREMENTS.md` §1.2 明确点名的实现。
- `tick()`（`:91-98`）每秒 `now.value = Date.now()`；当 `countdown.left === 0` 且 `!reloading` 时置 `reloading = true` 并 `load().finally(() => { reloading = false })`（`:94-97`）——**状态切换由服务端重新判定**，前端不自行推算 `status`（`:93` 注释即此意）。
- 模板用 `String(p.v).padStart(2, '0')` 补零、`:key="p.u"`（`:194`）。
- 定时器清理：`onMounted` 建 `window.setInterval(tick, 1000)`（`:166-169`），`onBeforeUnmount` 判空后 `clearInterval`（`:170-172`）——**无泄漏**，符合 `admin/agents.md` 所在技术栈对定时器清理的要求。

### 4.8 发布 / 撤回（`handlePublish`，`:138-160`）

1. `if (publishing.value) return`（`:139`）重入锁。
2. **仅发布方向**校验 `dirty`：`if (published && dirty.value) return ElMessage.warning('存在未保存的修改，请先保存活动设置')`（`:140`）——防止管理员误以为未保存的改动会随发布一起生效。撤回方向不校验。
3. 二次确认：两套文案（发布「按活动时间窗口控制参与与浏览」/ 撤回「小程序将显示「活动暂未发布」，所有参与行为会被拒绝」），`type="warning"`，撤回时 `confirmButtonClass: 'el-button--danger'`（`:141-149`）。
4. **`try { await ElMessageBox.confirm(...) } catch { return }`（`:144-152`）——取消不产生未处理 rejection**。这是本仓库里少数写对的地方，与 `OrgsView.vue:43-47`/`:153-159`、`AccessView.vue:242-251`、`layout/AdminLayout.vue:17-21` 形成对照，**本页无该类问题**。
5. `publishing = true` → `apply((await publishActivity(published)).data)`（`:155`，POST `/api/admin/activity/publish` 传 `{ published }`）→ 成功提示；`finally` 复位，**无 `catch`**（§9 第 3 项）。
- 按钮渲染：已发布显示 danger plain「撤回活动」（`:248-254`）；未发布显示 primary「发布活动」且 **`:disabled="!setting.configured"`**（`:255`）——`configured` 即「`activity_settings` 是否已有 id=1 的行」（`activity_service.py:127`）。
- 后端 `set_published`（`:190-204`）：`setting is None` → `ValueError("请先保存活动配置")` → 路由转 400（`admin.py:1087-1088`）；否则只改 `is_published` + `updated_at`/`updated_by`，写审计 `activity.publish` / `activity.unpublish`（`:199-202`），`commit()` 后返回 `get_admin_view(db)`。**发布不校验时间是否已配置合理**（`_ensure_setting` 建行时 `start_at = end_at = now`，`activity_service.py:136`），但前端 `configured` 与 `dirty` 两道闸已覆盖常见误操作。

### 4.9 发布状态面板与准入效果（`:241-263`）

- `.pub-state`（`:244-247`）：`Flag` 图标 + 「已发布 / 未发布」+ 一句后果说明；已发布时图标转长征红（`.pub-state.on .el-icon`，`:306`）。
- `effects` 列表（`:114-121`、`:257-261`）：两条固定项——「小程序参与（步数同步/答题/积分）」取 `s.allow_participate`、「小程序浏览（排名/档案/记录）」取 `s.allow_view`；每条用 `<component :is="e.ok ? 'CircleCheck' : 'Lock'" />` 切图标、右侧显示「允许 / 拒绝」，颜色由 `.effects li` / `.effects li.ok` 控制（`:309-310`）。
- `:262` 在 `setting.message` 非空时显示 `.block-msg` 黄条——即后端 `_BLOCK_MESSAGE` 的拒绝文案（`activity_service.py:38-42`）或结束寄语，让管理员看到小程序端实际会收到什么。

### 4.10 结束页预览（`:265-272`）

- `Trophy` 图标 + `form.end_title.trim() || '征程圆满 · 荣耀永驻'`（`:269`）+ `form.end_message.trim() || '本次长征步迹活动已圆满结束，感谢每一位战友的坚持与奔跑。'`（`:270`）。
- 预览**跟随未保存的表单**（读 `form` 而非 `setting`），符合「所见即所填」；`.end-card p` 有 `white-space:pre-wrap`（`:315`），寄语换行可见。
- 两条默认文案与后端 `activity_service.DEFAULT_END_TITLE`/`DEFAULT_END_MESSAGE`（`:35-36`）**逐字重复**（§9 第 6 项）。

### 4.11 与公共组件、实时推送、图标的关系

- **不引用 `admin/src/components/` 下任何公共组件**（导入仅 `:3-7`）；整页是自定义 `<main>` + `<section>` 布局，不用 `el-card`（与 `OrgsView`/`InvitesView`/`AccessView` 的 `el-card shadow="never"` 外壳风格不同）。
- **不订阅 WebSocket**（未导入 `utils/liveUpdates`）：活动状态变化靠本页倒计时归零自动重拉；反过来，本页的保存/发布也**不通过 WS 推给** Dashboard/Screen/Rankings 三页，那三页靠各自的 `useLiveUpdates` 轮询感知（`.qoder/ARCHITECTURE.md` §6.4）。
- **无导出**（未使用 `utils/download.ts`）。
- 时间格式化走 `utils/format.ts` 的 `formatDateTime`（`:7` 导入；`:188`、`:190` 调用），**无私有 formatter**。但本页的时间口径与全站约定不同，见 §7 第 9 项。
- 图标：`Flag`（`:245` 组件标签）、`CircleCheck`/`Lock`（`:259` 字符串动态组件）、`Trophy`（`:268`）、`'Refresh'`（`:178` 字符串 `:icon`）——四个均已在 `admin/src/main.ts` 注册（`CircleCheck` `:5`/`:45`、`Flag` `:12`/`:52`、`Lock` `:16`/`:56`、`Trophy` `:30`/`:70`、`Refresh` `:25`/`:65`），**本页无未注册图标**；唯一未注册的是 §4.3 的 `el-result` 组件（非图标）。

## 5. 输入与输出

- 输入：无 props / 无 emits。隐式输入为 `store/auth` 的 localStorage 登录态（`api/request.ts:19-25` 注入 Bearer Token）、用户表单编辑、以及每秒一次的 `tick()`。
- 输出：无返回值；副作用经后端落库并写审计。
- 调用的 `api/admin.ts` 函数与后端链路（`request.ts:28` 的成功拦截器返回**完整 AxiosResponse**，故本页写作 `(await fetchActivity()).data`、`(await publishActivity(published)).data`；`baseURL` 为 `/api`）：

| 前端函数（`admin/src/api/admin.ts`） | 方法与路径 | 后端权限 | route → service | 本页调用点 |
|---|---|---|---|---|
| `fetchActivity()`（`:340-342`） | GET `/api/admin/activity` | `require_menu("activity")`（`admin.py:1048`） | `admin.py:1046-1050` → `activity_service.get_admin_view:117-128` | `:64` |
| `saveActivity(data)`（`:344-346`） | PUT `/api/admin/activity` | 同上（`admin.py:1061`） | `admin.py:1058-1069` → `activity_service.update:156-187` | `:130` |
| `publishActivity(published)`（`:348-350`） | POST `/api/admin/activity/publish` | 同上（`admin.py:1080`） | `admin.py:1077-1088` → `activity_service.set_published:190-204` | `:155` |

- TS 类型（`admin/src/api/admin.ts`）：`ActivityStatus`（`:312`，`'unpublished' | 'not_started' | 'ongoing' | 'ended'`）、`ActivityForm`（`:315-323`，七字段；`:314` 注释「读取为带 +08:00 的 ISO 时间，保存时传北京时间 `YYYY-MM-DDTHH:mm`」）、`ActivitySetting`（`:325-338`，`extends Omit<ActivityForm,'start_at'|'end_at'>` 再加 `start_at`/`end_at`（可空）、`status`、`status_text`、`allow_participate`、`allow_view`、`message`、`server_time`、`is_published`、`updated_at`、`updated_by`、`configured`）。
- 请求体：`AdminActivitySettingUpdate`（`backend/app/schemas/schemas.py:1603-1612`，`:1604` 文档串「时间入参按北京时间解释（naive 视为 +08:00，带时区按时区换算），精确到分钟」）、`AdminActivityPublishRequest`（`:1615-1616`，只有 `published: bool`）。
- 错误码：422（Pydantic，如 `name` 超长）；403（无 `activity` 权限）；400（「开始时间必须早于结束时间」`activity_service.py:167`、「活动名称不能为空」`:170`、「请先保存活动配置」`:195`）。
- 加载态：`<main v-loading="loading">`（`:176`）、两个动作按钮 `:loading`（`:234`、`:252`/`:255`）。空态：`setting` 为 `null` 时主体不渲染（`:181`）。错误态：`el-result` 分支（`:177-179`，**组件未注册**，§4.3）。

## 6. 依赖关系

- 导入（`:3-7`）：`vue`（`computed`/`onBeforeUnmount`/`onMounted`/`reactive`/`ref`）、`element-plus`（`ElMessage`、`ElMessageBox`）、`../api/admin`（3 个函数）、`../api/admin` 类型（`ActivityForm`、`ActivitySetting`）、`../utils/format`（`formatDateTime`）。
- 模板组件由 `admin/src/plugins/element-plus.ts:94-133` 注册：button/form/form-item/input/date-picker/switch/tag/icon **在册**；**`result` 缺失**（§4.3，已登记缺陷）。
- 被依赖：`admin/src/router/index.ts:87-90`（`/activity` 懒加载）。
- 数据来源表：`activity_settings`（单行，`id = 1`，`activity_service.py:20` 的 `SETTING_ID`；建表见 `docker/init/016_activity_settings.sql`）、`audit_logs`（`activity.update`/`activity.publish`/`activity.unpublish` 由后端写入）、`admin_menus`（`activity` 码）。
- 后端服务详见 `.qoder/backend/app/services/activity_service.py.md`、路由详见 `.qoder/backend/app/api/routes/admin.py.md`；小程序侧的活动守卫（`api/deps.py:68-72`/`:79`/`:81`，403 + `X-Activity-Status` 头）与落地页 `frontend/pages/activity/activity` 见 `.qoder/backend/app/api/deps.py.md`、`.qoder/frontend/pages/activity/activity.js.md`。
- 关联页面：`views/AuditView.vue`（`ACTION_TEXT` 含 `activity.update`/`activity.publish`/`activity.unpublish`，`activity.*` 着 `primary` 标签，见该文档 §4.5）；小程序 `pages/activity/activity`、`pages/launch/launch`、`services/request.js` 消费同一份状态（`.qoder/REQUIREMENTS.md` §1.2）。**本页的保存/发布即时影响全小程序准入**，是管理后台影响面最大的单页。

## 7. 业务规则

1. **权限**：读取与两个写动作都需 `activity` 菜单码（超管恒真，`store/auth.ts:27-29`）；后端逐个 `require_menu("activity")`（`admin.py:1048`/`:1061`/`:1080`）。**无按钮级权限**——凡能进本页即可发布/撤回活动（`.qoder/REQUIREMENTS.md` §11.1「权限粒度」行）。
2. **单行配置**：全表只有 `id = 1` 一行（`activity_service.py:20`），无多期活动概念；`configured` 即该行是否存在（`:127`）。
3. **状态由服务端时间实时计算、不落库**：`compute_status`（`activity_service.py:49-59`）判定顺序为 `setting is None` → `ongoing`；`not is_published` → `unpublished`；`now < start_at` → `not_started`；`now >= end_at` → `ended`；否则 `ongoing`。**「结束时刻起视为已结束」**（`>=`），与 `:217` 的界面旁注一致。
4. **配置缺失按「不限制」兜底**：`setting is None` 时 `_access` 直接返回两项恒真（`:63-64`），保证未跑迁移的库不改变存量行为。
5. **总开关优先**：`restrict_enabled = false` 时 `allow_participate`/`allow_view` **恒为真**（`:63-64`），即「仅用于应急」的旁路（`:221` 界面文案）；此时状态徽章仍照常显示，只是不拦截。
6. **两项准入口径**：`allow_participate` **仅 `ongoing` 为真**（约束步数同步、答题、积分、勋章、节点点亮等「产生新业务数据」的接口）；`allow_view` 未结束恒真，结束后取 `allow_view_after_end`（`:66-67`）。前端 `effects`（`:114-121`）原样展示这两个布尔值，不做二次推导。
7. **前端联动约束**：`allow_view_after_end` 开关在 `restrict_enabled` 关闭时被禁用（`:224`），因为总开关关掉后它不起作用。
8. **发布 / 撤回状态流转**：未发布 ⇄ 已发布由 `is_published` 单字段控制；发布前置条件为「配置已存在」（后端 `:194-195` 抛 400 + 前端 `:255` 用 `configured` 禁用按钮）与「无未保存修改」（**仅前端** `:140`，后端不校验）。撤回**只改 `is_published`**，不触碰时间与其他配置。撤回后小程序所有参与行为被拒并显示「活动暂未发布，敬请期待」（`_BLOCK_MESSAGE`，`:38-42`）。
9. **时区口径（本页与全站不同，重点）**：库内 `start_at`/`end_at`/`updated_at` 存 **UTC naive**；后端 `_bj()`（`activity_service.py:71-73`）用 `to_local` 转北京时间并**附上 `+08:00` 时区**再序列化（`get_status:90-91`/`:97`、`get_admin_view:125`）。前端 `utils/format.ts:29-31` 的 `parseUtc` 检测到 `±HH:MM` 后缀就**不补 `Z`**，随后 `Intl.DateTimeFormat('zh-CN')`（`:10-26`）按**浏览器本地时区**渲染。因此：浏览器在 UTC+8 时 `:188` 的「（北京时间）」标签正确；**浏览器在其他时区时，显示的钟点会被换算成本地时间，而标签仍写「（北京时间）」**（§9 第 1 项）。倒计时不受影响（用绝对时间戳 + `clockOffset`）。
10. **保存的时间入参是 naive 北京时间**：`value-format="YYYY-MM-DDTHH:mm"`（`:211`）产出无时区后缀的串，后端 `local_to_utc`（`core/helpers.py:40-44`）对 naive 值补 `BEIJING_TZ` 再转 UTC 存库，并把秒与微秒截断为 0（`activity_service.py:164-165`）。**往返一致**：读回来 `toMinute(iso.slice(0,16))`（`:39`）正好还原成同一串，故 `dirty`（`:105-106`）不会因秒位差误判。
11. **前后端双重校验**：名称非空、起止非空、开始早于结束三条在前端（`:125-127`）与后端（`activity_service.py:166-170`）各校验一次；后端为准（直连接口可绕过前端）。
12. **即时生效**：保存与发布都直接 `commit`（`:186`、`:203`），小程序端下一次请求即经 `api/deps.py` 的活动守卫重新判定（403 + `X-Activity-Status`），无缓存层、无需重启。界面提示语「即时生效」（`:132`）即此。
13. **审计**：三类动作都在**业务同一事务内**写 `audit_logs`——`activity.update` 记 `{operator, before, after}` 双快照（`:182-185`、`_snapshot:143-153`），`activity.publish`/`activity.unpublish` 记 `{operator, name}`（`:199-202`）。操作人身份由 `admin.py:_actor`（`:752-754`）区分超管与微信关联管理员。
14. **默认文案回落**：`end_title`/`end_message` 空串存为 `NULL`（`:178-179`），读取时后端对小程序侧回落默认值（`get_status:95`、`:83`），管理端 `get_admin_view` 则返回**空串**（`:123-124`）让表单可编辑；前端预览自己再回落一次同样的默认串（`:269-270`）。
15. **排序 / 分页**：本页无列表，不涉及。

## 8. 修改约束

- **菜单码四方一致**：`admin/src/router/menus.ts:14` 的 `code`、`router/index.ts:90` 的 `meta.menu`、后端 `require_menu("activity")`（`admin.py:1048`/`:1061`/`:1080`）、数据库 `admin_menus.code`（`docker/init/016_activity_settings.sql:36-38`）必须逐字相同（同 `.qoder/admin/src/views/AccessView.vue.md` §8 第 1 条）。
- **时区口径不可单边改**：`value-format="YYYY-MM-DDTHH:mm"`（`:211`）、`toMinute` 的 `slice(0,16)`（`:39`）、后端 `local_to_utc` 的「naive 视为北京时间」（`core/helpers.py:42-43`）、`_bj` 的 `+08:00` 输出（`activity_service.py:71-73`）四处互为前提。改任一处都要同时核对 `dirty`（`:105-106`）是否仍能把「未修改」判为假——否则「保存设置」按钮会常态可点或常态禁用。
- **`apply()` 是唯一的状态写入入口**（`:53-58`）：任何新增的活动接口调用都必须经它，否则会漏掉 `clockOffset` 重算，倒计时会沿用旧的时钟偏移。
- **倒计时不得改为前端自行推算 `status`**：`status`/`status_text`/`allow_*`/`message` 全部以后端返回为准（`:93` 注释、`:155`、`:131`）。前端只有 `countdown` 一个派生量，且归零即重拉（`:94-97`）。
- **`reloading` 重入锁与 `ticker` 清理必须保留**（`:37`、`:94-96`、`:170-172`）：去掉前者会在归零后每秒发一次请求；去掉后者会在离开页面后继续跑定时器。
- **`dirty` 是发布/保存两道闸的依据**（`:140`、`:234-235`）：新增可编辑字段时必须同步加进 `dirty` 的对比列表（`:103-111`），否则会出现「改了但保存按钮禁用」「未保存却能发布」。
- **`handlePublish` 的 `try/catch` 包 `ElMessageBox.confirm` 的写法（`:144-152`）是本仓库的正确范式**，重构时不得退化成 `OrgsView.vue:43-47` 那种裸 `await`。
- **修复 `el-result` 缺口时须同时引入样式**：在 `admin/src/plugins/element-plus.ts` 的 `components` 数组与 import 区各加 `ElResult`，并补 `element-plus/es/components/result/style/css`（`.qoder/admin/src/plugins/element-plus.ts.md` §8 已写明此约束）。`vue-tsc` **不会报**这个错误（组件按字符串解析），只能靠浏览器验收发现。
- **本页影响面覆盖全小程序**：改「保存 / 发布」的语义或准入判定，必须同步核对后端 `activity_service._access`（`:62-68`）、`api/deps.py` 的活动守卫与 `frontend/services/request.js` 对 `X-Activity-Status` 的处理（`.qoder/REQUIREMENTS.md` §1.1、§1.2）。
- 视觉与可用性：需覆盖加载 / 空态 / 筛选与窄屏可用性（`admin/agents.md`「开发约定」第 3 条）。**本页 `.activity-page{min-width:960px}`（`:280`）与 `.grid{grid-template-columns:minmax(0,1fr) 360px}`（`:299`）没有任何响应式断点**，窄屏必然横向滚动（§9 第 4 项）。

## 9. 当前实现状态

**已实现**

- 活动配置读写（名称 / 起止时间 / 时间限制总开关 / 结束后可浏览 / 结束页标题与寄语）、发布与撤回（含二次确认与 danger 样式）、服务端时间校准的秒级倒计时、倒计时归零自动重拉状态、状态徽章与两项准入结果展示、后端拒绝文案回显、结束页实时预览、`dirty` 驱动的「保存 / 撤销修改」可用性、加载与错误兜底分支。
- **符合规范的点**：`load()` **有 `catch` 并置 `loadError`**（`:65-66`，三个操作页里唯一）；`handlePublish` 的确认框**有 `try/catch`**（`:144-152`），**本页不存在「取消确认 → 未处理 rejection」问题**；`ticker` 在 `onBeforeUnmount` **正确清理**（`:170-172`）；`saving`/`publishing`/`reloading` **三道重入锁**（`:124`、`:139`、`:94`）；保存与发布后**统一经 `apply()` 以后端返回值为准**（`:131`、`:155`），不本地推算状态；**无私有时间格式化函数**；本页用到的**图标全部已注册**；尊重 `prefers-reduced-motion`（`:316`）。

**存在问题 / 已知事项**

1. **`el-result` 未注册（已登记缺陷，此处仅交叉引用）**：`:177-179` 的错误兜底分支不会渲染成 Element Plus 结果组件。已记录于 `.qoder/PROJECT.md` §8「代码级技术债」第 18 项、`.qoder/ARCHITECTURE.md` §15 第 10 项、`.qoder/REQUIREMENTS.md` §13 第 15 项、`.qoder/admin/src/plugins/element-plus.ts.md` §4.4/§9、`.qoder/admin/test/README.md`。**不重复报告**，仅指出它是本页唯一的组件缺口。
2. **`:177` 的 `loadError && !setting` 合取条件让「已有数据后的重拉失败」完全静默**：`setting` 非空时两个分支都不显示错误，页面继续展示旧配置且无任何提示；倒计时归零触发的自动 `load()`（`:94-97`）失败也走这条静默路径 → 状态徽章与准入结果可能长期停留在过期值上，而管理员无从察觉。**这是 §4.3 兜底分支的实际覆盖面缺口，独立于 `el-result` 未注册问题，未在既有 `.qoder` 文档中记录。**
3. **`handleSave` / `handlePublish` 的请求本身无 `catch`**（`:129-135`、`:153-159`，均 `try…finally`）：后端 400（如「开始时间必须早于结束时间」「请先保存活动配置」）时产生未处理 rejection。仅控制台噪声（拦截器已弹 toast），且 `dirty` 保持为真、用户修改不丢，行为可接受。
4. **无响应式布局，窄屏必然横向滚动**：`.activity-page{min-width:960px}`（`:280`）、`.grid` 固定 `360px` 侧栏（`:299`）、`.hero` 用 `justify-content:space-between` 无 `flex-wrap`（`:281`）。与 `admin/agents.md`「开发约定」第 3 条「数据页需覆盖……窄屏可用性」冲突。全站唯一的媒体查询是 `prefers-reduced-motion`（`:316`），**没有任何宽度断点**。**未记录**。
5. **`el-form` 无 `:model`/`:rules`/`ref`**（`:202`）：校验是 `handleSave` 里的三条命令式判断（`:125-127`），没有字段级错误文案，`required`（`:203`、`:206`）只画星号。与 `OrgsView.vue:296` 用 `FormRules` 的写法不一致。
6. **默认结束文案在前端硬编码、与后端逐字重复**：`:269` 的「征程圆满 · 荣耀永驻」= `activity_service.DEFAULT_END_TITLE`（`:35`），`:270` 的整段感谢语 = `DEFAULT_END_MESSAGE`（`:36`）。后端改文案时前端预览会不一致（预览显示旧默认串，小程序显示新默认串）。属根 `agents.md` §2.2「拒绝冗余代码」的现存违例。**未记录**。
7. **多管理员并发编辑无乐观锁**：`activity_service.update`（`:171-186`）直接覆盖整行，无版本号 / `updated_at` 前置校验；两人同时打开本页、后保存者会静默覆盖先保存者的全部七字段（审计里有 `before`/`after` 快照可事后追溯，但界面无提示）。`:190` 的「最近修改：谁 · 何时」只在重新加载后更新，不会自动刷新。**未记录**。
8. **`ticker` 在页面不可见时仍每秒运行**：`:168` 的 `setInterval` 未结合 `document.visibilityState` 或路由失活暂停；后台标签页里会持续触发 computed 重算（浏览器会节流后台定时器，影响有限）。低。
9. **`range` getter 的单端空值边界**（`:26`）：只有 `start_at` 与 `end_at` **都**非空才返回区间，否则返回 `null`。若后端返回单端为空（当前 `_ensure_setting:136` 同时写两端，实际不会发生），选择器会显示空但 `form.start_at` 仍带值，`dirty`（`:105-106`）会判为「有修改」→「保存设置」按钮亮起，而 `handleSave` 的 `:126` 又会因 `end_at` 为空拦下。属**理论边界**，风险低，记录以免日后改动 `_ensure_setting` 时踩到。
10. **`restrict_enabled` 关闭时缺少醒目警示**：`:221` 只有一行灰色 hint，`:244-247` 的发布状态区与 `effects` 列表都不提示「时间限制已被旁路」。总开关是「仅用于应急」的高风险配置（关掉后无论发布与否、无论时间窗口，小程序全部放行，`activity_service.py:63-64`），界面上却与「结束后可浏览」同等视觉权重。**未记录**。
11. **无按钮级权限**：能进本页即可发布 / 撤回活动，而撤回会让全小程序立刻显示「活动暂未发布」并拒绝所有参与（`:143` 文案即此），影响面在管理后台里最大。唯一边界是 `require_menu("activity")`（同 `.qoder/PROJECT.md` §8「代码级技术债」第 20 项、`.qoder/admin/src/views/AccessView.vue.md` §9 第 7 项）。是否需要对发布/撤回增加二次授权或超管限定**待确认**（未见需求条目）。
12. **`updated_by` 只显示用户名**（`:190`），无「他人正在编辑」提示；配合第 7 项，并发覆盖不可预防。
13. **未订阅 WebSocket**（§4.11）：本页改完配置后，Dashboard / Screen / Rankings 三页不会即时收到通知，需各自轮询周期到达才更新。属既有架构口径（`.qoder/ARCHITECTURE.md` §6.4），非本页缺陷。

**待开发**

- 无本页专属待办条目。`.qoder/REQUIREMENTS.md` §1.3 记录的「生产环境实际配置的 `start_at`/`end_at`/`is_published` 值」属运行时数据、不在仓库中，**待确认**（需查生产库，本任务禁止连库）。AI 智能中心的 5 个 `ai_*` 菜单码与本页无关。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/views/ActivityView.vue`，共 **1 个提交**；增删行数取自 `git show --numstat e197a28 -- admin/src/views/ActivityView.vue`。该提交在 `docs/迭代记录.md` 有对应条目。

### 2026-10-13（`e197a28`）
- 需求：V2.0 管理后台——活动设置页（时间窗口 / 发布撤回 / 倒计时）。同批还含排名洞察积分化（前 10 荣誉榜金银铜 + 荣誉卡、积分列、积分核对修复）、人员组织调整弹窗、审计动作中文化。
- 修改内容（涉本文件）：**+317/-0，创建本文件**，即当前全部内容——① 状态与表单（`:9-22`）、`range` 区间双向映射（`:25-31`）；② 服务端时间校准 `clockOffset` + 每秒 `tick` + 倒计时归零自动重拉（`:34-37`、`:72-98`、`:166-172`）；③ `load`/`fillForm`/`apply`/`toMinute` 加载链（`:39-70`）；④ `dirty` 七字段对比与 `handleSave` 三条命令式校验（`:100-112`、`:123-136`）；⑤ `handlePublish` 发布/撤回（含 `dirty` 前置拦截、双套确认文案、**`try/catch` 包确认框**，`:138-160`）；⑥ `effects` 准入效果列表（`:114-121`）；⑦ 模板四区：`el-result` 错误兜底（`:177-179`）、hero 状态与倒计时（`:182-197`）、配置表单（`:200-238`）、发布状态 + 结束页预览（`:240-273`）；⑧ 全套自定义样式（长征红渐变 hero、脉冲徽章、鎏金倒计时、结束页卡片，`:279-316`）。**创建时即引入 `el-result` 而未同步注册组件**（§4.3、§9 第 1 项）。
- 关联文件：`admin/src/api/admin.ts`（`fetchActivity`/`saveActivity`/`publishActivity` 与 `ActivityStatus`/`ActivityForm`/`ActivitySetting`）、`admin/src/router/index.ts`（`/activity` 路由）、`admin/src/router/menus.ts`（`activity` 菜单项）、**`admin/src/main.ts`（+10，注册 `Coin`/`Flag`/`Medal`/`Timer`/`Trophy`；其中 `Timer` 自此起为死注册，§3）**、`admin/src/views/AccessView.vue`（组织调整弹窗）、`admin/src/views/AuditView.vue`（`activity.*` 动作中文化）、`backend/app/services/activity_service.py`（`get_admin_view`/`update`/`set_published`）、`backend/app/api/routes/admin.py`（3 个 `require_menu("activity")` 接口）、`backend/app/schemas/schemas.py`（`AdminActivitySettingUpdate`/`AdminActivityPublishRequest`/`AdminActivitySettingOut`）、`docker/init/016_activity_settings.sql`（建表 + `activity` 菜单码）、`backend/app/services/points_service.py`（同批的 `points.recompute`）。
- 测试结果：见 `docs/迭代记录.md` 的 `e197a28` 条目。
