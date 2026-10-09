# S10 管理后台扫码登录与人员授权/审计页 · 浏览器验收报告

日期：2026-10-09 ｜ 环境：admin dev server (5173) + backend (8010, openGauss) ｜ 浏览器：Edge 127.0.0.1 独立源（Playwright 驱动，见备注）

## 范围

微信身份关联 P3 管理端（批次 4）：登录页微信扫码登录（授权成功 / 未授权拒绝两条路径）、菜单权限守卫（超管 9 菜单 / operator 7 菜单 / 无权限回退）、人员授权页（人员筛选、设置角色弹窗、单角色禁用即时生效）、角色管理页（新建/编辑/删除、内置角色禁删、已授权角色删除被后端拒绝）、审计日志页（日期/动作/操作人筛选）、账号登录未配置密码时的禁用提示。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/store/auth.ts` | 登录态改为 token + 权限档案（menus/is_super）双条件；新增 setProfile/getIsSuper/getMenus/hasMenu；clearAuth 清除全部 4 个键 |
| `src/router/index.ts` | 新增 `/access`、`/audit` 路由（meta.menu）；菜单权限守卫回退 firstAllowedPath()；登录页守卫对已登录但无任何菜单的用户停留登录页（防 /login ↔ /dashboard 死循环） |
| `src/views/LoginView.vue` | 重写为双标签（账号登录 / 微信扫码）；扫码 2s 轮询、confirmed 自动登录、scanned/failed/expired 状态流转；mock 模式展示场景码并支持复制 |
| `src/views/AccessView.vue` | 新建：人员授权（筛选 + 设置角色弹窗 + 单角色启用/禁用）+ 角色管理（CRUD + 菜单勾选） |
| `src/views/AuditView.vue` | 新建：审计日志分页 + 日期/动作/操作人筛选 |
| `src/layout/AdminLayout.vue` | 菜单项数组化 + 按 hasMenu 过滤渲染 + 超管徽标 |
| `src/api/admin.ts` | 新增 wechat/qr、me、users、roles、audit-logs 接口与类型 |
| `src/api/request.ts` | axios 支持 `silent` 配置（轮询不弹错）；401 区分登录页/会话过期 |
| `src/plugins/element-plus.ts` | 新增 ElTabs/ElTabPane/ElCheckboxGroup 组件与样式 |

## 验收结果（20/20 通过）

| # | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| A1 | 登录页双标签（账号登录 / 微信扫码）渲染 | ✅ | batch4-01-login-account.png |
| A2 | 微信扫码标签生成 mock 场景码（开发模式无小程序码） | ✅ | batch4-02-login-qr.png |
| A3 | 小程序侧 qr/info 置「已扫码」 | ✅ | 接口 200 |
| A4 | 小程序侧确认登录成功 | ✅ | 接口 200 |
| A5 | 扫码后 PC 端 2s 轮询自动登录进入驾驶舱 | ✅ | batch4-03-dashboard-operator.png |
| A6 | operator 仅渲染 7 个授权菜单（无人员授权/审计日志） | ✅ | 菜单文本断言 |
| A7 | 无 access 权限访问 /access 回退第一个可用菜单（驾驶舱） | ✅ | URL 断言 |
| B1 | 创建无后台权限用户（模拟小程序登录） | ✅ | 接口 200 |
| B2 | 无权限用户扫码确认返回 403「无后台访问权限，请联系管理员授权」 | ✅ | 接口 403 |
| B3 | PC 端展示「登录未获授权」及原因 | ✅ | batch4-04-login-qr-denied.png |
| C1 | 超管渲染全部 9 个菜单 + 超管徽标 | ✅ | batch4-05-dashboard-super.png |
| C2 | 人员列表含已授权用户（operator 可访问、角色回显） | ✅ | batch4-06-access-users.png |
| C3 | 设置角色弹窗打开且已启用角色回显勾选 | ✅ | batch4-07-access-grant-dialog.png |
| C4 | 新建角色（勾选 2 个菜单）成功并出现在角色表 | ✅ | batch4-08/09 |
| C5 | 通过弹窗授予新角色并即时回显 | ✅ | 行标签断言 |
| C6 | 单角色禁用/启用即时生效；禁用后勾选态保留（仅开关关闭） | ✅ | batch4-10-access-role-disabled.png |
| C7 | 已授权角色删除被后端拒绝并提示「角色已授权给用户，请先移除授权」 | ✅ | batch4-11-access-role-delete-refused.png |
| C8 | 移除授权后删除角色成功 | ✅ | 行消失断言 |
| C9 | 审计日志按动作 + 操作人类型筛选出结果（3 条） | ✅ | batch4-12-audit.png |
| D1 | 未配置 ADMIN_PASSWORD 时账号登录被禁用，提示引导扫码（不硬编码默认密码） | ✅ | batch4-13-login-error.png |

## 缺陷记录（验收发现并已修复）

| # | 缺陷 | 修复 |
| --- | --- | --- |
| 1 | 授权弹窗勾选态只含「启用中」角色：禁用某角色后勾选自动取消，直接保存会静默撤销该授权，与「禁用仅保留授权」语义冲突 | checkedRoleIds 改为含全部已授权角色（openGrant 与 toggleRoleEnabled 两处刷新点） |
| 2 | 审计日志页缺少 onMounted(loadLogs)，进入页面表格为空，需手动点查询 | 补 onMounted 初始化加载 |
| 3 | 路由守卫边缘死循环：已登录但菜单为空的用户会在 /login ↔ /dashboard 间无限重定向，浏览器渲染进程卡死 | 登录页守卫改为「无可回退菜单时停留登录页」 |

## 备注

- 验收期间 Qoder 内置浏览器（browser-use）因上述缺陷 3 触发的无限重定向导致渲染进程卡死、所有页面操作超时，无法恢复；改用 Playwright 驱动本机 Edge（127.0.0.1 独立源，天然隔离 localStorage）完成验收，截图与交互证据齐全。
- 测试用户为真实 RBAC 流程产物：operator 用户「浏览器验收」(uid=291) 由 API 授予角色后扫码登录验证；「无权限测试员」由模拟小程序登录创建用于未授权拒绝路径；临时角色「批4-UI测试角色」在验收结束时已删除，授权已还原为仅 operator。
- 控制台唯一的 JS 错误为验收预期行为：删除已授权角色被后端 400 拒绝时 axios 拦截器 toast 后抛出（与既有页面模式一致，非本次新增问题）。
- 后端接口层（扫码/身份关联/RBAC/审计）的 30 项用例由 backend/test/s9_rbac_access.py 覆盖，本报告仅覆盖管理端 UI 层。
