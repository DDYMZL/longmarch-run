# config.js

## 1. 文件路径

`frontend/services/config.js`（44 行）

## 2. 文件职责

小程序后端接口根地址（`API_BASE_URL`）的**唯一集中配置**：按 `wx.getAccountInfoSync().miniProgram.envVersion` 自动判定运行环境，体验版/正式版恒连已部署后端，开发版由 `DEV_TARGET` 常量在「远程已部署后端」与「本机后端（127.0.0.1 / 局域网 IP）」间切换——**发布前无需改动本文件**（`frontend/services/config.js:1-10` 头注释；`frontend/AGENTS.md` §1 同款约定，该文档为技术约定权威出处）。

## 3. 业务需求

- 消除「发布前手改 API 地址」的事故面：`a017284`（2026-10-17）「小程序接口地址按 envVersion 自动判定，发布无需改配置」（`docs/迭代记录.md` 的 `a017284` 条目）。
- 支持本地联调与真机调试：`7908088`（2026-10-01）「API 地址按平台自动切换局域网 IP」、`01f3e05`（2026-10-09）「LAN_IP 从 WSL 虚拟网卡改为物理网卡地址」（`docs/迭代记录.md` 对应条目）。

## 4. 核心功能

### 4.1 配置常量（名称与用途，`:11-16`）

| 常量 | 行号 | 用途 |
|---|---|---|
| `DEV_TARGET` | `:11` | **仅 develop 环境生效**的联调目标开关：`'remote'`（**已提交版本的值**，直连已部署后端，automator 回归也走这条）/ `'local'`（本机后端）。工作区当前有未提交的 `'local'` 改动，见 §9 |
| `REMOTE_ORIGIN` | `:13` | 已部署后端 HTTPS 源站（公网域名，值见源码；须与微信公众平台「request 合法域名」完全一致，`:4-5` 注释） |
| `LAN_IP` | `:15` | 开发电脑局域网 IPv4（物理网卡地址，`01f3e05` 起；值见源码，本文档不复制）。切 `'local'` 真机调试用，电脑换网须同步更新（`:9` 注释） |
| `LOCAL_PORT` | `:16` | 本机后端端口 `8010`（与 `backend/run.py` 默认端口一致，`backend/AGENTS.md` §7） |

### 4.2 `isDevelop()`（`:19-25`）

`envVersion === 'develop'` 判定开发者工具/真机调试；**try/catch 取不到环境信息时返回 `false` 按非开发版处理，保证异常场景仍连远程**（`:18` JSDoc、`:22-24`）。`envVersion` 三态 develop/trial/release 见 `:2-3` 注释。

### 4.3 `resolveBaseUrl()`（`:28-40`）与导出（`:42-44`）

- 非 develop **或** `DEV_TARGET !== 'local'` → 返回 `REMOTE_ORIGIN + '/api'`（`:29-31`）。由此**代码层面保证 trial（体验版）/release（正式版）无视 `DEV_TARGET` 恒连已部署后端**（`:29` 条件短路；头注释 `:4-5`；根 `start.bat:94` 亦明文「trial and release builds ignore DEV_TARGET and always use the deployed backend」）。
- develop + `'local'` → host 默认 `127.0.0.1`；`wx.getSystemInfoSync().platform !== 'devtools'`（真机）时改用 `LAN_IP`（`:32-35`，「真机无法访问电脑回环地址」`:34` 注释）；取平台信息异常时按开发者工具默认地址处理（`:36-38`）。返回 `http://{host}:8010/api`（`:39`）。
- **导出为模块加载时求值的定值**：`module.exports = { API_BASE_URL: resolveBaseUrl() }`（`:42-44`）——require 时刻一次性解析，运行期不随环境变化；因此改 `DEV_TARGET`/`LAN_IP` 后必须**重新编译**才生效（`start.bat:90-91` 提示语同此口径）。

### 4.4 真机 `'local'` 调试的前置条件（`:9-10` 头注释原文口径）

1. 手机与电脑连同一局域网（Wi-Fi）；
2. 开发者工具「详情 → 本地设置」勾选「**不校验合法域名**」——http + 非标端口只有开发版放行；该勾选**仅对开发者工具与开发版生效**，体验/正式版无效（`:4-5`）；
3. 电脑 IP 变化需同步更新 `LAN_IP`。

## 5. 输入与输出

- 无入参；输出唯一：`API_BASE_URL`（string，含 `/api` 前缀）。
- 两种取值形态：`https://<公网域名>/api`（远程）或 `http://<127.0.0.1|LAN_IP>:8010/api`（本地）。
- 无异常抛出（两处 try/catch 全部内部消化，降级方向一律「连远程/连 127.0.0.1」，`:22-24`、`:36-38`）。

## 6. 依赖关系

- 依赖：仅宿主 API `wx.getAccountInfoSync`、`wx.getSystemInfoSync`；不依赖任何其他 service。
- 被依赖（grep `API_BASE_URL|services/config` 全量核实，测试目录除外）：
  - `frontend/services/request.js:1`（解构引入）、`:69`（`url: API_BASE_URL + opts.url`）——全部 REST 请求的最终拼接点；
  - `frontend/services/ws.js:7`（引入）、`:35`（`API_BASE_URL.replace(/^http/, 'ws')` 构造 WS 地址——https→wss、http→ws，随本文件口径自动切换）。
- 外部消费方（非 require）：根 `start.bat:71-94` 用 `findstr` 直接**文本解析**本文件的 `const DEV_TARGET`/`const LAN_IP` 两行（`start.bat:74-75`）并向开发者打印当前小程序联调目标与警告（`:80-94`）。

## 7. 业务规则

1. **环境判定优先级**：`envVersion` 是第一判据，`DEV_TARGET` 只在 develop 下参与判定（`:29`）；任何取环境失败的异常路径都收敛到「连已部署后端」，宁可用远程也不误连不存在的本地（`:18`、`:22-24`）。
2. **automator 回归依赖 `'remote'`**：`start.bat:92` 明文「Keep 'remote' for the automator suites and do not commit 'local'」——小程序自动化测试（`frontend/test/automator/`，见 `.qoder/frontend/test/README.md`）默认直连远程后端，本地不必起服务（`:7` 注释同口径）。
3. 域名必须与公众平台合法域名完全一致，否则真机报「网络异常」（`:4-5` 注释）；本地 http 地址依赖「不校验合法域名」开关（§4.4）。

## 8. 修改约束

1. **禁止把 `DEV_TARGET='local'`、个人 `LAN_IP` 提交入库**（§9；`start.bat:92`）。`LAN_IP` 属本机私有值，改动只在本地工作区保留。
2. `start.bat` 以**行文本匹配**方式解析 `const DEV_TARGET = '...'` / `const LAN_IP = '...'`（`start.bat:74-75`，单引号定界）——重命名常量、改引号风格或挪动书写格式会使启动脚本解析失败（其 `:76-78` 有 WARN 分支兜底）。
3. `API_BASE_URL` 必须含 `/api` 前缀且不带尾斜杠——`request.js:69` 与 `ws.js:35` 均直接字符串拼接。
4. 修改 `REMOTE_ORIGIN` 域名须同步微信公众平台合法域名配置与后端部署（`:4-5`），并核对 `admin/.env.prod` 等其余端的同源配置（跨端影响，根 `.qoder/README.md` §3 规则 5）。
5. 本文件属「配置与部署文件」类：文档只记配置项名称与用途、不复制敏感值（`.qoder/README.md` §5 补充要点）。

## 9. 当前实现状态

- **已实现（以已提交 HEAD 版本为准）**：`DEV_TARGET = 'remote'`（HEAD `git show` 核实 `:11`），即开发者工具/真机调试默认也直连已部署后端；envVersion 自动判定、LAN_IP 真机切换、异常降级均已交付并随 `a017284` 等提交验证（§10）。
- **工作区未提交改动（用户本地调试状态，非项目现状）**：`git diff` 显示工作区 `:11` 被改为 `DEV_TARGET = 'local'`，这是用户正在进行的本机联调开关，**不得提交**（`start.bat:92`「do not commit 'local'」正是针对此场景的警告）。本文档描述的实现状态一律以已提交版本为基准；该未提交改动也**不构成 §10 迭代记录条目**。
- **存在问题 / 已知事项**：
  1. `wx.getSystemInfoSync` 为微信已废弃 API（官方推荐 `wx.getDeviceInfo` 等替代）——本文件仍在使用（`:35`），且有 try/catch 兜底；是否迁移**待确认**（未见需求/任务记录）。
  2. `LAN_IP` 硬编码单机地址，多人开发需各自本地改值且不能提交（`:9` 注释已说明维护方式）；无环境变量注入机制，属已知取舍。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/config.js`，共 **7 个提交**（均指已提交历史；工作区未提交的 `DEV_TARGET='local'` 改动不在其中，见 §9）。均已核对存在于 `docs/迭代记录.md`。按时间倒序。

### 2026-10-17（`a017284`，13:31）
- 需求：发布免改配置。
- 修改内容（涉本文件）：重写为 envVersion 自动判定 + `DEV_TARGET` 联调开关的现行结构（`:1-10` 头注释、`isDevelop`/`resolveBaseUrl`）。
- 关联文件：提交信息载明同批涉及小程序接口地址判定。
- 测试结果：见 `docs/迭代记录.md` 的 `a017284` 条目。

### 2026-10-14（`527db98`，16:25）
- 需求：联调后端地址改 HTTPS 域名。
- 修改内容（涉本文件）：远程地址去掉 8010 端口改走 HTTPS（提交信息「frontend+admin: 联调后端地址改为 HTTPS 域名」）。
- 关联文件：`admin` 端同源配置（同批提交）。
- 测试结果：见 `docs/迭代记录.md` 的 `527db98` 条目。

### 2026-10-14（`1e2d53b`，14:51）
- 需求：联调地址 IP → 域名迁移。
- 修改内容（涉本文件）：远程地址由 IP 改为域名 `swkjdj.sz-watech.com:8010`（提交信息）。
- 关联文件：admin 端（同批提交）。
- 测试结果：见 `docs/迭代记录.md` 的 `1e2d53b` 条目。

### 2026-10-13（`ad1d747`，17:54）
- 需求：联调环境默认切到已部署远程后端。
- 修改内容（涉本文件）：默认目标改为已部署服务器（远程 IP 见提交信息，本文档不复制）。
- 关联文件：admin 端（同批提交）。
- 测试结果：见 `docs/迭代记录.md` 的 `ad1d747` 条目。

### 2026-10-09（`01f3e05`，14:37）
- 需求：真机调试网络失败修复。
- 修改内容（涉本文件）：`LAN_IP` 从 WSL 虚拟网卡地址改为物理网卡地址（提交信息）。
- 关联文件：无（单文件修复）。
- 测试结果：见 `docs/迭代记录.md` 的 `01f3e05` 条目。

### 2026-10-01（`7908088`，16:15）
- 需求：修复真机调试登录失败。
- 修改内容（涉本文件）：API 地址按平台自动切换——devtools 用 127.0.0.1、真机用局域网 IP（提交信息；即现 `resolveBaseUrl` 的 platform 分支雏形）。
- 关联文件：无（单文件修复）。
- 测试结果：见 `docs/迭代记录.md` 的 `7908088` 条目。

### 2026-10-01（`b0fd8b2`，10:31）
- 需求：小程序由本地 Mock 切换为真实后端接口。
- 修改内容（涉本文件）：创建 `config.js` 集中配置 `API_BASE_URL`（`frontend/AGENTS.md` §3 目录表同口径）。
- 关联文件：`frontend/services/request.js` 及全部业务 service。
- 测试结果：见 `docs/迭代记录.md` 的 `b0fd8b2` 条目。
