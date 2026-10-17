# index.html

## 1. 文件路径
`admin/index.html`（实测 12 行）

## 2. 文件职责
管理后台的**单一 HTML 入口**（SPA shell）：声明文档语言与字符集、视口、页面标题，提供 Vue 应用的挂载点 `<div id="app">`（`:9`），并以 `type="module"` 引入源码入口 `/src/main.ts`（`:10`）。Vite 以本文件为构建依赖图的根，dev 时原样提供、build 时把脚本引用替换为打包后的资源。

## 3. 业务需求
- 由 `4a26520`（2026-09-30）随管理后台工程骨架创建，此后**从未修改**（`git log --follow` 仅 1 个提交）。
- 需求本质是工程性的：Vue 3 + Vite 的 SPA 必须有一个 HTML 入口；本文件即该入口。
- **面向 PC 内部管理人员**，但仍保留 `viewport` meta（`:5`）——`admin/agents.md`「开发约定」要求数据页覆盖「窄屏可用性」，该 meta 是浏览器窄屏/缩放场景下正常渲染的前提。
- **无外部 CDN 依赖**是隐性需求：`.qoder/ARCHITECTURE.md` §12 记录生产为内网服务器上的 nginx 静态站点，若引入外部字体/图标 CDN 会在离线或外网受限环境下阻塞首屏。当前实现满足此要求（见 §4.4）。

## 4. 核心功能

### 4.1 文档声明（`:1-2`）
- `:1` `<!DOCTYPE html>`：标准模式渲染。
- `:2` `<html lang="zh-CN">`：文档语言声明为简体中文，与页面实际文案一致；影响屏幕阅读器发音与浏览器翻译提示。

### 4.2 `<head>`（`:3-7`）
| 行 | 元素 | 说明 |
|---|---|---|
| `:4` | `<meta charset="UTF-8" />` | 字符集。**必须位于 `<head>` 前部**（当前是第一个子元素），否则中文标题与文案可能乱码 |
| `:5` | `<meta name="viewport" content="width=device-width, initial-scale=1.0" />` | 视口。PC 后台保留此项用于窄屏/缩放适配 |
| `:6` | `<title>长征运动挑战 · 管理后台</title>` | 静态标题，只在**首屏到路由就绪之间**可见；此后由 `admin/src/router/index.ts:103` 的 `document.title = \`${to.meta.title \|\| '管理后台'} · 长征运动挑战\`` 在每次路由跳转时覆写 |

**`<head>` 内没有**：`<link rel="icon">`（favicon）、`<link rel="preconnect">`/`dns-prefetch`、任何外部样式表、任何内联 `<style>`、任何 CSP/`X-Frame-Options` 类 meta。

### 4.3 `<body>`（`:8-11`）
| 行 | 元素 | 说明 |
|---|---|---|
| `:9` | `<div id="app"></div>` | Vue 挂载点。必须与 `admin/src/main.ts:82` 的 `app.mount('#app')` 严格同名，改一处即白屏 |
| `:10` | `<script type="module" src="/src/main.ts"></script>` | 源码入口。`type="module"` 使其按 ESM 加载（dev 下由 Vite 直接服务 `.ts`，无需预编译）；路径以 `/` 开头，与 `admin/vite.config.ts` 未设 `base`（默认 `'/'`）一致 |

`:9` 与 `:10` 的顺序意味着脚本执行时挂载点已存在于 DOM；且 ESM 默认 `defer` 语义，不会阻塞解析。

### 4.4 构建期与运行期的形态变化
- **dev**：Vite 直接提供本文件，并把 `:10` 的 `/src/main.ts` 重写为带 `@vite/client` 注入的形式，实现 HMR。
- **build**：`vite build` 以本文件为入口，产出 `admin/dist/index.html`——`:10` 被替换为 `/assets/index-<hash>.js`（及 CSS `<link>`），`:9` 的挂载点原样保留。产物随后被 `admin/scripts/zip-dist.mjs` 压进 `admin/dist.zip`，zip 根目录即 `index.html` 与 `assets/`（`admin/scripts/zip-dist.mjs:5` 注释）。
- **生产**：nginx 提供该静态 `index.html`；因路由为 HTML5 history 模式（`admin/src/router/index.ts:98` 的 `createWebHistory()`），nginx 必须配 SPA 回退（`try_files ... /index.html`），否则深层路由刷新 404——已记为 `.qoder/ARCHITECTURE.md` §16「待确认清单」第 1 项，nginx 配置不在仓库内。

## 5. 输入与输出
- **输入（本文件消费的外部内容）**：无。不引用任何外部 URL、CDN、字体、图标或脚本；全部资源经 `:10` 的入口沿 import 链由 Vite 打包。
- **输出**
  - dev：作为 `http://<host>:5173/` 的响应体（含 Vite 注入的 HMR 客户端）。
  - build：`admin/dist/index.html`（资源引用被替换为哈希文件名）。
- **对下游的契约**
  - 挂载点 id `app` → `admin/src/main.ts:82`。
  - 入口路径 `/src/main.ts` → 该文件必须存在且为默认无导出的副作用模块（`admin/src/main.ts:76-82` 完成 createApp、图标注册、Element Plus 装配、路由装载与 mount）。
  - 资源前缀 `/` → `admin/vite.config.ts` 的 `base`（默认 `'/'`）与 nginx 站点根路径。
- **异常形态**：`:9` 的 id 与 `mount()` 不一致 → 控制台报 "Target container is not a DOM element" 并白屏；`:10` 路径写错 → dev 下 404、build 时 Vite 报入口不存在。

## 6. 依赖关系
**被谁读取、读取时机**
| 读取方 | 时机 |
|---|---|
| `vite`（dev / build / preview） | Vite 约定以项目根的 `index.html` 为入口，无需在 `admin/vite.config.ts` 中显式声明；dev 每次请求 `/` 时、build 启动时 |
| 浏览器 | dev 下访问 5173；生产下由 nginx 返回 `dist/index.html` |
| `admin/scripts/zip-dist.mjs` | 递归收集 `admin/dist/` 全部文件（`:47-55`）时间接包含产物版 `index.html`，不解析其内容 |

**依赖的文件**
| 文件 | 关系 |
|---|---|
| `admin/src/main.ts` | `:10` 直接引用的入口；`:82` 反向依赖 `:9` 的 `#app` |
| `admin/src/App.vue` | 经 `main.ts:36` 引入的根组件，渲染进 `#app` |
| `admin/src/router/index.ts` | `:98` 的 `createWebHistory()` 决定生产需 SPA 回退；`:103` 覆写 `:6` 的静态标题 |
| `admin/src/style.css` | 经 `main.ts:39` 引入的全局样式，构建后以 `<link>` 形式注入产物 HTML |
| `admin/vite.config.ts` | `base` 默认 `'/'` 与 `:10` 的绝对路径一致；未配 `build.rollupOptions.input`，故入口完全依赖本文件的约定位置 |
| `admin/package.json:9` | `build` 的 `vite build --mode prod` 以本文件为入口 |

**无关联**：不被任何 tsconfig 的 `include` 覆盖（`admin/tsconfig.app.json:19` 只含 `src/**`，`admin/tsconfig.node.json:14` 只含 `vite.config.ts`），故 HTML 内的路径拼写错误**不受类型检查**，只在构建/运行时暴露。

## 7. 业务规则
无——本文件不含积分、权限、状态流转等业务规则。它承载的**工程约定**：

1. **单页应用只有一个 HTML**：所有路由（`/login`、`/rankings`、驾驶舱、数据大屏等）共用本文件产出的 `index.html`，页面切换不重新请求 HTML。因此**服务器侧必须对未知路径回退到 `index.html`**，否则刷新即 404。
2. **标题以路由为准**：`:6` 的静态标题只是首屏占位，真实标题由路由守卫按 `meta.title` 动态设置；两处文案风格需保持一致（均为「<页面名> · 长征运动挑战」）。
3. **零外部资源**：不引任何 CDN，保证内网/离线部署可用。

## 8. 修改约束
- **`:9` 的 `id="app"` 与 `admin/src/main.ts:82` 的 `mount('#app')` 必须同步改**：单侧修改直接白屏，且无类型检查兜底。
- **`:10` 的 `src` 必须是 `/src/main.ts`（以 `/` 开头的绝对路径）**：这是 Vite 的入口约定。改成相对路径在 dev 下可能仍工作、build 后路径会错。
- **不得引入外部 CDN（字体、图标、JS、CSS）**：会破坏内网/离线部署可用性，且与 `admin/src/main.ts:2-34` 的 `@element-plus/icons-vue` 本地图标方案、`admin/src/plugins/element-plus.ts` 的按需本地样式方案冲突。图标需求一律走 `@element-plus/icons-vue`（已在 `admin/package.json:14`），并在 `main.ts` 的 `icons` 对象中登记（否则模板里的字符串图标引用会解析不到）。
- **若将来把站点部署到子路径**：必须同时改 ① 本文件 `:10` 的资源前缀、② `admin/vite.config.ts` 的 `base`、③ `admin/src/router/index.ts:98` 的 `createWebHistory(base)`、④ nginx `location` 与 SPA 回退——四处缺一即出现资源 404 或路由 404。
- **`:4` 的 charset 必须留在 `<head>` 首位**：后移可能触发浏览器预扫描猜测编码，导致中文乱码。
- **加 favicon 时注意产物与打包**：需在 `<head>` 增 `<link rel="icon">` 并把图标文件放进 `admin/public/`（当前**不存在** `admin/public/` 目录）；否则该文件不会进入 `admin/dist/`，也就不会进 `dist.zip`。
- **不要在本文件写内联业务脚本**：会绕过 TypeScript 检查与打包，与 `admin/tsconfig.app.json:19` 的覆盖范围脱节。

## 9. 当前实现状态

**已实现**
- SPA 入口完整可用：挂载点、ESM 入口、字符集、视口、语言、静态标题齐备。
- **未引入任何外部字体/图标 CDN、无 `<link>` 外部资源、无内联 `<style>`**（实测本文件 12 行全部内容为 §4 所列），因此不存在离线部署被外网阻塞的风险；图标全部来自本地依赖 `@element-plus/icons-vue`（`admin/src/main.ts:2-34`）。
- 自 `4a26520` 起未被修改，与 `admin/src/main.ts` 的挂载约定、`admin/vite.config.ts` 的 `base` 默认值保持一致。

**已知问题 / 风险（事实性陈述）**
1. **无 favicon 声明**：`<head>` 中没有 `<link rel="icon">`，且 `admin/` 下不存在 `public/` 目录。浏览器会自行请求 `/favicon.ico`，dev 下由 Vite 返回 404、生产下由 nginx 返回 404（若未配 SPA 回退，甚至可能回退成 `index.html` 的 HTML 内容被当作图标解析）。仅影响控制台噪声与浏览器标签页图标，不影响功能。
2. **生产 SPA 回退未在仓库内验证**：`createWebHistory()`（`admin/src/router/index.ts:98`）+ nginx 配置不在仓库内 → 深层路由（如 `/rankings`）直接刷新是否 404 **待确认**，已记为 `.qoder/ARCHITECTURE.md` §16「待确认清单」第 1 项。首页 `/` 与站内跳转正常，故日常验收发现不了。
3. **`:6` 的静态标题与 `:103` 的动态标题存在双写**：两处都含「长征运动挑战」字样，改品牌名时需同步两处（本文件 + `admin/src/router/index.ts:103`），属轻度重复。
4. **本文件不受任何类型检查或校验工具覆盖**：路径拼写错误只能在构建/运行时发现。
5. **无 `<meta name="description">`、无 `og:*`**：内部系统，无 SEO/分享需求，属合理省略，此处仅记录事实。
6. **无 CSP meta**：安全响应头依赖 nginx 侧配置（不在仓库内），是否需要——**待确认**。

**待确认**
- 生产 nginx 是否已配 `try_files ... /index.html` 的 SPA 回退（配置文件不在仓库内、服务器路径未核实，见 `.qoder/ARCHITECTURE.md` §12、§16）。
- 构建产物 `admin/dist/index.html` 中资源引用的实际形态（本次建档**未执行** `npm run build`，按任务约束不验证）。

## 10. 迭代记录
数据来源：`git log --follow -- admin/index.html`（1 个提交）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-09-30
- 需求：搭建管理后台工程骨架，提供 Vue 3 + Vite SPA 的 HTML 入口。
- 修改内容：`4a26520` 创建本文件（12 行）：`lang="zh-CN"`、UTF-8 字符集、viewport、标题「长征运动挑战 · 管理后台」、挂载点 `<div id="app">`、ESM 入口 `/src/main.ts`。同提交创建 `admin/package.json`、`admin/vite.config.ts`、`admin/tsconfig.json`、`admin/tsconfig.app.json`、`admin/tsconfig.node.json` 与管理后台基础页面。
- 关联文件：`admin/src/main.ts`、`admin/src/App.vue`、`admin/package.json`、`admin/vite.config.ts`、`admin/tsconfig*.json`。
- 测试结果：待确认（`docs/迭代记录.md` 的 `4a26520` 条目只有标题「管理后台基础页面及依赖配置」，未记录内容与验证字段）。

> **本文件自创建起从未被修改**。与之相关的外部变更：`82af32c`（2026-10-01）引入 WebSocket 实时推送、`01ec93c`（2026-10-02）引入 ECharts 与新页面、`79cf738`（2026-10-14）引入 `dist.zip` 打包、`761d860`（2026-10-16）改构建 mode——四次均**未触及本文件**，说明入口 HTML 的契约稳定；变化都发生在 `:10` 之后的 import 链与构建/部署环节。
