# env.d.ts

## 1. 文件路径

`admin/src/env.d.ts`（7 行）

## 2. 文件职责

TypeScript 环境声明文件：引入 Vite 客户端类型（`:1`），并为 `*.vue` 单文件组件声明模块类型垫片（`:3-7`），使 `import App from './App.vue'`（`admin/src/main.ts:36`）及全部视图/组件导入能通过类型检查。

## 3. 业务需求

Vue 3 + TypeScript + Vite 工程的脚手架惯例，随初始批次 `4a26520`（2026-09-30）交付，此后零改动。

## 4. 核心功能

### 4.1 Vite 客户端类型引用（`:1`）

`/// <reference types="vite/client" />`：为 `import.meta.env`（如环境变量 `VITE_API_PROXY`，见 `.qoder/ARCHITECTURE.md` §12.2「管理后台环境切换」行）与静态资源导入提供类型。

### 4.2 `*.vue` 模块垫片（`:3-7`）

把任意 `.vue` 导入声明为 `DefineComponent<{}, {}, any>`——props/state 均为宽松类型的通用垫片，不提供组件级精确类型（精确类型由 Vue 语言工具在编辑器内给出）。较新的 Vue 工具链下该垫片通常非必需，删除是否影响 `npm run build` 的类型检查环节**待确认**（未做删除验证）。

## 5. 输入与输出

纯类型声明，无运行时代码，编译后不产生任何产物。README §5「Vue3 管理后台」补充要点（路由/表格/分页/WebSocket 等）对本文件均不适用。

## 6. 依赖关系

- 依赖：`vite/client` 类型、`vue` 的 `DefineComponent` 类型。
- 被依赖：`admin/src` 下所有 `*.vue` 导入语句的类型检查（间接被 `main.ts` 与全部视图依赖）。

## 7. 业务规则

无。

## 8. 修改约束

删除或改写前必须验证 `npm run build`（含类型检查，见 `admin/agents.md`「必做验证」）仍通过；不要在此文件添加运行时代码（`.d.ts` 只放声明）。

## 9. 当前实现状态

已实现，无已知问题。垫片类型为宽松 `any` 属通用写法，非缺陷。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- admin/src/env.d.ts`，共 **1 个提交**。

### 2026-09-30（`4a26520`）
- 需求：管理后台基础页面及依赖配置（初始批次）。
- 修改内容（涉本文件）：创建本文件。
- 关联文件：`admin/src/main.ts`、`admin/tsconfig*.json`。
- 测试结果：见 `docs/迭代记录.md` 的 `4a26520` 条目。
