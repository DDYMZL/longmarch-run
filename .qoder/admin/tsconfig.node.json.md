# tsconfig.node.json

## 1. 文件路径
`admin/tsconfig.node.json`（实测 15 行）

## 2. 文件职责
管理后台 **Node 侧构建配置**的 TypeScript 编译选项集：面向 Node 运行时设定 `target: ES2022` 与 `lib: ["ES2023"]`（**不含 DOM**），并把 `include` 限定为 `vite.config.ts` 一个文件（`:14`）。它与 `admin/tsconfig.app.json` 互补，共同被 `admin/tsconfig.json:3-6` 以 project references 方式编排。

## 3. 业务需求
- 由 `4a26520`（2026-09-30）随管理后台工程骨架创建，此后**从未修改**（`git log --follow` 仅 1 个提交）。
- 需求本质：`admin/vite.config.ts` 在 Node 中执行（用到 `loadEnv`、`process.cwd()` 语义、可能用到 `node:` 内置模块），而 `admin/src/**` 在浏览器中执行（用到 `document`、`location`、`WebSocket`）。两者若共用一套 `lib`，浏览器代码可能误用 Node API、Node 代码可能误用 DOM API 而**编译期发现不了**。拆出本文件即为在类型层面隔离这两个环境。
- 无独立业务需求文档；`docs/迭代记录.md` 的 `4a26520` 条目只有标题。

## 4. 核心功能

### 4.1 `compilerOptions`（`:2-13`）
| 行 | 选项 | 值 | 作用，以及与 `tsconfig.app.json` 的差异 |
|---|---|---|---|
| `:3` | `target` | `ES2022` | 比 app 侧（`ES2020`）高一档；Node 18+ 原生支持顶层 `await`、类字段、`Error.cause` |
| `:4` | `lib` | `["ES2023"]` | **只含 ES 标准库，不含 `DOM`/`DOM.Iterable`**。这是本文件存在的核心理由：在 `vite.config.ts` 里写 `document`、`window`、`WebSocket` 会直接报类型错误 |
| `:5` | `module` | `ESNext` | 与 `admin/package.json:5` 的 `type: module` 一致；Vite 以 ESM 加载配置 |
| `:6` | `skipLibCheck` | `true` | 跳过 `.d.ts` 内部检查，加速 |
| `:7` | `moduleResolution` | `bundler` | 与 app 侧相同。注意：对纯 Node 脚本更贴切的是 `nodenext`，此处沿用脚手架默认（见 §9） |
| `:8` | `allowImportingTsExtensions` | `true` | 允许带 `.ts` 扩展名导入；**要求** `noEmit`（已由 `:11` 满足） |
| `:9` | `isolatedModules` | `true` | 每文件可独立转译 |
| `:10` | `moduleDetection` | `force` | 所有文件视为模块 |
| `:11` | `noEmit` | `true` | 只检查不产出。`vite.config.ts` 的实际「编译」由 Vite 自身在启动时用 esbuild 完成，与本配置无关 |
| `:12` | `strict` | `true` | 严格模式全开 |

**相比 `tsconfig.app.json` 缺少**（有意或脚手架默认，见 §9）：`useDefineForClassFields`、`jsx`、`noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`。即 Node 侧的严格度**低于**应用侧——未使用的局部变量/参数在 `vite.config.ts` 中不会报错。

### 4.2 `include`（`:14`）
```json
"include": ["vite.config.ts"]
```
- **只覆盖 1 个文件**：`admin/vite.config.ts`（20 行）。
- **不覆盖** `admin/scripts/zip-dist.mjs`：该脚本是 Node 侧代码、语义上正属本配置的范围，但既未列入 `include`，两份 tsconfig 也都未开 `allowJs`/`checkJs`（`.mjs` 亦需 `allowJs` 才会被纳入），故**它不受任何类型检查**。这是本文件当前最主要的覆盖缺口（详见 §9）。
- **不覆盖** `admin/tsconfig.json` 自身、`admin/package.json`（`resolveJsonModule` 未开启，若在 `vite.config.ts` 里 `import pkg from './package.json'` 会报错）。
- 未设 `exclude`。

## 5. 输入与输出
- **输入**：`admin/vite.config.ts`，及其 import 链拉入的 `vite`、`@vitejs/plugin-vue` 的类型声明（`skipLibCheck: true`，声明内部不被检查）。
- **输出**：`noEmit: true`，**无磁盘产物**。以 `tsc -p tsconfig.node.json --noEmit` 形式执行时输出诊断信息与退出码；以 `tsc -b` 形式执行时会生成增量缓存 `admin/tsconfig.node.tsbuildinfo`（该文件**当前已被 git 跟踪**，属历史残留，见 §9）。
- **当前没有任何命令实际执行本配置**：`admin/package.json:6-12` 的 5 条脚本中，`build` 用 `-p tsconfig.app.json`（不含本配置），其余 4 条与 tsc 无关。故本配置的输入输出只在 IDE 与手工命令下发生。

## 6. 依赖关系
**被谁读取、读取时机**
| 读取方 | 时机 |
|---|---|
| `admin/tsconfig.json:5` 的 references | IDE 语言服务解析 `admin/vite.config.ts` 时；以及手工执行 `tsc -b` / `vue-tsc -b` 时。**`admin/package.json` 中已无脚本走此路径**（`81b86e5` 起 `build` 改为 `-p tsconfig.app.json`） |
| IDE / 编辑器 | 打开 `admin/vite.config.ts` 时，据 `include` 命中本配置并套用「无 DOM」的 `lib` |
| `vite` CLI | **不读本文件**。Vite 用 esbuild 转译 `vite.config.ts`，只按自身的 `tsconfig` 探测逻辑取少量选项（如 `target`），不做类型检查 |

**依赖的文件与工具**
- `typescript ~5.6.2`（`admin/package.json:23`）；若用 `vue-tsc` 亦可（`admin/package.json:25`），但本配置无 `.vue` 文件，原生 `tsc` 足够。
- `vite` 与 `@vitejs/plugin-vue` 的类型声明（`admin/package.json:22,24`）。

**必须与哪些文件保持一致**
| 文件 | 一致性要求 |
|---|---|
| `admin/vite.config.ts` | `include` 硬编码了该文件名；重命名配置文件必须同步改本文件（`:14`）与 `admin/tsconfig.json` |
| `admin/tsconfig.json:5` | references 路径必须指向本文件 |
| `admin/tsconfig.app.json:19` | 两份配置的 `include` **不得重叠**（当前为 `vite.config.ts` vs `src/**`，不重叠）。若把 `src/**` 误加进本文件，同一批源码会被「无 DOM」的 `lib` 检查而大面积报错 |
| `admin/package.json:9` | 若希望 `vite.config.ts` 重新进入自动化类型关口，需把 `build` 改回 `vue-tsc -b`，或额外追加 `-p tsconfig.node.json` 一段 |
| `admin/scripts/zip-dist.mjs` | 若决定给它加类型检查，需在本文件的 `include` 中追加该路径**并**开启 `allowJs` + `checkJs`（`.mjs` 也需 `allowJs`），或另建一份 tsconfig 并挂进 `admin/tsconfig.json` 的 references |

## 7. 业务规则
无——本文件只承载编译选项，不含业务规则。它承载的**工程约束**是：

1. **环境隔离**：`lib` 不含 `DOM` 是一条硬边界——构建配置运行在 Node，不允许触碰浏览器 API。这条约束只在类型层生效，Vite 实际转译时并不校验。
2. **构建配置也是代码，应有类型检查**：本文件的存在意图即在此；但由于 `admin/package.json:9` 绕过了 references，这一意图**当前未被自动化兑现**（见 §9）。

## 8. 修改约束
- **不要给 `lib` 加 `DOM`**：加了就失去本文件与 `tsconfig.app.json` 分立的唯一意义，`vite.config.ts` 里误用浏览器 API 将不再报错。
- **不要把 `include` 扩成 `**/*.ts` 或加入 `src/**`**：会与 `tsconfig.app.json` 重叠，导致应用源码被按「无 DOM + ES2022」检查而报错。
- **不要把 `noEmit` 改为 `false`**：会与 `allowImportingTsExtensions: true`（`:8`）冲突并直接报错；`vite.config.ts` 也无需产出 `.js`。
- **追加 `allowJs`/`checkJs` 前先评估存量报错**：`admin/scripts/zip-dist.mjs` 144 行从未受类型检查（大量 `Buffer.alloc` + 位运算 + 默认参数），一旦开启可能一次性暴露较多问题，应作为独立任务处理而非顺手改配置。
- **`moduleResolution: bundler` 与 `module: ESNext` 的组合不要单独改一项**：`bundler` 要求 `module` 为 `esnext`/`preserve`；若改成 `nodenext`，则 `module` 也须改为 `nodenext`，且 `vite.config.ts` 中的裸包导入解析规则会变化。
- **补 `noUnusedLocals`/`noUnusedParameters` 时须与 app 侧口径一致**：两份配置的严格度差异是脚手架默认而非有意设计（见 §9），拉齐是安全方向，但需先清理存量。

## 9. 当前实现状态

**已实现**
- 为 `admin/vite.config.ts` 提供「Node 环境、无 DOM、ES2022/ES2023、strict」的类型检查配置；与 `tsconfig.app.json` 的 `include` 无重叠；由 `admin/tsconfig.json:5` 正确引用。
- IDE 中编辑 `admin/vite.config.ts` 能获得类型提示与错误标注（这是本文件当前**唯一实际发挥作用**的场景）。

**已知问题 / 风险（事实性陈述）**
1. **`admin/scripts/zip-dist.mjs` 不在任何 tsconfig 的 `include` 内，完全不受类型检查**：本文件的 `include` 只有 `vite.config.ts`（`:14`），`admin/tsconfig.app.json:19` 只有 `src/**`，且两份配置均未开 `allowJs`/`checkJs`。该脚本手写 Zip 二进制结构（本地文件头/中央目录/EOCD、CRC-32 查表、MS-DOS 时间戳），是仓库中类型风险最高、机器覆盖最低的文件之一。它曾有实测兜底（`docs/迭代记录.md` 的 `79cf738` 条目：用 Python `zipfile` 独立复核 CRC 与逐文件 SHA256），但那是一次性验证，非持续关口。
2. **本配置不被任何 npm 脚本执行**：`81b86e5`（2026-10-01）把 `build` 从 `vue-tsc -b` 改为 `vue-tsc --noEmit -p tsconfig.app.json` 后，`admin/vite.config.ts` 退出了自动化类型关口。后果：该文件里的配置项拼写错误（例如代理选项名写错）只会在**运行时**表现为「代理不生效」，编译期与构建期都不会报错。
3. **`admin/tsconfig.node.tsbuildinfo` 已被 git 跟踪**（`git ls-files admin` 实测命中）：`tsc -b` 时代的增量缓存残留，现无脚本产生/使用它；根 `.gitignore` 未忽略 `*.tsbuildinfo`，而 `.qoder/README.md` §4「构建产物」行已把它列为不应建档的构建产物。属**入库的过期构建产物**。
4. **未设 `composite: true`**：被 `admin/tsconfig.json:5` 引用却不满足 project references 的严格要求；当前因只被 IDE 使用而未暴露，执行 `tsc -b` 时是否报错——**待确认**（未实测）。
5. **严格度低于 app 侧**：缺 `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`/`useDefineForClassFields`。差异源于脚手架默认，仓库内未见对其取舍的说明——是否有意，**待确认**。
6. **未开 `resolveJsonModule`**：`vite.config.ts` 若需读 `package.json`（例如按版本号注入 `define`）会报错，需先开启此项。

**待确认**
- 对 `admin/vite.config.ts` 执行 `tsc -p tsconfig.node.json --noEmit` 是否零错误通过——按任务约束**未执行**验证。
- 执行 `tsc -b`（走 references）在当前 TypeScript ~5.6.2 下是否会因缺 `composite` 而失败——未实测。

## 10. 迭代记录
数据来源：`git log --follow -- admin/tsconfig.node.json`（1 个提交）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-09-30
- 需求：搭建管理后台工程骨架，需在类型层面隔离「浏览器侧应用代码」与「Node 侧构建配置」。
- 修改内容：`4a26520` 创建本文件（15 行）：`target: ES2022`、`lib: ["ES2023"]`（不含 DOM）、`module: ESNext`、`moduleResolution: bundler`、`isolatedModules`、`noEmit`、`strict`，`include` 限定为 `vite.config.ts`。同提交创建 `admin/tsconfig.json`（references 指向本文件）、`admin/tsconfig.app.json`、`admin/package.json`（当时 `build` 为 `vue-tsc -b && vite build`，即本文件是构建链路的一环）、`admin/vite.config.ts`、`admin/index.html`。
- 关联文件：`admin/tsconfig.json`、`admin/tsconfig.app.json`、`admin/package.json`、`admin/vite.config.ts`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `4a26520` 条目只有标题「管理后台基础页面及依赖配置」，未记录内容与验证字段）。

> **本文件自创建起未被修改过**，两次外部变更改变了它的实际覆盖面与地位：
> - `81b86e5`（2026-10-01）：`build` 改为 `vue-tsc --noEmit -p tsconfig.app.json`，本配置自此不被任何脚本执行（记录见 `.qoder/admin/package.json.md` §10）。
> - `79cf738`（2026-10-14）：新增 `admin/scripts/zip-dist.mjs`（Node 侧代码，语义上属本配置范围）时**未同步扩展 `include`**，该脚本至今无类型检查（记录见 `.qoder/admin/package.json.md` §10）。
