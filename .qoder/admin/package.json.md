# package.json

## 1. 文件路径
`admin/package.json`（实测 27 行）

## 2. 文件职责
管理后台子项目的 npm 工程清单：声明包标识与模块系统（`:2-5`）、5 条可执行脚本（`:6-12`）、6 个运行时依赖（`:13-20`）与 4 个开发期依赖（`:21-26`）。它是 `admin/` 端「怎么装、怎么跑、怎么出包」的唯一入口定义，本身不含任何业务代码。

## 3. 业务需求
- **工程初始化**：`4a26520`（2026-09-30）随「管理后台基础页面及依赖配置」一并创建（`docs/迭代记录.md` 的 `4a26520` 条目只有标题，未记录内容与验证字段）。
- **验收方式的落地**：`admin/agents.md`「必做验证」要求「管理后台至少执行 `npm run build`」，因此 `build` 脚本被设计为「类型检查 + 构建 + 打包」三合一的唯一质量关口（见 §4.2、§9）。
- **数据可视化**：`01ec93c`（2026-10-02）为驾驶舱与数据大屏页引入 `echarts`。
- **产物可部署**：`79cf738`（2026-10-14）为「构建后直接得到可解压部署的 zip」引入 `scripts/zip-dist.mjs` 并挂进 `build` 末段。
- **本地/生产双环境**：`761d860`（2026-10-16）拆分 `.env.development` / `.env.prod`，为此新增 `dev:prod` 脚本并把 `build` 的 vite 阶段显式指定为 `--mode prod`。

## 4. 核心功能

### 4.1 包标识与模块系统（`:2-5`）
| 行 | 字段 | 说明 |
|---|---|---|
| `:2` | `name` | 包名 `longmarch-admin`，仅本地标识，不发布 |
| `:3` | `private` | `true`，阻止误执行 `npm publish` |
| `:4` | `version` | `1.0.0`，**自创建起从未随迭代递增**（见 §9） |
| `:5` | `type` | `"module"`：`admin/` 目录下的 `.js` 文件与 Node 脚本一律按 **ESM** 解析。`admin/scripts/zip-dist.mjs:8-11` 使用 `import ... from 'node:fs'` 等 ESM 语法即依赖此约定（`.mjs` 后缀本身已是 ESM，`type: module` 的意义在于将来新增 `.js` 工具脚本时无需再改后缀） |

### 4.2 `scripts`（`:6-12`）——5 条，无 lint / test / type-check
| 行 | 命令 | 实际执行 | Vite mode | 加载的 env 文件 | 说明 |
|---|---|---|---|---|---|
| `:7` | `npm run dev` | `vite` | `development`（默认） | `admin/.env.development` | 本地开发服务器，`:9-18` 的 `server` 配置生效，`/api` 代理到本地后端 |
| `:8` | `npm run dev:prod` | `vite --mode prod` | `prod` | `admin/.env.prod` | 仍是本地 dev server（HMR、5173），但代理上游换成**远程已部署后端**，用于联调 |
| `:9` | `npm run build` | `vue-tsc --noEmit -p tsconfig.app.json && vite build --mode prod && node scripts/zip-dist.mjs` | `prod` | `admin/.env.prod` | 三段串联、任一失败即中断：① 类型检查 ② 构建到 `admin/dist/` ③ 压成 `admin/dist.zip` |
| `:10` | `npm run zip` | `node scripts/zip-dist.mjs` | — | — | 产物未变时单独重新出包；`dist/` 不存在或为空则报错退出（`admin/scripts/zip-dist.mjs:127-135`） |
| `:11` | `npm run preview` | `vite preview` | `production`（默认） | **无 `.env.production`** | 本地静态预览 `dist/`。注意 mode 是 `production` 而非 `prod`，见 §8、§9 |

`build` 的类型检查段用 `--noEmit -p tsconfig.app.json`，**只覆盖 `src/`**，不覆盖 `vite.config.ts`；原始版本 `4a26520` 是 `vue-tsc -b`（走 `tsconfig.json` 的 references，含 node 子配置），由 `81b86e5`（2026-10-01）改成现形态。

### 4.3 `dependencies`（`:13-20`）——6 项运行时依赖
| 行 | 包 | 版本 | 用途与已知消费点 |
|---|---|---|---|
| `:14` | `@element-plus/icons-vue` | `^2.3.1` | Element Plus 图标组件；`admin/src/main.ts:2-34` 按需具名导入 31 个图标，`:76-79` 循环全局注册（`AdminLayout.vue` 的 `<Promotion />` 等模板引用依赖此注册） |
| `:15` | `axios` | `^1.7.9` | HTTP 客户端；`admin/src/api/request.ts:14-17` 创建统一实例（`baseURL: '/api'`、`timeout: 15000`） |
| `:16` | `echarts` | `^6.1.0` | 图表；`01ec93c` 为驾驶舱运动趋势与数据大屏引入 |
| `:17` | `element-plus` | `^2.9.1` | UI 组件库；`admin/src/plugins/element-plus.ts` **手工按需注册**组件与样式，替代全量 `app.use(ElementPlus)` |
| `:18` | `vue` | `^3.5.13` | 框架本体（Composition API + `<script setup>`） |
| `:19` | `vue-router` | `^4.5.0` | 路由；`admin/src/router/index.ts:98` 用 `createWebHistory()`（HTML5 history 模式） |

### 4.4 `devDependencies`（`:21-26`）——4 项
| 行 | 包 | 版本 | 用途 |
|---|---|---|---|
| `:22` | `@vitejs/plugin-vue` | `^5.2.1` | SFC 编译插件，`admin/vite.config.ts:2,7` 唯一启用的插件 |
| `:23` | `typescript` | `~5.6.2` | 类型系统；波浪号锁定 5.6.x |
| `:24` | `vite` | `^6.0.5` | 构建工具与 dev server |
| `:25` | `vue-tsc` | `^2.1.10` | Vue SFC 类型检查器，`build` 第一段调用 |

**未安装**（实测依赖清单中无）：`unplugin-vue-components`、`unplugin-auto-import`、`unplugin-element-plus` 等自动导入插件；`eslint`、`prettier` 及任何 lint 插件；`vitest`/`jest`/`cypress`/`playwright` 等测试框架；`sass`/`less`（`admin/src` 内实测无 `lang="scss"` 的 SFC，Element Plus 样式按 `style/css` 入口引入，无需预处理器）。

## 5. 输入与输出
- **输入**：`npm` 命令行的脚本名与参数；`npm install` 时以本文件的 `dependencies`/`devDependencies` 与 `admin/package-lock.json` 共同决定安装树。
- **输出**：
  - `dev` / `dev:prod` → 常驻 dev server（`admin/vite.config.ts:10` 指定 5173，`:9` `host: true` 监听 0.0.0.0），无磁盘产物。
  - `build` → 类型检查报告（stdout）+ `admin/dist/`（构建产物）+ `admin/dist.zip`（36 文件约 520KB，`docs/迭代记录.md` 的 `761d860` 条目）。二者均被 `.gitignore:20-21` 忽略。
  - `zip` → 仅 `admin/dist.zip`。
  - `preview` → 常驻静态服务器，无产物。
- **失败形态**：`build` 三段用 `&&` 串联，类型报错即不构建、构建失败即不打包；`zip-dist.mjs` 在 `dist/` 缺失/为空时 `process.exit(1)`（`admin/scripts/zip-dist.mjs:127-135`），避免空包覆盖上一次产物。

## 6. 依赖关系
**被谁读取**
- `npm` / `pnpm` 等包管理器：安装与脚本执行。
- `vite`（dev/build/preview）：读 `type`、间接被 `scripts` 调用。
- `vue-tsc`：由 `build` 第一段以 `-p tsconfig.app.json` 显式指定配置。
- Node：`node scripts/zip-dist.mjs` 依赖 `type: module` 的 ESM 语义。

**必须与哪些文件保持一致**
| 文件 | 一致性要求 |
|---|---|
| `admin/package-lock.json` | 依赖版本与树必须同步（已入 git）；改版本后须重新安装并提交 lock |
| `admin/vite.config.ts` | `scripts` 里的 `--mode` 决定该文件 `loadEnv(mode, ...)` 读哪份 env；`build` 的 outDir 默认值对应 `zip-dist.mjs` 的 `DIST_DIR`（`admin/scripts/zip-dist.mjs:14`） |
| `admin/tsconfig.app.json` | `build` 用 `-p` 直接指向它；其 `include` 决定类型检查覆盖面 |
| `admin/tsconfig.json` / `admin/tsconfig.node.json` | **当前不被任何脚本引用**（`vue-tsc -b` 已于 `81b86e5` 移除），仅供 IDE 与手工 `tsc -b` 使用 |
| `admin/.env.development` / `admin/.env.prod` | `dev` ↔ 前者、`dev:prod`/`build` ↔ 后者，一一对应；两份文件都只定义 `VITE_API_PROXY` |
| `admin/scripts/zip-dist.mjs` | `build`/`zip` 直接调用；脚本零第三方依赖，故本文件无需为它增加任何依赖 |
| `admin/src/**` | 新增第三方库时必须在此登记，否则 `vue-tsc` 与 `vite build` 都会因解析失败而报错 |

**外部资源**：安装期访问 npm registry；运行期无网络依赖（`/api` 由 dev proxy 或 nginx 反代，见 `.qoder/ARCHITECTURE.md` §12）。

## 7. 业务规则
无——本文件是工程清单，不含积分、权限、状态流转等业务规则。它承载的是**工程约定**：

1. **`build` 是唯一自动化质量关口**：管理后台无测试框架、无 lint（`.qoder/admin/test/README.md` §1），`build` 第一段的 `vue-tsc --noEmit` 因此成为提交前唯一的机器校验；`admin/agents.md`「必做验证」明确「不能仅以类型检查或构建成功代替功能验收」，浏览器人工验收是第二道关口。
2. **命令 ↔ 环境一一对应**：`dev` 连本地后端、`dev:prod` 连远程后端、`build` 与 `.env.prod` 对齐。不得让 `build` 落到 `.env.development`。
3. **构建即出包**：`dist.zip` 由 `build` 自动产出，不需要额外手工步骤；`admin/dist.zip` 是部署交付物（`.qoder/PROJECT.md` §5「发布产物」）。

## 8. 修改约束
- **`type: module` 不可轻易改回 `commonjs`**：`admin/scripts/zip-dist.mjs` 及后续 Node 脚本按 ESM 编写；若改为 `commonjs`，`.mjs` 仍可用，但新增的 `.js` 脚本会解析失败。
- **不要在 `build` 中去掉 `vue-tsc --noEmit`**：去掉后仓库内将不存在任何自动化类型关口（无 lint、无 test）。
- **`build` 的 `--mode prod` 与文件名 `.env.prod` 必须成对存在**：Vite 默认 production 模式读的是 `.env.production`；此处靠显式 `--mode prod` 才读到 `.env.prod`。改任一侧（重命名 env 文件、去掉 `--mode prod`、或把 mode 写成 `production`）都会让 `VITE_API_PROXY` 静默取不到值。命名与 `backend/.env.prod` 保持一致，勿「顺手规范化」为 `.env.production`。
- **`preview` 的 mode 是 `production` 不是 `prod`**（`:11` 未加 `--mode`），因此它读不到 `.env.prod`。若将来要让 preview 复现生产上游，必须显式加 `--mode prod` 或另建 `.env.production`。
- **新增依赖须区分 `dependencies` / `devDependencies`**：仅构建期使用的（插件、类型、检查器）放 devDependencies，否则 `vite build` 产物虽不受影响，但依赖树语义会失真。
- **引入自动导入插件前须先处理 `admin/src/plugins/element-plus.ts` 的手工清单**：两者并存会造成重复注册机制与「按需样式」策略冲突（见 §9）。
- **版本号与 changelog**：`version` 字段目前与发布无关（部署走 `dist.zip`），若开始用它标识发布版本，需同步 `.qoder/CHANGELOG.md`。

## 9. 当前实现状态

**已实现**
- 5 条脚本覆盖开发、生产联调、构建出包、单独打包、静态预览；依赖清单与 `admin/src` 的实际 import 一致（`echarts`、`axios`、`element-plus`、`@element-plus/icons-vue`、`vue`、`vue-router` 均有消费点）。
- `build` 全链路已在 `79cf738`、`761d860` 两次提交中实测通过（`docs/迭代记录.md` 对应条目：产物 36 文件 520.5KB、`dist.zip` 已生成、CRC 经 Python `zipfile` 独立复核）。

**已知问题 / 风险（事实性陈述）**
1. **无独立 `type-check` 脚本**：类型检查只作为 `build` 的第一段存在，无法在不构建的前提下单独跑；IDE 之外的快速校验只能整跑 `build`。
2. **`vite.config.ts` 不在任何自动化类型检查范围内**：`tsconfig.node.json:14` 的 `include` 覆盖它，但自 `81b86e5` 起没有脚本再执行 `vue-tsc -b`，故该文件只有 IDE 提供类型反馈。
3. **`admin/scripts/zip-dist.mjs` 完全不受类型检查**：既不在 `tsconfig.app.json:19` 的 `include`（只含 `src/**`）内，也不在 `tsconfig.node.json:14` 的 `include`（只含 `vite.config.ts`）内；且两份 tsconfig 均未开 `allowJs`/`checkJs`。该脚本 144 行、手写 Zip 二进制结构，属高风险低覆盖区域。
4. **无 lint / 无格式化配置**：仓库内无 `.eslintrc*`、`eslint.config.*`、`.prettierrc*`，风格一致性靠人工维持。
5. **无自动化测试**：`.qoder/admin/test/README.md` §1 明确「无自动化测试框架」，本文件也无 `test` 脚本，属既定验收方式而非遗漏。
6. **`tsconfig.app.tsbuildinfo` / `tsconfig.node.tsbuildinfo` 已被 git 跟踪**（`git ls-files admin` 实测命中）：它们是 `vue-tsc -b` 时代的增量缓存，现脚本已不再产生/使用，属**入库的过期构建产物**；`.qoder/README.md` §4「构建产物」行把 `*.tsbuildinfo` 列为不建档的构建产物，但根 `.gitignore` 并未忽略它们。
7. **Element Plus 按需注册为纯手工清单**：本文件未安装任何 `unplugin-*` 自动导入插件，故 `admin/src/plugins/element-plus.ts` 的手工清单是唯一机制，不存在「自动导入与手工清单并存」的重复问题；但代价是**清单漏项即运行时组件不渲染**——`admin/src/views/ActivityView.vue:177,179` 使用了 `<el-result>`，而该清单中无 `ElResult`（`.qoder/PROJECT.md` §8「代码级技术债」已记录此项）。因无自动导入兜底，此为**真实缺陷**。
8. **`version` 恒为 `1.0.0`**：不随迭代递增，不能作为版本追溯依据；追溯请用提交号。

**待确认**
- 依赖是否能在干净环境（无 `node_modules`）下按 `package-lock.json` 完整安装、`build` 是否通过——本次建档**未执行** `npm install` / `npm run build`，仅静态核对，故记为待确认（最近一次实测见 `docs/迭代记录.md` 的 `761d860` 条目）。
- `npm run preview` 是否继承 `server.proxy`（Vite 文档称 `preview.proxy` 默认取 `server.proxy`）；若继承，则 preview 时 `VITE_API_PROXY` 取不到、回退 `admin/vite.config.ts:13` 的本地默认值——实际行为未在本机验证，待确认。

## 10. 迭代记录
数据来源：`git log --follow -- admin/package.json`（5 个提交）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-16
- 需求：本地开发与生产联调需要两套后端上游，且构建须与生产环境文件对齐。
- 修改内容：`761d860` 新增 `dev:prod`（`vite --mode prod`，`:8`）；`build` 的 vite 段改为 `vite build --mode prod`（`:9`），使其读 `admin/.env.prod`；同时新增 `admin/.env.prod`、把 `admin/.env.development` 的默认上游改为本地后端。
- 关联文件：`admin/.env.development`、`admin/.env.prod`、`admin/vite.config.ts`、`.qoder/admin/.env.development.md`、`.qoder/admin/.env.prod.md`。
- 测试结果：`npm run build` 通过（vue-tsc 无错、产物 36 文件 520.5KB、`dist.zip` 已生成）（`docs/迭代记录.md` 的 `761d860` 条目）。

### 2026-10-14
- 需求：构建产物需可直接解压部署，且运行环境可能没有 `zip`/`7z` 可执行文件。
- 修改内容：`79cf738` 在 `build` 末尾追加 `node scripts/zip-dist.mjs`，并新增独立脚本 `zip`（`:9-10`）。打包脚本零第三方依赖，故本文件的依赖清单未变。
- 关联文件：`admin/scripts/zip-dist.mjs`、根 `.gitignore:21`（新增 `admin/dist.zip`）、`admin/design.md` §6。
- 测试结果：`node --check` 与 `npm run zip` 通过；`npm run build` 全链路通过，输出「已生成 dist.zip（36 个文件，520.5 KB）」；用 Python `zipfile` 复核 `testzip()` CRC 全通过、36 条目与 `dist/` 逐文件 SHA256 一致；`dist/` 缺失或为空时报错退出（`docs/迭代记录.md` 的 `79cf738` 条目）。

### 2026-10-02
- 需求：驾驶舱与数据大屏需要图表能力。
- 修改内容：`01ec93c` 在 `dependencies` 新增 `echarts: ^6.1.0`（`:16`），本文件其余部分未变。
- 关联文件：`admin/src/views/`（驾驶舱、数据大屏页面）、`admin/src/utils/liveUpdates.ts`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `01ec93c` 条目未记录 `npm run build` 之外的验证字段）。

### 2026-10-01
- 需求：新增排名洞察与路线节点维护页面。
- 修改内容：`81b86e5` 把 `build` 的类型检查段由 `vue-tsc -b` 改为 `vue-tsc --noEmit -p tsconfig.app.json`（`:9`）。此改动使 `tsconfig.json` 的 references（含 `tsconfig.node.json`）不再被任何脚本执行。
- 关联文件：`admin/tsconfig.json`、`admin/tsconfig.app.json`、`admin/tsconfig.node.json`、`admin/src/router/index.ts`、`admin/src/api/admin.ts`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `81b86e5` 条目未记录验证字段；改动动机亦未说明，**为何从 `-b` 换成 `-p` 待确认**）。

### 2026-09-30
- 需求：搭建管理后台工程骨架。
- 修改内容：`4a26520` 创建本文件，含 `name`/`private`/`version`/`type: module`、`dev`+`build`（`vue-tsc -b && vite build`）+`preview` 三条脚本，以及 5 个运行时依赖与 4 个开发依赖。
- 关联文件：`admin/vite.config.ts`、`admin/tsconfig.json`、`admin/tsconfig.app.json`、`admin/tsconfig.node.json`、`admin/index.html`、`admin/src/main.ts`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `4a26520` 条目只有标题，无内容与验证字段）。
