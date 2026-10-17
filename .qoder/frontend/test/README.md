# frontend/test · 小程序测试体系总览

> 最后核对时间：2026-10-17（对应 HEAD `031c323`）
>
> 按 `.qoder/README.md` §4 的排除规则，**测试脚本不逐个建档**，本文档作为该目录的唯一说明。

---

## 1. 三种测试形态

| 形态 | 位置 | 工具 | 说明 |
|---|---|---|---|
| **自动化 UI 回归** | `frontend/test/automator/*.cjs` | `miniprogram-automator` ^0.12.1（唯一依赖，`package.json` `"type": "commonjs"`） | 通过微信开发者工具的自动化端口 **9420**（`ws://127.0.0.1:9420`）驱动真机模拟器 |
| **静态检查脚本** | `frontend/test/*.cjs` | 纯 Node | `wxml-balance-check.cjs`（WXML 标签配平）、`auth-flow-check.cjs`（鉴权链路静态核查）、`ws-idle-check.cjs`（WS 空闲关闭逻辑核查） |
| **人工验收 + 截图** | `frontend/test/images/*.png` | 开发者工具手工操作 | 报告在 `frontend/test/docs/*.md`（33 份） |

**无单元测试框架**（无 jest/mocha/vitest）。项目对小程序 JS 的最低验证是 **`node --check <文件>`** 语法检查。

---

## 2. 主套件 `ui-test.cjs`：分阶段 + 硬超时

这是本目录最核心、也最「工程化」的脚本（`frontend/test/automator/ui-test.cjs`）。它的设计全部来自实测踩坑，**修改前必须读完它的头部注释（`:1-23`）**。

### 2.1 五个阶段

| 命令 | 覆盖范围 | 看门狗超时 |
|---|---|---|
| `node ui-test.cjs 1` | 登录 + 组织选择 + 首页运动 | 300000 ms |
| `node ui-test.cjs 2` | 长征路线 + 节点详情 | 160000 ms |
| `node ui-test.cjs 3` | 每日答题（满分 / 重置 / 零分） | 280000 ms |
| `node ui-test.cjs 4` | 排行榜 + 我的 + 记录页 + 勋章 | 220000 ms |
| `node ui-test.cjs 5` | 修改组织 + 退出登录 + 未登录深链守卫验证 | 240000 ms |
| `node ui-test.cjs merge` | 汇总 `results-p*.json` → `results.json` | — |

看门狗定义在 `:855`；超时后**强制落盘 `results-pN.json`（带 `hung` 标记）再退出**（`:857-859`），便于外层重试。

### 2.2 四层防挂死机制（不可删）

长会话自动化会阻塞 IDE 自动化桥，且**被阻塞的命令既不返回也不 reject**。为此：

1. **每条 automator 命令套 20 秒硬超时** —— `CMD_TIMEOUT = 20000`（`:48`），`withTimeout(fn(), CMD_TIMEOUT, desc)`（`:126`）
2. **每阶段全局看门狗** —— `:855-859`
3. **刻意吞掉 `unhandledRejection`** —— `:29-32`。原因写在 `:28-29`：`cmd()` 的 20s 超时**先于 automator 内部 30s 协议超时**触发时，原始 promise 变成孤儿；若不接管，Node 会在协议超时回报时**直接崩掉整个进程（实测发生）**
4. **外层 `run-all.sh` 的 IDE 重启（`rearm`）** —— 见 §2.4

### 2.3 `wx.login` 打桩的原因（易被误认为是「假测试」）

`:18-20` 与 `:77` 说明：**IDE 未登录微信账号时真实 `wx.login` 报 41002（appid missing）**。因此用 `mini.mockWxMethod('login', { code: loginCode })`（`:97`）固定 code，而后端未配微信凭证时**由 code 派生 mock openid，仍走完整真实后端登录链路**。

同理 `mockWxMethod('showModal', {confirm: true, cancel: false})`（`:581`、`:622`、`:758`）用于自动确认弹窗。

`:92` 另记录了一个坑：**mockWxMethod 返回成功但 doLogin 时仍走真实 wx.login 报 41002** 的情况。

**数据环境是全真实的**（`:16-17`）：登录/运动/路线/答题/排行/组织/勋章/积分**全部走真实后端**（`services/*.js` → `request.js` → FastAPI），前端无本地业务数据生成。

### 2.4 阶段间依赖与可重跑性

`:21-23` 明确：

- **阶段 1 完成登录与运动数据**（storage 在 IDE 会话间持久），后续阶段复用登录态
- **同一套件运行内各阶段共用同一 code = 同一测试用户**；**阶段 1 强制换新用户**（`ensureLoginCode(phase === '1')`，`:871`）
- 各阶段**可安全重跑**：阶段 1 先清 storage；阶段 3 先重置今日答题；阶段 5 缺登录态时自动重登

### 2.5 硬编码答案表（与种子数据强耦合）

`:42-46` `ANSWERS` 是**后端题库 15 题（与 `backend/app/data/seed.py` 种子一致）的 id → 正确答案映射**，注释说明「判分在服务端」。

⚠ **修改 `backend/app/data/seed.py` 的 `QUESTION_BANK` 答案时必须同步这张表**，否则阶段 3 的满分/零分用例会静默失准。

### 2.6 `run-all.sh`：外层重试与 IDE 重启

`frontend/test/automator/run-all.sh`（44 行）：

```bash
CLI="/d/Program Files (x86)/Tencent/微信web开发者工具/cli.bat"
PROJECT="D:/project/longmarch-run"     # 注意：指向仓库根，不是 frontend/
```

- **`rearm()`（`:7-15`）**：`cli quit` → `sleep 6` → `cli auto --project "$PROJECT" --auto-port 9420` → **`sleep 45`**。理由写在 `:9-10`：**长会话后 IDE 自动化服务会崩（Connection closed / not on top），仅 `cli auto` 无法恢复，必须整体重启 IDE 再开自动化端口**
- **`phase_ok()`（`:17-24`）**：用 Node 读 `results-p<N>.json`，校验 `!r.hung && Array.isArray(r.results) && r.results.length > 0`
- **主循环（`:30-41`）**：每阶段最多 **3 次尝试**，失败后 `rearm` 重试；全部失败打印 `PHASE N gave up` 但**不中断后续阶段**
- 起始先 `node --check ui-test.cjs || exit 1`，并清理上一轮产物（`:26-27`）

`PROJECT` 指向仓库根而非 `frontend/`，是因为 `project.config.json:56` 用 `miniprogramRoot: "frontend/"` 间接指向源码目录。**用支付宝小程序开发者工具打开会报 CE1000.01 找不到 axml**（见项目记忆 `ce1000-01-axml`）。

---

## 3. 专项自动化脚本清单

### 3.1 场景/版本专项（`.cjs`）

| 脚本 | 覆盖场景 | 结果 JSON | 报告 |
|---|---|---|---|
| `v1-auto-login.cjs` | V1.0 启动页自动登录与 401 静默重登 | `results-v1-auto-login.json` | — |
| `v12-mine-quiz.cjs` | V1.2 我的页 + 答题 | `results-v12.json` | `docs/v12-mine-quiz-report.md` |
| `v2-miniprogram.cjs` | V2.0 小程序端（限时答题、积分排行、荣誉卡、活动状态页、组织锁定） | `results-v2.json`、`results-v2-run1.json` | `docs/v2-miniprogram-report.md` |
| `v2-quiz-modes.cjs` | 「情报2 · 交卷看解析」答题交互模式切换 | `results-v2-quiz-modes.json` | `docs/v2-quiz-modes-report.md` |
| `s5-pages.cjs` | S5 页面巡检（首页/足迹/日历/答题/勋章/节点详情/长征/我的） | `results-s5.json` | `docs/s5-pages-report.md` |
| `s11-werun-sync.cjs` | S11 微信运动同步（前端侧） | `s11-werun-sync-results.json` | `docs/s11-werun-sync-frontend-report.md` |
| `s16-review-smoke.cjs` | S16 小程序代码审查修复回归 | `results-s16.json` | `docs/s16-miniprogram-review-fixes-report.md` |
| `identity-ui-test.cjs` | 身份绑定与扫码确认页 | `results-identity.json` | `docs/identity-bind-account-report.md` |
| `nickname-test.cjs` | 昵称一次性改名 | `results-nickname.json` | `docs/nickname-change-test-report.md` |
| `onboard-org-echo.cjs` | 首次入驻后「我的」页组织回显（`43898a2`） | — | `docs/onboard-org-echo-report.md` |
| `calendar-detail-layout.cjs` | 行军日历详情弹层长文本换行掉行（`b5aa5d2`） | `results-calendar-layout.json` | `docs/calendar-detail-layout-report.md` |
| `tabbar-starmap.cjs` | tabBar 图标 + 星空地图分层闪烁（`50aef7d`） | `results-tabbar-starmap.json` | `docs/tabbar-starmap-report.md` |
| `ai-tab-swap.cjs` | 底部情报 tab 换防为 AI 问答（`0052108`） | — | `docs/ai-tab-swap-report.md` |
| `ai-chat-render.cjs` | AI 聊天页渲染 | — | `docs/ai-chat-page-report.md` |
| `ai-chat-live.cjs` | AI 聊天页**真实 Agent** 联调 | — | 同上 |
| `smoke-cleanup.cjs` | 清理冒烟（死代码移除后回归） | — | `docs/s7-cleanup-smoke-report.md` |

### 3.2 高级化升级批次（P 系列）

| 脚本 | 对应需求 | 结果 JSON | 报告 |
|---|---|---|---|
| `p0-home.cjs` | P0-2 首页今日行军卡状态分档 | `results-p0h.json` | `docs/p0-home-today-report.md` |
| `p0-march.cjs` | P0-1 行军轨迹 | `results-p0m.json` | `docs/p0-march-trajectory-report.md` |
| `p0-chapters.cjs` | P0-3 长征章节系统 | `results-p0ch.json` | `docs/p0-chapters-report.md` |
| `p0-opening.cjs` | P0-4 长征旅程开场动画 | `results-p0o.json` | `docs/p0-opening-report.md` |
| `p1-activities.cjs` | P1-1 实时行军动态 | `results-p1.json` | `docs/p1-activities-report.md` |
| `p1-companions.cjs` | P1-2 同组织同行者 | `results-p1r.json` | `docs/p1-companions-report.md` |
| `p1-org-march.cjs` | P1-3 组织共同长征目标 | `results-p1g.json` | `docs/p1-org-march-report.md` |
| `p1-global-goal.cjs` | P1-4 全员共同长征目标 | `results-p1h.json` | `docs/p1-global-goal-report.md` |
| `p1-starry-march.cjs` | P1-5 星空长征模式升级 | `results-p1i.json` | `docs/p1-starry-march-report.md` |
| `p1-footprint-map.cjs` | P1-6 我的长征足迹地图 | `results-p1f.json` | `docs/p1-footprint-map-report.md` |
| `p1-achievements.cjs` | P1-7 成就总览与数据画像 | `results-p1j.json` | `docs/p1-achievements-report.md` |
| `p1-persons-quiz.cjs` | P1-8 人物志与答题连胜 | `results-p1p.json` | `docs/p1-persons-quiz-report.md` |
| `p2-quote-ticket.cjs` | P2-1 每日寄语与节点纪念票 | `results-p2.json` | `docs/p2-quote-ticket-report.md` |
| `p2-theme-ceremony.cjs` | P2-2 区域氛围与完成仪式 | `results-p2b.json`、`results-p2d.json` | `docs/p2-theme-ceremony-report.md` |

### 3.3 截图脚本（只出图，不做断言）

`shots-tour.cjs`（全站巡检）、`s5-shots.cjs`、`p0-shots.cjs`、`shots-login.cjs`、`shots-nickname.cjs`、`shots-orgselect.cjs`、`shots-realname-hint.cjs`、`identity-shots.cjs`、`shot-chapter-ceremony.cjs`、`shot-ticket.cjs`、`route-badge-shot.cjs` / `route-badge-shot2.cjs`、`tab-swap-shots.cjs`、`tabbar-starmap-shots.cjs`、`v2-quiz-modes-shots.cjs`、`ai-chat-shots.cjs`

**`shots-tour.cjs` 与 `ui-test.cjs` 分离的理由**：巡检截图会大量占用自动化桥，与断言型用例混跑会显著提高挂死概率；分开跑可以让断言套件保持较短会话。

### 3.4 T16a 复现脚本（**环境性失败，非产品缺陷**）

`e2e-repro-t16a-timing.cjs`、`e2e-repro-t16a-wrap.cjs`、`e2e-manual-t11t13.cjs` 及 6 份 `results-repro-t16a*.json`（`-direct`、`-direct-relaunch`、`-quiet`、`-timing`、`-wrap`、无后缀）。

这组脚本是为定位一个 automator 时序问题而做的**多变体对照实验**。结论是**环境性失败**，不代表产品缺陷。**不要拿 T16a 的失败当回归信号。**

### 3.5 探针脚本（`probe-*.cjs`）

`probe-login.cjs`、`probe-wxlogin.cjs`、`probe-defer.tmp.cjs`、`probe-hook3.tmp.cjs`、`probe-hook4.tmp.cjs`

用于定位 41002 / mockWxMethod 失效等问题的一次性探针。⚠ **三个 `*.tmp.cjs` 已被 git 跟踪入库**（`git ls-files` 可证），属应清理的临时产物。

### 3.6 工具脚本

| 脚本 | 用途 |
|---|---|
| `frontend/test/gen-tabbar-icons.cjs` | **零依赖生成 tabBar PNG 图标**（不引入 canvas/sharp 等 npm 包） |

---

## 4. 数据与产物

| 文件 | 是否入库 | 说明 |
|---|---|---|
| `frontend/test/token.txt` | ❌ `.gitignore:46` | **含真实令牌，严禁入库** |
| `frontend/test/*.json`（`login_probe.json`、`nodes.json`、`v12-fixture.json`、`auth-flow-results.json`） | ❌ `.gitignore:47` | 运行期产物 |
| `frontend/test/automator/results*.json`（40+ 份） | ❌ `.gitignore:48` | 运行期产物 |
| `frontend/test/automator/state.json` | ❌ `.gitignore:49` | 跨阶段登录态（含 code） |
| `frontend/test/automator/console-log.json` | ❌ `.gitignore:50` | 控制台抓取 |
| `frontend/test/automator/*.log`（20+ 份） | ❌ `.gitignore:43` `*.log` | 运行日志 |
| `frontend/test/automator/fixtures-identity.json` | ✅ 入库 | 身份绑定夹具（配合 `backend/test/fixtures_identity_bind.py`） |
| `frontend/test/automator/package.json` / `package-lock.json` | ✅ 入库 | 唯一依赖 `miniprogram-automator` |
| `frontend/test/docs/*.md`（33 份） | ✅ 入库 | 测试报告 |
| `frontend/test/images/*.png`（100+ 份） | ✅ 入库 | 验收截图证据 |
| `frontend/test/*.cjs`（静态检查） | ✅ 入库 | — |

`.gitignore:44` 的注释即为此块的理由：**「测试运行临时产物（含令牌等敏感数据，禁止入库）」**。

---

## 5. 执行约定

### 5.1 前置条件

1. **后端已运行**：`ui-test.cjs:15` 明确「前置：后端 `http://127.0.0.1:8010` 已运行」。但注意 `frontend/services/config.js` 在开发版（开发者工具/真机调试）由 `DEV_TARGET` 常量决定后端地址，当前为 `'remote'`（指向 `https://swkjdj.sz-watech.com/api`），**跑本地后端前必须先把 `DEV_TARGET` 改为 `'local'`**，否则测试打的是生产环境；体验版/正式版不受该常量影响，恒连远程。
2. **开发者工具已开自动化端口 9420**。
3. `cd frontend/test/automator && npm install`（首次）。
4. **必须用微信开发者工具**，不能用支付宝小程序工具（CE1000.01）。

### 5.2 命令

```bash
cd frontend/test/automator

# 全量五阶段 + 自动重启重试
bash run-all.sh

# 单阶段
node ui-test.cjs 1
node ui-test.cjs merge

# 专项
node v2-miniprogram.cjs
node ai-chat-render.cjs
```

### 5.3 已知坑（务必先读）

参见项目记忆 `automator-test-protocol`，要点：

1. **IDE 自动化桥长会话必崩**，仅 `cli auto` 无法恢复 → 必须 `rearm()` 整体重启 IDE，且 `sleep 45` 等端口就绪（时间短了会连不上）。
2. **`unhandledRejection` 必须吞掉**，否则孤儿 promise 在 30s 协议超时回报时崩掉整个 Node 进程。
3. **20s 硬超时 < automator 内部 30s 协议超时** 是刻意设计，改大 `CMD_TIMEOUT` 会破坏这层保护。
4. **`ui-test.cjs` phase1 的 T02 断言已过时**，失败不代表回归。
5. **T16a 系列是环境性失败**。
6. **真机调试报 `tunneling socket ECONNREFUSED`** 时，IDE 静态检查器返回「无法检测代码问题」是**假阴性**，不可采信（项目记忆 `ide-tunneling-socket-econnrefused`）。
7. **`run-all.sh` 的 `CLI` 与 `PROJECT` 是本机绝对路径硬编码**，换机器必须改。
8. **`ANSWERS` 表与后端种子强耦合**，改题库答案必须同步。

---

## 6. 与其它测试体系的关系

| 体系 | 位置 | 说明 |
|---|---|---|
| 后端冒烟 | `backend/test/` | 见 `.qoder/backend/test/README.md` |
| 管理后台人工验收 | `admin/test/` | 见 `.qoder/admin/test/README.md` |
| 提交级验证记录 | `docs/迭代记录.md` 每条的「验证」字段 | **权威** |

编号在三端共享：如 S11 同时有 `backend/test/docs/s11-werun-sync-report.md` 与 `frontend/test/docs/s11-werun-sync-frontend-report.md`；S16 有 `admin/test/docs/s16-admin-review-fixes-report.md` 与 `frontend/test/docs/s16-miniprogram-review-fixes-report.md`。

---

## 7. 本目录的待清理项

| 项 | 说明 |
|---|---|
| `probe-defer.tmp.cjs`、`probe-hook3.tmp.cjs`、`probe-hook4.tmp.cjs` | 一次性探针脚本，**已入库**，建议清理或移入 gitignore |
| `frontend/images/tabbar/quiz.png` / `quiz-active.png`（源码目录，非 test） | `0052108` 换防后**未被 `app.json` 引用**，属遗留资源 |
| `ui-test.cjs` phase1 T02 | 断言过时，待更新或移除 |
| T16a 复现脚本群 | 问题已定性为环境性，脚本可归档 |
| `docs/miniprogram-test-report.md` | 早期总报告，可能滞后于当前 25 页结构，引用前需核对 |
