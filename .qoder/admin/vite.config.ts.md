# vite.config.ts

## 1. 文件路径
`admin/vite.config.ts`（实测 20 行）

## 2. 文件职责
管理后台的 Vite 构建与开发服务器配置。采用**函数式配置**按 `mode` 读取 env 文件（`:4-5`），启用 Vue SFC 插件（`:7`），并配置 dev server 的监听地址、端口与 `/api` 反向代理（含 WebSocket）（`:8-18`）。它是「前端相对路径 `/api` 如何在本地落到后端」的唯一决定点。

## 3. 业务需求
- **工程初始化**：`4a26520`（2026-09-30）创建，最初形态是静态对象配置 + 硬编码本地代理目标，注释说明「本机 8000 被 C-Lodop 打印服务占用，故后端用 8010」。
- **跨域规避**：管理后台通过 `admin/src/api/request.ts:14-17` 的 `baseURL: '/api'` 发相对路径请求，本地开发时由本文件的 proxy 转发到后端，浏览器不感知跨域；生产由 nginx 反代承担同一职责（`.qoder/ARCHITECTURE.md` §12）。
- **实时推送**：`82af32c`（2026-10-01）后端新增 WebSocket 数据变更广播后，本文件补 `ws: true`，使 `admin/src/utils/liveUpdates.ts:62` 连接的 `/api/ws/updates` 在本地开发时也能走代理升级。
- **局域网验收**：`18a8848`（2026-10-10）需求为「本机 IP + 端口供他人访问管理后台」，加 `host: true` 监听 0.0.0.0，免去每次手敲 `--host`。
- **双环境上游**：`761d860`（2026-10-16）前后，代理目标由硬编码改为读 `VITE_API_PROXY`，配合 `.env.development`（本地后端）与 `.env.prod`（远程后端）实现同一份代码连不同上游。

## 4. 核心功能

### 4.1 函数式配置与 env 加载（`:4-6`）
- `defineConfig(({ mode }) => {...})`：配置在**已知 mode 之后**求值，因此可按环境切换。mode 由命令行决定——`vite`（dev）为 `development`、`vite --mode prod` 为 `prod`、`vite build --mode prod` 为 `prod`、`vite preview` 为 `production`。
- `loadEnv(mode, '.', '')`：从 envDir `'.'`（相对 `process.cwd()`，即 `admin/`）读取 `.env`、`.env.[mode]`、`.env.[mode].local`。第三个参数传**空串**表示不按 `VITE_` 前缀过滤，文件内所有键都会被读入返回对象（因此本文件能直接取到 `VITE_API_PROXY`；副作用是任何非 `VITE_` 前缀的键也可读，但**不会**被注入客户端代码——注入仍受 `VITE_` 前缀限制）。

### 4.2 插件（`:7`）
仅 `vue()`（`@vitejs/plugin-vue`）。**没有**自动导入类插件（`unplugin-vue-components` / `unplugin-auto-import`）、没有 legacy/兼容插件、没有压缩或分析插件。Element Plus 的按需注册与按需样式全部由 `admin/src/plugins/element-plus.ts` 手工完成，不依赖构建期插件。

### 4.3 dev server 与代理（`:8-18`）
| 行 | 配置 | 说明 |
|---|---|---|
| `:9` | `host: true` | 监听 `0.0.0.0`，局域网内其他机器可用「本机 IP:5173」访问（`18a8848`）。他人能否连通还取决于 Windows 防火墙放行 5173（`docs/迭代记录.md` 的 `18a8848` 条目） |
| `:10` | `port: 5173` | 显式固定端口；被占用时 Vite 默认会自增到 5174，届时依赖 5173 的口头约定/防火墙规则会失效 |
| `:11-17` | `proxy` | 只有一条规则，前缀 `/api` |
| `:13` | `target: env.VITE_API_PROXY \|\| 'http://127.0.0.1:8010'` | 上游取自 env；env 缺失时回退到**本地回环地址上的后端端口**（与 `4a26520` 的原始硬编码值等价），保证「没配 env 也能连本机后端」 |
| `:14` | `changeOrigin: true` | 转发时把 `Host` 头改为目标主机名。远程上游为 HTTPS 域名时这是**必需**的（否则 SNI/虚拟主机与后端校验会失配） |
| `:15` | `ws: true` | 允许该前缀下的 WebSocket 升级请求被代理，支撑 `admin/src/utils/liveUpdates.ts:61-62` 按 `location.protocol` 拼出的 `ws(s)://<location.host>/api/ws/updates` |

### 4.4 本文件**未配置**的项（均取 Vite 默认值）
| 项 | 默认值 | 影响 |
|---|---|---|
| `base` | `'/'` | 产物内资源路径为站点根绝对路径。与 `admin/src/router/index.ts:98` 的 `createWebHistory()`（无 base 参数）一致；若将来部署到子路径，`base`、`createWebHistory(base)` 与 nginx `location` **三处必须同步改** |
| `build.outDir` | `'dist'` | 对应 `admin/scripts/zip-dist.mjs:14` 的 `DIST_DIR` |
| `build.sourcemap` | `false` | 生产产物不含 sourcemap |
| `build.rollupOptions` | 无 | **未做手动分包**，`echarts`、`element-plus` 与业务代码的分块由 Vite 默认策略决定 |
| `resolve.alias` | 无 | `admin/src` 内实测无 `@/` 形式的别名导入（全部相对路径），故无需配置；新增别名导入会直接构建失败 |
| `preview` | 无 | `npm run preview` 未单独配 proxy/host/port，依赖 Vite「`preview.proxy` 默认继承 `server.proxy`」的行为（未实测，见 §9） |
| `css` | 无 | 无预处理器配置；`admin/src` 内无 `lang="scss"` 的 SFC |
| `envPrefix` | `'VITE_'` | 未放宽，故只有 `VITE_` 开头的变量会被注入客户端代码 |

## 5. 输入与输出
- **输入**
  - 命令行 `mode`（`development` / `prod` / `production`）。
  - env 文件中的 `VITE_API_PROXY`（`admin/.env.development:3` 或 `admin/.env.prod:4`）——**本文件消费的唯一环境变量**。
  - `process.cwd()`：决定 `loadEnv` 的 `'.'` 解析到哪个目录（npm 脚本下为 `admin/`）。
- **输出**：一个 Vite 内部配置对象（`UserConfig`），不落盘。
- **可观测行为**
  - dev：5173 端口起服务；`/api/**` 的 HTTP 与 WS 请求被转发到 `VITE_API_PROXY`；其余路径按静态资源/SPA 处理。
  - build：把 `admin/index.html` + `admin/src/main.ts` 为入口的依赖图打包到 `admin/dist/`；**`server.proxy` 完全不参与产物**，`VITE_API_PROXY` 也不被写进任何 JS（`admin/src` 内无 `import.meta.env.VITE_API_PROXY` 的直接使用，代理地址只在 Node 侧的本文件被读取）。
- **异常形态**：`VITE_API_PROXY` 拼错或未定义 → 不报错，静默回退本地默认值（`:13`），表现为「连了本机后端却以为是远程」；上游不可达 → 浏览器侧收到 500/ECONNREFUSED 由 Vite 代理层抛出。

## 6. 依赖关系
**依赖的模块**
- `vite`（`defineConfig`、`loadEnv`）与 `@vitejs/plugin-vue`，均来自 `admin/package.json:22,24`。
- Node 运行时（配置文件由 Vite 以 ESM 方式加载，`admin/package.json:5` 的 `type: module`）。

**被谁读取、何时读取**
| 读取方 | 时机 |
|---|---|
| `vite`（dev / build / preview） | 每次命令启动时；dev 下修改本文件会触发 server 自动重启 |
| `vue-tsc` / `tsc` | 仅当执行 `tsc -b`（走 `admin/tsconfig.json` 的 references）时，经 `admin/tsconfig.node.json:14` 的 `include` 被类型检查。**当前 `npm run build` 不含此步**（`admin/package.json:9` 用 `-p tsconfig.app.json`） |
| IDE / 编辑器 | 通过 `tsconfig.node.json` 提供类型提示 |

**必须与哪些文件保持一致**
| 文件 | 一致性要求 |
|---|---|
| `admin/.env.development` / `admin/.env.prod` | 键名必须是 `VITE_API_PROXY`；两份文件都只定义这一个键 |
| `admin/package.json` 的 `scripts` | `--mode` 值决定读哪份 env；`build` 段的 outDir 默认值被 `zip-dist.mjs` 假定 |
| `admin/src/api/request.ts:14-17` | `baseURL: '/api'` 必须与 `:12` 的代理前缀完全一致，改任一侧都会让本地请求 404 |
| `admin/src/utils/liveUpdates.ts:61-62` | WS 路径以 `/api` 开头，故被同一条规则覆盖；若后端把 WS 挪到 `/api` 之外，必须在此新增代理规则并同样带 `ws: true` |
| `admin/src/router/index.ts:98` | `createWebHistory()` 与 `base` 默认 `'/'` 相互印证 |
| `admin/index.html` | 构建入口 HTML；`admin/src/main.ts` 为其脚本入口 |
| `admin/tsconfig.node.json:14` | `include` 必须列出本文件，否则 IDE 无类型提示 |
| 后端监听端口 | `:13` 的回退默认值指向后端本地端口，须与 `backend/run.py` 的启动端口一致 |
| nginx（生产，配置不在仓库内） | 生产环境承担与本文件 proxy 等价的 `/api` 反代职责；nginx 侧还需转发 `Upgrade`/`Connection` 头并用 `proxy_http_version 1.1`，否则 WS 不通（`.qoder/ARCHITECTURE.md` §12） |

## 7. 业务规则
无——本文件不含积分、权限、状态流转等业务规则。它承载的是**架构不变量**：

1. **前端只用相对路径 `/api`，环境差异全部落在代理层**：浏览器代码里不出现任何后端主机名，因此同一份 `dist/` 可在任意环境部署，切换环境不需要重新构建。
2. **代理只在 dev/preview 生效，不进产物**：`VITE_API_PROXY` 是 Node 侧配置，不会被打包进客户端 JS；生产 `/api` 由 nginx 反代（`admin/.env.prod:2-3` 的注释明确了这一点）。
3. **`/api` 前缀同时承载 HTTP 与 WebSocket**：`ws: true` 使二者共用一条规则；后端所有实时推送路径必须保持在 `/api` 之下。

## 8. 修改约束
- **`changeOrigin: true` 与 `ws: true` 不可删**：删 `changeOrigin` 会让 `dev:prod`（HTTPS 域名上游）握手失败；删 `ws: true` 会让本地开发时实时推送静默不通（页面其余功能正常，极难发现）。
- **代理前缀 `/api` 是跨文件契约**：与 `admin/src/api/request.ts:15`、`admin/src/utils/liveUpdates.ts:62`、后端 `API_PREFIX`、nginx 反代规则四处绑定，不得单侧修改。
- **`loadEnv` 的第三参 `''` 不要改成 `'VITE_'` 以外的前缀或删掉**：改动会直接影响 `env.VITE_API_PROXY` 能否读到。同时**不要**借此把敏感变量（后端密钥之类）读进本文件并注入客户端——`envPrefix` 默认 `'VITE_'` 是防泄露边界，凡 `VITE_` 开头的变量都会进产物，等同公开。
- **`loadEnv(mode, '.', '')` 的 `'.'` 依赖 cwd**：必须在 `admin/` 目录下执行命令（npm scripts 天然满足）。若在仓库根用 `npx vite --config admin/vite.config.ts` 启动，envDir 会解析到仓库根，`.env.*` 读不到、静默回退本地默认上游。建议改成 `__dirname`/`fileURLToPath` 锚定（当前未做，见 §9）。
- **不要新增 `base` 子路径而不同步改 `createWebHistory()` 与 nginx**：三者必须一起改，否则深层路由刷新 404、资源 404。
- **端口 5173 已被防火墙规则与团队口头约定绑定**（`docs/迭代记录.md` 的 `18a8848` 条目），改动需同步放行新端口。
- **本文件不在自动化类型检查范围内**：修改后 IDE 无红线不等于 `build` 会通过；配置项拼写错误（如把 `changeOrigin` 误写成 `changeOrigin` 之外的形式）只会在运行时表现为「代理不生效」，不会报错。

## 9. 当前实现状态

**已实现**
- 按 mode 读 env 的函数式配置；Vue SFC 编译；0.0.0.0:5173 监听；`/api` 的 HTTP + WS 代理；env 缺失时的本地回退默认值。
- `ws: true` **已配置**（`:15`，自 `82af32c` 起），本地开发的实时推送链路完整——此前建档任务书中「dev proxy 可能未代理 WebSocket」的怀疑经核实**不成立**。
- `base` 保持默认 `'/'`，与 `createWebHistory()` 及生产 nginx 静态站点部署方式一致，无需为子路径做额外适配。

**已知问题 / 风险（事实性陈述）**
1. **未显式配置 `preview.proxy`**：`npm run preview` 的 mode 是 `production`，仓库内**没有 `.env.production`**，故 `env.VITE_API_PROXY` 为 `undefined`、回退 `:13` 的本地默认值。即使 Vite 的 `preview.proxy` 继承了 `server.proxy`，preview 也只会指向本地后端，无法预览「生产上游」组合。
2. **envDir 用相对 `'.'`**：对执行目录敏感，见 §8。
3. **无构建期分包与体积控制**：`echarts` + `element-plus` 均进主依赖图，`build.rollupOptions.output.manualChunks` 未配置；产物 36 文件约 520KB（`docs/迭代记录.md` 的 `761d860` 条目）。是否需要按路由/图表库分包以改善首屏，**待确认**。
4. **无 `build.sourcemap`**：生产报错无法映射回源码，排障依赖本地复现。
5. **本文件不受 `npm run build` 的类型检查覆盖**（`admin/package.json:9` 只 `-p tsconfig.app.json`）；`admin/tsconfig.node.json` 虽 `include` 了它，但没有脚本执行 `tsc -b`。
6. **代理仅一条 `/api` 规则**：若后端将来暴露 `/api` 之外的路径（如独立的静态文件服务、健康检查），本地开发会 404。
7. **生产 WebSocket 依赖 nginx 正确转发升级头**：本文件管不到生产链路；`.qoder/ARCHITECTURE.md` §12 已记录「nginx 未转发 `Upgrade`/`Connection` 头且默认 `proxy_http_version 1.0`」曾是实时推送不通的根因，nginx 配置文件不在仓库内、路径未核实（`.qoder/ARCHITECTURE.md` §16「待确认清单」第 2 条）。

**待确认**
- 本文件的类型检查是否真的通过（未执行 `npx tsc -p tsconfig.node.json`，按任务约束不验证）。
- `preview.proxy` 是否确实继承 `server.proxy`（Vite 文档如此描述，未在本机实测）。
- `port: 5173` 未配 `strictPort`，端口被占用时是否应改为硬性失败而非静默自增——**待确认**（属团队偏好，非代码事实）。

## 10. 迭代记录
数据来源：`git log --follow -- admin/vite.config.ts`（4 个提交）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-10
- 需求：「本机 IP + 端口供他人访问管理后台」，便于他人验收而不必各自起环境。
- 修改内容：`18a8848` 在 `server` 中新增 `host: true`（`:9`），监听 `0.0.0.0`，不再依赖手动 `--host` 参数。接口仍走 `/api` 相对路径由本文件代理到本机后端，他人浏览器无需改接口地址、不涉及跨域。
- 关联文件：`admin/package.json`（`dev` 脚本）、`admin/src/api/request.ts`、Windows 防火墙规则（仓库外）。
- 测试结果：`npm run build` 通过；重启 `npm run dev`（不带 `--host`）后 `netstat` 确认监听 `0.0.0.0:5173`，`curl http://127.0.0.1:5173/` 与局域网 IP 访问均返回 200。注意他人能否连上还取决于防火墙放行 5173，且须与本机同一局域网（`docs/迭代记录.md` 的 `18a8848` 条目）。

### 2026-10-01
- 需求：后端新增 WebSocket 数据变更广播（步数/点亮/答题/勋章/组织操作实时推送管理端），本地开发需要 WS 也能走代理。
- 修改内容：`82af32c` 在 `/api` 代理规则中新增 `ws: true`（`:15`）。
- 关联文件：`admin/src/utils/liveUpdates.ts`、后端 WebSocket 广播实现（`.qoder/ARCHITECTURE.md` §6）。
- 测试结果：待确认（`docs/迭代记录.md` 的 `82af32c` 条目只有一句内容摘要，未记录验证字段；该提交范围标注为 backend）。

### 2026-10-01（同日，另一次提交）
- 需求：新增排名洞察与路线节点维护页面；代理目标需可按环境切换。
- 修改内容：`81b86e5` 把配置由静态对象改为函数式 `defineConfig(({ mode }) => ...)` + `loadEnv`，`target` 由硬编码改为 `env.VITE_API_PROXY || '本地默认值'`（`:4-5,13`）；同提交把 `admin/package.json` 的 `build` 类型检查段由 `vue-tsc -b` 改为 `-p tsconfig.app.json`。
- 关联文件：`admin/package.json`、`admin/.env.development`、`admin/src/router/index.ts`、`admin/src/api/admin.ts`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `81b86e5` 条目未记录验证字段）。

### 2026-09-30
- 需求：搭建管理后台工程骨架。
- 修改内容：`4a26520` 创建本文件（16 行）：静态 `defineConfig`、`plugins: [vue()]`、`server.port: 5173`、`/api` 代理硬编码到本地后端端口并带 `changeOrigin: true`；文件头注释说明「本机 8000 被 C-Lodop 打印服务占用」故后端用 8010。
- 关联文件：`admin/package.json`、`admin/tsconfig*.json`、`admin/index.html`、`admin/src/main.ts`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `4a26520` 条目只有标题，无内容与验证字段）。
