# App.vue

## 1. 文件路径

`admin/src/App.vue`（3 行）

## 2. 文件职责

Vue 应用根组件，模板仅一行 `<router-view />`（`:1-3`）：所有路由页面（顶层全屏的 `/login`、`/screen`，以及挂在 `AdminLayout.vue` 下的 10 个布局子路由）都经此出口渲染。无 script、无 style、无生命周期逻辑。

## 3. 业务需求

Vue SPA 单根组件惯例，随管理后台初始批次 `4a26520`（2026-09-30）交付，此后零改动（`git log --follow` 仅 1 个提交）。

## 4. 核心功能

### 4.1 路由出口（`:2`）

唯一内容是 `<router-view />`。刻意保持纯出口：全屏路由（`/login`、`/screen`）不套任何布局壳，布局由 `router/index.ts:27-93` 的 `AdminLayout` 父路由承担；全局样式在 `style.css`，全局注册在 `main.ts`。

## 5. 输入与输出

无 props / emits / 导出。输入为 `main.ts:76` `createApp(App)` 的装配；输出为渲染的路由组件树。

## 6. 依赖关系

- 依赖：vue-router 注入的 `router-view`（`main.ts:81` `app.use(router)`）。
- 被依赖：`admin/src/main.ts:36` import、`:76` 作为根组件。
- 不调用 `api/admin.ts`，不订阅 WebSocket。

## 7. 业务规则

无。

## 8. 修改约束

保持纯路由出口。若在此添加全局包裹元素（导航、弹窗容器等），会同时影响 `/login` 与 `/screen` 两个顶层全屏路由的展示（二者不属于 `AdminLayout` 子树）；全局性 UI 应放到 `layout/AdminLayout.vue` 或各视图内。

## 9. 当前实现状态

已实现，无已知问题。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/App.vue`，共 **1 个提交**。

### 2026-09-30（`4a26520`）
- 需求：管理后台基础页面及依赖配置（初始批次）。
- 修改内容（涉本文件）：创建本文件（3 行，纯 `<router-view />`）。
- 关联文件：`admin/src/main.ts`、`admin/src/router/index.ts`。
- 测试结果：见 `docs/迭代记录.md` 的 `4a26520` 条目。
