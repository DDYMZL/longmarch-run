# tsconfig.json

## 1. 文件路径
`admin/tsconfig.json`（实测 7 行）

## 2. 文件职责
管理后台 TypeScript 的 **solution 风格根配置**：自身不编译任何文件（`"files": []`，`:2`），只用 `references`（`:3-6`）把编译任务委派给 `tsconfig.app.json`（应用代码）与 `tsconfig.node.json`（Node 侧配置文件）。它的作用是让 IDE 与 `tsc -b` 能按「浏览器环境 / Node 环境」两套互不污染的编译选项分别处理源码。

## 3. 业务需求
- 由 `4a26520`（2026-09-30）随管理后台工程骨架一并创建，此后**从未修改**（`git log --follow` 仅 1 个提交）。
- 需求本质是工程性的：Vue 3 + Vite 脚手架的标准三件套结构。`admin/src/**` 面向浏览器（需 `DOM` lib、`ES2020` target、`.vue` 支持），而 `admin/vite.config.ts` 面向 Node（需 `ES2022` target、无 DOM），两者的 `target`/`lib` 必须分开，故拆成两个子配置 + 一个 solution 根。
- 无对应的业务需求文档条目；`docs/迭代记录.md` 的 `4a26520` 条目只有标题「管理后台基础页面及依赖配置」，未展开工程配置细节。

## 4. 核心功能

### 4.1 `"files": []`（`:2`）
显式声明根配置**不包含任何输入文件**。这是 solution 风格的关键：若省略该字段，TypeScript 会按默认规则把目录下所有 `.ts` 纳入根项目，导致同一文件被两套选项重复检查、且 `references` 失去意义。

### 4.2 `"references"`（`:3-6`）
| 行 | 引用 | 覆盖范围 | 环境 |
|---|---|---|---|
| `:4` | `./tsconfig.app.json` | `src/**/*.ts`、`src/**/*.tsx`、`src/**/*.vue`（`admin/tsconfig.app.json:19`） | 浏览器（`lib` 含 `DOM`、`DOM.Iterable`） |
| `:5` | `./tsconfig.node.json` | `vite.config.ts`（`admin/tsconfig.node.json:14`） | Node（`lib` 只含 `ES2023`，无 DOM） |

两个被引用项目都设了 `"noEmit": true`（`admin/tsconfig.app.json:12`、`admin/tsconfig.node.json:11`），即项目引用**只用于类型检查与 IDE 语义**，不产生 `.js` 输出；真正的产物由 Vite 打包。

### 4.3 本文件**未配置**的项
无 `compilerOptions`（一个都没有）、无 `include`、无 `exclude`。因此：
- 在根配置层面**不存在**任何编译选项，全部由子配置决定；
- `paths` / `baseUrl` 未配置，与 `admin/vite.config.ts` 未设 `resolve.alias` 相互印证——`admin/src` 内实测无 `@/` 形式的别名导入；
- `types` 未在根配置声明，`vite/client` 的类型改由 `admin/src/env.d.ts:1` 的三斜线引用 `/// <reference types="vite/client" />` 提供。

## 5. 输入与输出
- **输入**：两个子配置文件的路径（`:4-5`）。本文件自身无编译输入（`:2`）。
- **输出**：无产物。被 `tsc -b` / `vue-tsc -b` 执行时，会为每个子项目生成增量缓存 `tsconfig.app.tsbuildinfo` 与 `tsconfig.node.tsbuildinfo`（两者当前**已被 git 跟踪**，见 §9）。
- **失败形态**：子配置路径写错 → `tsc -b` 报 "File ... not found"；子配置缺少 `composite: true` → 严格模式下 project references 会告警/报错（两个子配置**均未设 `composite`**，见 §9）。

## 6. 依赖关系
**被谁读取、读取时机**
| 读取方 | 时机 |
|---|---|
| IDE / 编辑器（VS Code、WebStorm 等）的 TS 语言服务 | 打开 `admin/` 下任意 `.ts`/`.vue` 文件时，沿目录向上找到最近的 `tsconfig.json`，再按 references 定位到实际生效的子配置 |
| `vue-tsc -b` / `tsc -b` | 手工执行时。**当前 `admin/package.json` 的任何脚本都不再调用它**——`build` 用的是 `vue-tsc --noEmit -p tsconfig.app.json`（`admin/package.json:9`），直接指向子配置、绕过本文件 |
| `vue-tsc --noEmit -p tsconfig.app.json` | 由 `npm run build` 触发，但**不读本文件**（`-p` 直接指定子配置） |

**依赖的文件**：`admin/tsconfig.app.json`、`admin/tsconfig.node.json`（缺一即引用失效）。

**必须与哪些文件保持一致**
- `admin/tsconfig.app.json` / `admin/tsconfig.node.json`：新增子项目（例如将来给 `admin/scripts/` 单独建一份 tsconfig）时必须在此追加 reference，否则 `tsc -b` 与 IDE 都不会覆盖它。
- `admin/package.json:9`：`build` 脚本绕过了本文件。若希望 `vite.config.ts` 也进自动化类型关口，需把脚本改回 `vue-tsc -b`（或额外加一段 `-p tsconfig.node.json`），届时本文件才重新成为构建链路的一环。

**无关联**：与 `admin/vite.config.ts`、`admin/index.html`、`.env.*` 无直接读取关系（Vite 不读 tsconfig 的 references；`admin/vite.config.ts` 未使用 `vite-tsconfig-paths` 之类插件，故 tsconfig 的 `paths` 即便配置也不会影响打包解析）。

## 7. 业务规则
无——本文件只承载 TypeScript 项目引用的编排，不含任何业务规则。

## 8. 修改约束
- **`"files": []` 不可删**：删掉后根项目会按默认规则吞入 `admin/` 下的 `.ts` 文件（含 `vite.config.ts`），与两个子配置重复检查，并可能用错误的 `lib` 组合报错。
- **不得在本文件添加 `compilerOptions`**：solution 根不应携带编译选项，否则会与子配置产生「哪份生效」的歧义；需要改选项请改对应子配置。
- **新增子项目必须同步追加 reference**：例如为 `admin/scripts/zip-dist.mjs` 建 `tsconfig.scripts.json` 时，须同时改本文件（`:3-6`）与 `admin/package.json` 的检查脚本，否则新配置形同虚设（当前 `scripts/` 未被任何 tsconfig 覆盖，见 `.qoder/admin/package.json.md` §9）。
- **重命名子配置文件须同步本文件与 `admin/package.json:9`**：`build` 脚本硬编码了 `tsconfig.app.json` 文件名。
- **本文件是 JSON（无注释、无尾逗号）**：TypeScript 允许 `tsconfig` 带注释，但本仓库三份 tsconfig 均为严格 JSON 风格，修改时保持一致以免 diff 噪声。

## 9. 当前实现状态

**已实现**
- solution 风格根配置成立：`files: []` + 两条 references，分别指向 app 与 node 子配置；IDE 能据此为 `src/**` 与 `vite.config.ts` 提供各自正确的编译环境。

**已知问题 / 风险（事实性陈述）**
1. **本文件已不在任何自动化链路上**：自 `81b86e5`（2026-10-01）把 `build` 从 `vue-tsc -b` 改为 `vue-tsc --noEmit -p tsconfig.app.json` 后，没有脚本再执行 `tsc -b`，本文件的 references **只在 IDE 中生效**。后果：`admin/tsconfig.node.json` 覆盖的 `vite.config.ts` 不受 `npm run build` 的类型检查。
2. **两个子项目均未设 `"composite": true`**：TypeScript 官方要求被 `references` 指向的项目开启 `composite`（隐含 `declaration`、`incremental`）。当前能工作是因为两个子配置都设了 `noEmit: true`、且实际只被 IDE 与 `-p` 单项目模式使用；一旦有人真的执行 `tsc -b`，可能报 "referenced project must have setting composite: true"。该行为**未在本机实测，待确认**。
3. **`tsconfig.app.tsbuildinfo` / `tsconfig.node.tsbuildinfo` 已被 git 跟踪**（`git ls-files admin` 实测命中）：这是 `vue-tsc -b` 时代的增量缓存残留，现脚本已不产生也不使用；根 `.gitignore` 未忽略 `*.tsbuildinfo`，而 `.qoder/README.md` §4「构建产物」行已把它列为不应建档的构建产物。属**入库的过期构建产物**，建议从版本库移除并加入忽略规则（本次建档未做任何修改）。
4. **无 `paths` / `baseUrl`**：与 `admin/vite.config.ts` 无 `resolve.alias` 一致。将来若想用 `@/` 别名，必须**同时**改本文件所在体系的子配置（`tsconfig.app.json` 的 `paths`）与 `vite.config.ts` 的 `resolve.alias`，否则 IDE 无红线但构建失败。

**待确认**
- 本文件的 references 结构在当前 TypeScript 5.6 / vue-tsc 2.1 组合下执行 `tsc -b` 是否真的通过（按任务约束未执行验证）。
- `admin/tsconfig.app.tsbuildinfo` 等缓存文件是有意入库还是历史误提交——**待确认**（`docs/迭代记录.md` 中未见相关说明）。

## 10. 迭代记录
数据来源：`git log --follow -- admin/tsconfig.json`（1 个提交）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-09-30
- 需求：搭建管理后台工程骨架，需要为浏览器侧源码与 Node 侧构建配置分别提供正确的 TypeScript 编译环境。
- 修改内容：`4a26520` 创建本文件（7 行）：`"files": []` + `references` 指向 `./tsconfig.app.json` 与 `./tsconfig.node.json`。同提交创建两份子配置、`admin/package.json`（当时 `build` 为 `vue-tsc -b && vite build`，即本文件是构建链路的一环）、`admin/vite.config.ts`、`admin/index.html`。
- 关联文件：`admin/tsconfig.app.json`、`admin/tsconfig.node.json`、`admin/package.json`、`admin/vite.config.ts`、`admin/index.html`、`admin/src/main.ts`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `4a26520` 条目只有标题「管理后台基础页面及依赖配置」，未记录内容与验证字段）。

> **后续无本文件的直接改动**，但两次外部变更改变了它的实际地位：`81b86e5`（2026-10-01）把 `build` 改为 `-p tsconfig.app.json`，本文件自此退出自动化链路；`79cf738`（2026-10-14）引入 `admin/scripts/zip-dist.mjs` 时未为其扩展 references，该脚本至今不受类型检查。两条均记录在 `.qoder/admin/package.json.md` §10。
