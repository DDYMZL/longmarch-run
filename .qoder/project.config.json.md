# project.config.json

## 1. 文件路径

`project.config.json`（66 行，**位于仓库根目录，不在 `frontend/` 下**）

> 本文档按 `.qoder/README.md` §4「敏感配置」行建档：**只记录配置项名称、行号、用途与影响面**。`appid` 属小程序身份标识符，标注为「值不录入文档」；其余非敏感的结构性取值（路径、版本、打包排除项、编译开关状态）为说明影响面所必需，按语义描述。

## 2. 文件职责

**微信开发者工具的项目级配置文件**（工具自动生成 + 人工维护），决定三件事：① 用哪个小程序身份（`appid`）打开、以什么类型编译（`compileType`）、代码根在哪（`miniprogramRoot`）；② 编译与上传时的开关行为（`setting.*`）；③ 哪些文件不进代码包（`packOptions`）。它是「用仓库根目录打开项目即可正确识别 `frontend/` 为小程序代码根」这一约定的载体（`frontend/AGENTS.md` §1 要求用**微信开发者工具打开仓库根目录**）。

## 3. 业务需求

- 仓库为 monorepo（`backend/` + `admin/` + `frontend/` + `docker/`），小程序代码在子目录，故必须显式声明 `miniprogramRoot`（`:56`）；否则工具会把仓库根当代码根，找不到 `app.json`。
- 主包体积需控制在 2M 内，测试目录与开发文档不能进包——`packOptions.ignore`（`:3-19`）即为此而设（`docs/迭代记录.md` 的 `2d6345d` 条目记为「打包配置忽略 test 目录与开发文档，主包体积降至 2M 内」）。

## 4. 核心功能

### 4.1 顶层配置项清单（按文件顺序）

| # | 行号 | 配置项 | 用途与影响面 |
|---|---|---|---|
| 1 | `:2` | `description` | 项目描述文本，仅工具内展示，不影响编译 |
| 2 | `:3-19` | `packOptions` | 打包包含/排除规则，见 §4.2 |
| 3 | `:20-54` | `setting` | 编译与上传开关集合，见 §4.3 |
| 4 | `:55` | `compileType` | 编译类型，值为 `miniprogram`（普通小程序；另一常见值 `plugin` 为插件项目）。改动会导致工具按错误工程类型解析 |
| 5 | `:56` | `miniprogramRoot` | **小程序代码根目录**，值为 `frontend/`。决定 `frontend/app.json`、`frontend/sitemap.json`、`frontend/images/**` 的解析基准，也决定 `packOptions.ignore` 的路径基准（§4.2） |
| 6 | `:57` | `libVersion` | 调试使用的基础库版本，值为 `3.0.0`。影响模拟器可用 API 与真机兼容性判断；与 `frontend/AGENTS.md` §4 第 6 条要求的「离屏画布 try/catch 降级为低版本每帧直绘路径」直接相关——降低此值可复现低版本行为 |
| 7 | `:58` | `appid` | **微信小程序 AppID（敏感标识符，值不录入文档）**。文件中存在有效值。决定登录 `wx.login` 换取 openid 的小程序身份、体验版/正式版归属、以及后端 `WX_APPID` 必须与之一致（后端侧配置项见 `.qoder/backend/.env.md` §4.2 第 6 项） |
| 8 | `:59` | `projectname` | 工具内显示的项目名，值为 `longmarch-run`（与仓库名一致）。仅展示用 |
| 9 | `:60` | `condition` | 编译模式（自定义启动页面/参数）集合，值为空对象 → **未配置任何自定义编译模式**。工具内添加「编译模式」会写入此处 |
| 10 | `:61-64` | `editorSetting` | 工具内置编辑器偏好：`tabIndent`（`:62`，缩进用空格）、`tabSize`（`:63`，2 空格）。与仓库 JS 实际 2 空格缩进一致 |
| 11 | `:65` | `simulatorPluginLibVersion` | 模拟器插件基础库版本映射，空对象 → 未使用插件 |
| 12 | `:66` | `isGameTourist` | 是否小游戏游客模式，值 `false`。本项目为小程序非小游戏 |

### 4.2 `packOptions`（`:3-19`）

- `ignore`（`:4-17`）：3 条排除规则，**路径以 `miniprogramRoot`（即 `frontend/`）为基准**，不是仓库根：
  | 序 | 行 | `type` | `value` | 排除的实际路径 |
  |---|---|---|---|---|
  | 1 | `:5-8` | `folder` | `test` | `frontend/test/`（automator 脚本、测试报告、截图证据） |
  | 2 | `:9-12` | `file` | `design.md` | `frontend/design.md` |
  | 3 | `:13-16` | `file` | `AGENTS.md` | `frontend/AGENTS.md` |
- `include`（`:18`）：空数组 → 无强制包含项。
- **影响面**：这些文件仍存在于仓库与开发者工具的工程视图里（可正常编辑、可被 `frontend/test/automator/` 脚本使用），只是**不打进上传的代码包**，从而压低主包体积。这也是 `.qoder/README.md` §4 把测试脚本/测试报告列为「不建档（集中写入 test/README.md）」之外的另一重隔离。
- **历史坑**：初版（`2d6345d`）写成 `frontend/test`、`frontend/design.md`、`frontend/AGENTS.md`，即以仓库根为基准 —— 该写法**不生效**（路径重复叠加了 `miniprogramRoot`），12 分钟后由 `54c2716` 修正为相对写法（§10）。改这三条时不要「顺手补全前缀」。

### 4.3 `setting`（`:20-54`，共 28 个顶层键 + 1 个嵌套对象）

按作用分组（状态描述为语义化表述）：

**域名与安全校验**
| 键 | 行 | 用途与影响 |
|---|---|---|
| `urlCheck` | `:21` | **关闭**。开发期不校验 `wx.request` 域名是否在小程序后台白名单内。便于本机/局域网直连后端（`frontend/AGENTS.md` §1 的 `DEV_TARGET` 机制）；**代价**：域名白名单缺失问题不会在开发期暴露，需发布前自行核对 |
| `scopeDataCheck` | `:31` | **关闭**。不校验隐私接口权限声明（`scope.*`）与 `app.json` 的 `permission`/`requiredPrivateInfos` 是否匹配。当前 `frontend/app.json` 无这两个键、代码也无定位类接口（见 `.qoder/frontend/app.json.md` §4.5），故关闭无实际风险；若将来启用定位需一并打开 |
| `autoAudits` | `:29` | **关闭**。不自动执行体验评分/审计 |
| `checkInvalidKey` | `:33` | **开启**。校验 WXML/JS 中的无效键名 |
| `checkSiteMap` | `:34` | **开启**。编译时校验 `frontend/sitemap.json`（由 `frontend/app.json:74` 指定）存在且格式合法 |

**编译与转译**
| 键 | 行 | 用途与影响 |
|---|---|---|
| `es6` | `:22` | **开启**。ES6 转 ES5（本项目用 CommonJS，见 `frontend/AGENTS.md` §2「不支持 ESM」，此项主要影响箭头函数/模板串等语法的低版本兼容） |
| `enhance` | `:23` | **开启**。增强编译（支持更多新语法与 `async/await` 转译）。服务层大量使用 Promise/async（如 `frontend/services/activity.js`、`frontend/pages/launch/launch.js:57`），**关闭会导致真机低版本报错** |
| `postcss` | `:24` | **开启**。WXSS 的 PostCSS 处理（补全前缀等） |
| `useCompilerModule` | `:38` | **开启**。使用新版编译器模块 |
| `userConfirmedUseCompilerModuleSwitch` | `:39` | **关闭**（未确认过该开关切换提示） |
| `useCompilerPlugins` | `:47` | **关闭**。未启用编译插件（无 TypeScript/Sass 等预处理，与「无任何构建工具」定位一致，`frontend/AGENTS.md` §1） |
| `compileWorklet` | `:40` | **关闭**。不编译 worklet（无 skyline 动画需求） |
| `disableUseStrict` | `:46` | **关闭**（即保留 `use strict`） |
| `compileHotReLoad` | `:36` | **关闭**。不启用热重载 |
| `babelSetting` | `:49-53` | Babel 细项：`ignore`（`:50`，空）、`disablePlugins`（`:51`，空）、`outputPath`（`:52`，空字符串）→ **全部为默认，无自定义 Babel 配置** |

**npm 与依赖**
| 键 | 行 | 用途与影响 |
|---|---|---|
| `nodeModules` | `:28` | **关闭**。不处理 `node_modules` |
| `packNpmManually` | `:41` | **关闭**。不启用手动 npm 构建 |
| `packNpmRelationList` | `:42` | 空数组 → 无 npm 构建映射。三项共同表明：**小程序侧无 npm 依赖、无「构建 npm」步骤**（`frontend/test/automator/node_modules/` 是测试工具的依赖，不在 `miniprogramRoot` 内，且被 §4.2 的 `test` 目录排除规则一并挡在包外） |
| `localPlugins` | `:45` | **关闭**。无本地插件 |

**上传与调试体验**
| 键 | 行 | 用途与影响 |
|---|---|---|
| `minified` | `:25` | **开启**。上传时压缩 JS |
| `minifyWXSS` | `:43` | **开启**。上传时压缩 WXSS（含 `frontend/app.wxss` 与 25 个页面 wxss） |
| `minifyWXML` | `:44` | **开启**。上传时压缩 WXML |
| `uglifyFileName` | `:32` | **关闭**。不混淆文件名 |
| `uploadWithSourceMap` | `:35` | **开启**。上传时带 SourceMap，便于线上错误定位 |
| `newFeature` | `:26` | **开启**。启用工具新特性 |
| `coverView` | `:27` | **开启**。`cover-view` 组件支持（原生组件上层覆盖） |
| `showShadowRootInWxmlPanel` | `:30` | **开启**。Wxml 面板显示 shadow root，调试用 |
| `condition`（`setting` 内） | `:48` | **关闭**。与顶层 `:60` 的 `condition` 同名但含义不同，此项为编译设置开关 |

## 5. 输入与输出

- 输入：无运行时入参；由微信开发者工具在打开工程时读取。
- 输出：工程的编译/预览/上传行为；`packOptions` 决定最终代码包内容。
- 错误形态：JSON 语法错误 → 工具无法打开工程；`miniprogramRoot` 指向不存在的目录 → 报「找不到 app.json」；`packOptions.ignore` 路径写错 → **静默不生效**（不报错，文件照样进包），是最难发现的一类问题（§4.2 历史坑）。

## 6. 依赖关系

- **被依赖 / 读取方**：微信开发者工具（打开仓库根目录时，`frontend/AGENTS.md` §1）；`frontend/test/automator/` 的自动化脚本通过工具的自动化端口（9420）间接依赖本文件的工程配置（测试体系见 `.qoder/frontend/test/README.md`）。
- **依赖的文件**：`frontend/app.json`（经 `miniprogramRoot`）、`frontend/sitemap.json`（经 `checkSiteMap`）、`frontend/images/tabbar/*.png`（tabBar 图标需进包，**不在** `ignore` 列表中）。
- **同目录的相关配置文件（本文件不引用它们，但存在优先级关系）**：
  - `project.private.config.json` —— **存在**于仓库根，已被 `.gitignore:17` 忽略（`git ls-files` 确认未入库）。它是工具生成的**每个开发者本机私有覆盖层**，字段结构与本文件相同，**同名配置项优先级高于本文件**。按 `.qoder/README.md` §4「本机私有配置」行**明确不建档**，本文档不描述其内容；需要注意的是：本机若在其中改过 `setting.urlCheck`、`libVersion` 等，实际生效值可能与本文档描述不同，排查「我这儿好好的、他那儿不行」类问题时应先比对该私有文件。
  - `mini.project.json` —— **存在**于仓库根，已被 `.gitignore:29` 忽略。支付宝小程序开发者工具的遗留配置（`frontend/AGENTS.md` §1 明确「不要用支付宝开发者工具打开」）。同样**不建档**（`.qoder/README.md` §4）。
- **与后端的隐式契约**：`appid`（`:58`）必须与后端 `WX_APPID` 为同一小程序，否则 `wx.login` 拿到的 code 无法在后端 `code2Session` 换取 openid（后端微信对接见 `.qoder/backend/app/core/wx.py.md`、`backend/AGENTS.md` §2 表「微信对接」行）。
- 不涉及数据库表。

## 7. 业务规则

1. **打开方式**：必须用微信开发者工具打开**仓库根目录**（不是 `frontend/`），由 `miniprogramRoot: "frontend/"`（`:56`）完成根目录映射（`frontend/AGENTS.md` §1）。
2. **`appid` 与后端配置必须成对**：换小程序身份时，本文件 `:58` 与后端 env 的 `WX_APPID`/`WX_SECRET` 要同步更换（§6）。
3. **开发期宽松、发布期严格**：`urlCheck: false`（`:21`）与 `scopeDataCheck: false`（`:31`）都是「开发期放宽校验」的设置，意味着**合法域名白名单与隐私接口声明的正确性不会被工具兜住**，须在微信公众平台后台与发布流程中人工确认（服务器域名与 `envVersion` 判定规则见 `frontend/AGENTS.md` §1）。
4. **无构建链**：`useCompilerPlugins`/`nodeModules`/`packNpmManually` 全部关闭（§4.3），因此不存在 `npm run build` 之类步骤；改完 JS 直接在工具里编译预览。校验方式改为 `node --check` 逐文件语法检查（`frontend/AGENTS.md` §2 表「校验」行、§6 第 4 条）。

## 8. 修改约束

1. **`appid` 值不得写入任何文档、提交信息或日志**（`.qoder/README.md` §3 规则 14、§4「敏感配置」行）；本文档只记录该键存在。
2. **不要改 `miniprogramRoot`**：改动会使 `frontend/app.json`、`packOptions.ignore` 的三条相对路径、以及全部自动化测试脚本的页面路径假设同时失效。
3. **改 `packOptions.ignore` 时路径以 `frontend/` 为基准**，不要加 `frontend/` 前缀（§4.2 历史坑，`54c2716` 就是修这个）。新增排除项后应在工具「详情 → 基本信息」核对代码包体积是否真的下降——写错不报错。
4. **本文件已入库**（`git ls-files` 确认），改动会影响所有开发者；本机个性化偏好应写进 gitignored 的 `project.private.config.json`，不要提交到本文件（根 `agents.md` §1.3 提交前检查）。
5. `libVersion`（`:57`）下调可复现低版本基础库行为，用于验证 `frontend/AGENTS.md` §4 第 6 条要求的离屏画布降级路径；验证完应改回，低版本长期驻留会让工具对新 API 报错。
6. 不要把 `frontend/test/`、`frontend/design.md`、`frontend/AGENTS.md` 从 `ignore` 中移除——会推高主包体积并可能突破 2M 限制（`docs/迭代记录.md` 的 `2d6345d` 条目）。

## 9. 当前实现状态

- **已实现**：工程可被微信开发者工具从仓库根正确打开（`miniprogramRoot` + `compileType` + `appid` 齐备）；打包排除规则生效（路径写法已由 `54c2716` 修正）；sitemap 校验开启；无 npm/插件构建链，与 `frontend/AGENTS.md` §1「无任何构建工具」定位一致。
- **存在问题 / 已知事项**：
  1. `condition`（`:60`）为空对象 → **未配置自定义编译模式**。25 个页面 + 邀请码准入等多入口场景下，每次调试子页都要从 launch 走完登录链路；是否补充编译模式（如直达 `pages/march/march`、带 `?redirect=` 参数的 login）属效率改进，**待确认**。
  2. `urlCheck: false` 长期开启，合法域名白名单问题不会在开发期暴露（§7 第 3 条）。发布前的人工核对清单是否已固化到流程，**待确认**。
  3. `simulatorPluginLibVersion`（`:65`）与 `setting.babelSetting`（`:49-53`）均为空默认值，属工具生成的冗余键，无业务含义。
  4. 本机私有覆盖层 `project.private.config.json` 未入库（§6），因此**本文档描述的是仓库内配置的生效值，不保证等于任一开发者机器上的实际生效值**。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- project.config.json`，共 **3 个提交**。按时间倒序。`54c2716`、`2d6345d` 两项经 `git show` 逐行核实。

### 2026-10-02（`54c2716`，20:05）
- 需求：修正 `packOptions.ignore` 的路径写法（应以 `miniprogramRoot` 为根目录），确保 `test` 目录真被排除。
- 修改内容（`git show` 核实）：`ignore` 三条的 `value` 由 `frontend/test` → `test`（现 `:7`）、`frontend/design.md` → `design.md`（现 `:11`）、`frontend/AGENTS.md` → `AGENTS.md`（现 `:15`）。原写法叠加 `miniprogramRoot: "frontend/"` 后指向不存在的路径，规则**静默失效**。
- 关联文件：无其他文件改动（单文件修复，紧接 12 分钟前的 `2d6345d`）。
- 测试结果：见 `docs/迭代记录.md` 的 `54c2716` 条目。

### 2026-10-02（`2d6345d`，19:53）
- 需求：打包配置忽略 `test` 目录与开发文档，把主包体积降至 2M 内。
- 修改内容（`git show` 核实）：`packOptions.ignore` 由空数组 `[]` 改为 3 条规则（folder `frontend/test`、file `frontend/design.md`、file `frontend/AGENTS.md`；路径写法随后由 `54c2716` 修正）。
- 关联文件：`frontend/test/**`、`frontend/design.md`、`frontend/AGENTS.md`（被排除对象）。
- 测试结果：见 `docs/迭代记录.md` 的 `2d6345d` 条目（提交信息记为「主包体积降至 2M 内」）。

### 2026-09-30（`a94e685`，18:05）
- 需求：项目初始化（`feat: init`）。
- 修改内容（涉本文件）：创建本文件，含 `appid`、`projectname`、`compileType`、`miniprogramRoot`、`libVersion`、默认 `setting.*` 与空 `packOptions`。初始 `setting` 各键的取值未逐行核对（工具默认生成）。
- 关联文件：全仓初始骨架。
- 测试结果：初始提交，无本文件专项验证记录；见 `docs/迭代记录.md` 的 `a94e685` 条目。
