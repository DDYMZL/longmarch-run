# tsconfig.app.json

## 1. 文件路径
`admin/tsconfig.app.json`（实测 20 行）

## 2. 文件职责
管理后台**应用源码**（`admin/src/**`）的 TypeScript 编译选项集：面向浏览器环境设定 `target`/`lib`/`module`，开启 `strict` 及三项附加严格检查，并声明 `include` 范围。它是 `npm run build` 第一段 `vue-tsc --noEmit -p tsconfig.app.json`（`admin/package.json:9`）唯一使用的配置，因此也是**整个管理后台唯一的自动化类型关口**。

## 3. 业务需求
- 由 `4a26520`（2026-09-30）随管理后台工程骨架创建，此后**从未修改**（`git log --follow` 仅 1 个提交）。
- 需求本质是工程性的：Vue 3 + Vite 脚手架把「应用代码」与「Node 侧构建配置」拆成两份 tsconfig，本文件承担前者。
- 严格选项（`:14-17`）对应 `admin/agents.md`「必做验证」中「管理后台至少执行 `npm run build`」的要求——由于管理后台**无 lint、无自动化测试**（`.qoder/admin/test/README.md` §1），这份配置里的严格度直接决定了机器能拦住多少低级错误。
- 无独立业务需求文档；`docs/迭代记录.md` 的 `4a26520` 条目只有标题。

## 4. 核心功能

### 4.1 `compilerOptions`（`:2-18`）
| 行 | 选项 | 值 | 作用与影响 |
|---|---|---|---|
| `:3` | `target` | `ES2020` | 类型层面可用的语法/内置对象上限。实际产物语法由 Vite 的 `build.target` 决定（`admin/vite.config.ts` 未配置，取 Vite 默认），本项主要影响 `lib` 与降级判断 |
| `:4` | `useDefineForClassFields` | `true` | 类字段用标准 `Object.defineProperty` 语义，与 ES2022 一致；对纯 Composition API 代码几乎无感 |
| `:5` | `module` | `ESNext` | 输出/校验按 ESM，与 `admin/package.json:5` 的 `type: module` 及 Vite 的 ESM 加载一致 |
| `:6` | `lib` | `["ES2020","DOM","DOM.Iterable"]` | 提供浏览器全局类型（`document`、`location`、`WebSocket`、`FormData` 等）。`admin/src/utils/liveUpdates.ts:61-62` 用到 `location.protocol` 与 `new WebSocket`，依赖此处的 `DOM` |
| `:7` | `skipLibCheck` | `true` | 跳过 `.d.ts` 内部检查，显著加快 `vue-tsc`，代价是第三方类型声明自身的错误不被发现 |
| `:8` | `moduleResolution` | `bundler` | 按打包器规则解析（支持 `exports` 字段、免写扩展名）。与 Vite 的解析行为对齐 |
| `:9` | `allowImportingTsExtensions` | `true` | 允许 `import './x.ts'` 写法；**要求** `noEmit`（已由 `:12` 满足），否则报错 |
| `:10` | `isolatedModules` | `true` | 强制每个文件可独立转译（禁止 `const enum` 跨文件、要求类型再导出用 `export type`）。这是 Vite/esbuild 逐文件转译的前提 |
| `:11` | `moduleDetection` | `force` | 所有文件一律视为模块，避免无 import/export 的文件被当成全局脚本而污染全局作用域 |
| `:12` | `noEmit` | `true` | 只检查不产出 `.js`；产物完全由 Vite 生成 |
| `:13` | `jsx` | `preserve` | 保留 JSX 不转译。**当前仓库内无 `.tsx` 文件**（实测 `find admin/src -name "*.tsx"` 无命中），此项为脚手架默认，处于闲置状态 |
| `:14` | `strict` | `true` | 一次性开启 `strictNullChecks`、`noImplicitAny`、`strictFunctionTypes`、`strictBindCallApply`、`strictPropertyInitialization`、`noImplicitThis`、`useUnknownInCatchVariables`、`alwaysStrict` |
| `:15` | `noUnusedLocals` | `true` | 未使用的局部变量/导入报错。这是仓库「拒绝冗余代码」（根 `agents.md` §2.2）的机器化执行手段 |
| `:16` | `noUnusedParameters` | `true` | 未使用的函数参数报错（以 `_` 开头可豁免） |
| `:17` | `noFallthroughCasesInSwitch` | `true` | `switch` 分支缺 `break`/`return` 时报错 |

### 4.2 `include`（`:19`）
```json
"include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.vue"]
```
- 覆盖 `admin/src` 下的 `.ts`（实测 11 个，含唯一的声明文件 `admin/src/env.d.ts`——`.d.ts` 以 `.ts` 结尾，被 `src/**/*.ts` 匹配）、`.tsx`（实测 0 个）、`.vue`（实测 16 个），合计 27 个源文件。
- `.vue` 能被检查依赖 `vue-tsc`（`admin/package.json:25`）提供的语言插件；用原生 `tsc` 跑本配置会因无法解析 `.vue` 而失败——**必须用 `vue-tsc`**。
- **不覆盖** `admin/vite.config.ts`（属 `admin/tsconfig.node.json:14`）、**不覆盖** `admin/scripts/zip-dist.mjs`（不属任何 tsconfig，见 §9）。
- 未设 `exclude`，故 `include` 之外无需排除；`admin/node_modules` 天然不在 `src/` 下。

### 4.3 本文件**未配置**的项
| 未配置项 | 后果 |
|---|---|
| `composite` | 严格意义上 project references（`admin/tsconfig.json:4`）要求被引用项目开启此项；当前靠 `noEmit: true` + 只被 `-p` 单项目模式使用而绕过（见 §9） |
| `types` | 未显式限定，故 `node_modules/@types/*` 全部自动纳入。**`vite/client` 不是靠这里声明的**，而是由 `admin/src/env.d.ts:1` 的三斜线引用 `/// <reference types="vite/client" />` 引入（该文件在 `include` 范围内） |
| `paths` / `baseUrl` | 无路径别名，与 `admin/vite.config.ts` 未设 `resolve.alias` 一致；`admin/src` 内全部使用相对路径导入 |
| `verbatimModuleSyntax` / `importsNotUsedAsValues` | 未开启；`isolatedModules` 已提供最低限度的再导出约束 |
| `noUncheckedIndexedAccess` | 未开启，数组/对象索引访问不额外附加 `undefined` |
| `exactOptionalPropertyTypes` | 未开启 |
| `forceConsistentCasingInFileNames` | 未显式开启（TypeScript 5.x 默认已为 `true`） |

## 5. 输入与输出
- **输入**：`include`（`:19`）匹配到的 27 个源文件，及其沿 import 链拉入的第三方 `.d.ts`（`skipLibCheck: true` 使其内部不被检查）。
- **输出**：`noEmit: true`，**无任何磁盘产物**（`vue-tsc --noEmit` 模式下也不写 `.tsbuildinfo`）。输出仅为 stdout/stderr 的诊断信息与退出码。
- **退出码**：0 = 无类型错误，`npm run build` 继续执行 `vite build`；非 0 = `&&` 短路，**不构建、不打包**（`admin/package.json:9`）。
- **典型错误类别**：`strictNullChecks` 空值、`noUnusedLocals` 冗余导入、`.vue` 模板中的类型不匹配（由 `vue-tsc` 检查 `<template>`）、模块解析失败（新增依赖未登记进 `admin/package.json`）。

## 6. 依赖关系
**被谁读取、读取时机**
| 读取方 | 时机 |
|---|---|
| `vue-tsc --noEmit -p tsconfig.app.json` | 每次 `npm run build`（`admin/package.json:9`），在 `vite build` 之前 |
| `admin/tsconfig.json:4` 的 references | IDE 语言服务与手工 `tsc -b`；**当前无脚本走此路径** |
| IDE / 编辑器 | 打开 `admin/src/**` 下文件时 |

**依赖的文件与工具**
- `vue-tsc`（`admin/package.json:25`）——`.vue` 检查能力来源；用 `tsc` 代替会失败。
- `typescript ~5.6.2`（`admin/package.json:23`）。
- `admin/src/env.d.ts:1-7`——提供 `vite/client` 类型与 `*.vue` 模块声明（`declare module '*.vue'`）。**注意**：该 `*.vue` 兜底声明与 `vue-tsc` 的真实 SFC 类型推断并存；`vue-tsc` 会优先给出精确类型，声明仅在无法解析时兜底。
- 各第三方包的类型声明（`vue`、`vue-router`、`element-plus`、`axios`、`echarts`、`@element-plus/icons-vue`）。

**必须与哪些文件保持一致**
| 文件 | 一致性要求 |
|---|---|
| `admin/package.json:9` | 文件名被硬编码在 `build` 脚本里；重命名本文件必须同步改脚本 |
| `admin/tsconfig.json:4` | references 路径必须指向本文件 |
| `admin/vite.config.ts` | 若将来加 `resolve.alias`，必须同步在本文件加 `paths`，否则 IDE 无红线而构建失败（反之亦然） |
| `admin/src/**` 目录结构 | `include` 用 `src/**` 通配，源码目录整体搬迁时需同步 |
| `admin/tsconfig.node.json` | 两份配置的 `include` 不应重叠（当前不重叠：`src/**` vs `vite.config.ts`）；重叠会导致同一文件被两套 `lib`/`target` 检查而报矛盾错误 |

## 7. 业务规则
无——本文件只承载编译选项，不含业务规则。它承载的**工程约束**是：

1. **严格模式是全仓库默认**：`strict: true` + `noUnusedLocals` + `noUnusedParameters` 意味着新增代码不允许留下未使用的导入/变量，也不允许隐式 `any`；这是根 `agents.md` §2.2「拒绝冗余代码」在编译层的落地。
2. **类型检查前置于构建**：`build` 的 `&&` 串联保证「有类型错误就不出产物」，不存在「构建成功但类型不对」的中间态。
3. **检查范围 = `src/**`**：不在此范围内的代码（构建配置、打包脚本）没有机器校验，改动需人工格外小心。

## 8. 修改约束
- **不要关闭 `strict` 或三项附加严格检查**（`:14-17`）：这是唯一的自动化质量关口（管理后台无 lint、无测试，`.qoder/admin/test/README.md` §1）。若因历史代码报错需要临时放宽，应局部 `// @ts-expect-error` 并留注释，而非全局降级。
- **不要把 `noEmit` 改为 `false`**：产物由 Vite 生成，`tsc` 出 `.js` 会与 `admin/dist/` 冲突，且 `allowImportingTsExtensions: true`（`:9`）会立即报错。
- **`include` 加 `src/**/*.d.ts` 是多余的**：`.d.ts` 已被 `src/**/*.ts` 匹配（`admin/src/env.d.ts` 即如此生效）。
- **检查 `.vue` 必须用 `vue-tsc`**：把 `admin/package.json:9` 的 `vue-tsc` 换成 `tsc` 会导致 `.vue` 模块解析退化为 `env.d.ts` 的 `DefineComponent<{}, {}, any>` 兜底，模板类型错误全部漏检。
- **新增 `types` 字段需谨慎**：一旦显式写 `types`，未列出的 `@types/*` 将不再自动加载，可能引发大范围报错。当前依赖 `admin/src/env.d.ts:1` 的三斜线引用获取 `vite/client`，改动该文件与本文件需成对评估（**本文件不改 `env.d.ts`，其说明见 `.qoder/admin/src/env.d.ts.md`**）。
- **`target`/`lib` 升级要与浏览器支持范围一起评估**：管理后台面向 PC 内部使用，升级 `ES2020 → ES2022` 一般安全，但需同步 `admin/tsconfig.node.json` 的口径认知（两者本就不同：app 面向浏览器、node 面向 Node 运行时）。
- **`jsx: preserve` 当前闲置**：若真的引入 `.tsx`，需确认 Vite 侧有对应的 JSX 插件（`admin/vite.config.ts:7` 只启用了 `@vitejs/plugin-vue`，不含 `plugin-vue-jsx`），否则类型检查通过但构建失败。

## 9. 当前实现状态

**已实现**
- 覆盖 `admin/src` 下 27 个源文件（11 `.ts` + 16 `.vue`）的严格类型检查；`strict` 与三项附加检查全开；`noEmit` 与 `allowImportingTsExtensions` 组合合法；`isolatedModules` 与 Vite 的逐文件转译模型匹配。
- 作为 `npm run build` 第一段，已在多次提交中实测拦截能力有效（`docs/迭代记录.md` 的 `761d860` 条目记录「`npm run build` 通过（vue-tsc 无错）」）。

**已知问题 / 风险（事实性陈述）**
1. **检查范围不含 `admin/scripts/zip-dist.mjs`**：该脚本 144 行、手写 Zip 二进制结构（本地文件头/中央目录/EOCD + CRC-32），既不在本文件的 `include`（只含 `src/**`）内，也不在 `admin/tsconfig.node.json:14` 的 `include`（只含 `vite.config.ts`）内，且两份配置都未开 `allowJs`/`checkJs`——**它完全不受类型检查**。
2. **检查范围不含 `admin/vite.config.ts`**：该文件属 `tsconfig.node.json`，但 `admin/package.json:9` 只 `-p tsconfig.app.json`，故 `npm run build` 不检查它（详见 `.qoder/admin/tsconfig.node.json.md` §9）。
3. **未设 `composite: true`**：与 `admin/tsconfig.json:4` 的 references 组合在严格意义上不合规；当前因只被 `-p` 单项目模式调用而未暴露。执行 `tsc -b` 时是否报错——**待确认**（未实测）。
4. **`jsx: preserve` 与 `src/**/*.tsx` 通配为脚手架残留**：仓库内无 `.tsx` 文件，且 Vite 侧未装 JSX 插件，属**配置冗余**（不影响功能，但会误导后来者以为可用 TSX）。
5. **`skipLibCheck: true`** 是性能取舍：第三方声明文件自身的问题不会被发现，属业界常规做法，此处仅记录事实。
6. **未开 `noUncheckedIndexedAccess`**：对表格数据、`Object.entries` 循环等索引访问密集的代码（如 `admin/src/main.ts:77` 的图标注册循环）不提供额外的 `undefined` 保护。是否需要收紧——**待确认**（属团队取舍）。

**待确认**
- 本配置在当前依赖树（TypeScript ~5.6.2 / vue-tsc ^2.1.10）下对全部 27 个源文件是否零错误通过——按任务约束**未执行** `vue-tsc`，仅静态核对；最近一次实测结论见 `docs/迭代记录.md` 的 `761d860` 条目。

## 10. 迭代记录
数据来源：`git log --follow -- admin/tsconfig.app.json`（1 个提交）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-09-30
- 需求：搭建管理后台工程骨架，为浏览器侧 Vue 3 + TS 源码提供严格类型检查。
- 修改内容：`4a26520` 创建本文件（20 行）：`target: ES2020`、`module: ESNext`、`lib: [ES2020, DOM, DOM.Iterable]`、`moduleResolution: bundler`、`isolatedModules`、`noEmit`、`strict` 与 `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`，`include` 覆盖 `src/**` 的 `.ts`/`.tsx`/`.vue`。同提交创建 `admin/tsconfig.json`（references 指向本文件）、`admin/tsconfig.node.json`、`admin/package.json`、`admin/vite.config.ts`、`admin/index.html`。
- 关联文件：`admin/tsconfig.json`、`admin/tsconfig.node.json`、`admin/package.json`、`admin/src/main.ts`、`admin/src/env.d.ts`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `4a26520` 条目只有标题「管理后台基础页面及依赖配置」，未记录内容与验证字段）。

> **本文件自创建起未被修改过**，但它的**地位**发生过一次关键变化：`81b86e5`（2026-10-01）把 `admin/package.json` 的 `build` 从 `vue-tsc -b`（走 `tsconfig.json` 的 references，含 node 子配置）改为 `vue-tsc --noEmit -p tsconfig.app.json`，从此**只有本文件**参与自动化类型检查，`admin/vite.config.ts` 退出了机器校验范围。该变更记录在 `.qoder/admin/package.json.md` §10 与 `.qoder/admin/tsconfig.json.md` §10。
