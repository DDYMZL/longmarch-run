# admin/test · 管理后台测试体系总览

> 最后核对时间：2026-10-17（对应 HEAD `031c323`）
>
> 按 `.qoder/README.md` §4 的排除规则，测试资产不逐个建档，本文档作为该目录的唯一说明。

---

## 1. 体系形态：**无自动化测试框架，靠「构建 + 类型检查 + 浏览器人工验收」**

`admin/test/` 下**只有 `docs/` 与 `images/` 两个子目录，没有任何测试脚本**。这不是遗漏，而是本项目的既定验收方式。

| 验证层 | 手段 | 依据 |
|---|---|---|
| **类型检查** | `vue-tsc --noEmit -p tsconfig.app.json` | `admin/package.json` 的 `build` 脚本第一步 |
| **构建验证** | `vite build --mode prod` | 同上第二步 |
| **产物打包** | `node scripts/zip-dist.mjs` | 同上第三步 |
| **浏览器验收** | 起 dev server（5173）+ 后端（8010），在真实浏览器里逐条走验收项并**截图留证** | `admin/test/docs/*.md` + `admin/test/images/*.png` |

**未引入**：vitest / jest / cypress / playwright（`package.json` 无相关依赖，也无 `test` 脚本）。**无 ESLint / Prettier 配置。**

因此仓库根 `agents.md` §1.3 对 admin 的验证要求是「`npm run build` 与浏览器验收」，两者都必须做。

### 1.1 `npm run build` 是唯一的自动化门禁

```jsonc
// admin/package.json
{
  "dev":      "vite",
  "dev:prod": "vite --mode prod",
  "build":    "vue-tsc --noEmit -p tsconfig.app.json && vite build --mode prod && node scripts/zip-dist.mjs",
  "zip":      "node scripts/zip-dist.mjs",
  "preview":  "vite preview"
}
```

`build` 用 `&&` 串联三步，**`vue-tsc` 报任何类型错误都会中断构建**。多份报告以此为通过证据，例如 `docs/v2-admin-report.md` 的「构建：`npm run build` ✓（vue-tsc 无类型错误，vite 产出 dist）」。

⚠ 这意味着 `build` 同时承担「类型检查」与「产出发布包」两个职责 —— **本地只想验类型时也会顺带生成 `dist/` 与 `dist.zip`**（两者均被 `.gitignore` 排除）。

### 1.2 浏览器验收的驱动方式（不统一，需注意）

报告中记录的环境行显示，验收用的浏览器**因时因地不同**：

| 驱动方式 | 出现于 |
|---|---|
| `Chrome (browser-use)` —— 通过 browser-use MCP 工具驱动 | `docs/s5-org-user-counts-report.md`、`docs/s6-admin-cockpit-screen-report.md`（2026-10-02） |
| `Edge 127.0.0.1 独立源（Playwright 驱动）` | **仅** `docs/s10-rbac-admin-ui-report.md`（2026-10-09） |
| 未注明浏览器，只写「`npm run build` ✓」 | `docs/s19-invite-frontend-report.md`、`docs/v2-admin-report.md` 等 |

**Playwright 从未作为项目依赖入库** —— 它是验收时由 Agent 侧工具临时驱动的。因此**不存在可重复执行的 admin 自动化验收脚本**，每次验收都需要重新人工/Agent 走一遍。这是本项目验收体系最薄弱的一环。

---

## 2. 报告清单（16 份）

编号与后端/小程序**共享同一套场景号**（见 `.qoder/backend/test/README.md` §2）。

> **本节所有 `docs/...` 均指 `admin/test/docs/...`，`images/...` 均指 `admin/test/images/...`。**
> 注意 `backend/test/docs/` 下存在**同名报告**（如 `s5-org-user-counts-report.md`、`nickname-change-test-report.md`），内容不同，不可互相替代。

| 报告 | 场景 | 日期 | 用例编号风格 |
|---|---|---|---|
| `docs/frontend-test-report.md` | 早期三端联调（admin 侧） | — | — |
| `docs/admin-datasync-test-report.md` | 管理端数据同步与 WebSocket 实时刷新验收 | 2026-10-01 | — |
| `docs/org-member-detail-report.md` | 组织架构人员明细查看（`a740973`） | 2026-10-02 | — |
| `docs/s5-org-user-counts-report.md` | S5 组织树直属/含下级人数统计 | 2026-10-02 | — |
| `docs/s6-admin-cockpit-screen-report.md` | S6 管理端驾驶舱与数据大屏 | 2026-10-02 | — |
| `docs/s7-ondemand-perf-report.md` | S7 echarts / Element Plus 按需引入与分页性能 | — | — |
| `docs/nickname-rename-record-report.md` | 昵称一次性改名记录 | — | — |
| `docs/s10-rbac-admin-ui-report.md` | **S10 扫码登录 + 人员授权 + 角色管理 + 审计页**（批次 4） | 2026-10-09 | **A1–A20，20/20 通过** |
| `docs/s15-rankings-server-paging-report.md` | S15 排名洞察服务端分页、筛选与流式导出 | — | — |
| `docs/s16-admin-review-fixes-report.md` | S16 管理后台代码审查修复回归 | — | — |
| `docs/p2-quotes-admin-report.md` | P2-1 每日寄语后台维护页（需求 §16.4） | 2026-10-03 | — |
| `docs/s17-quote-cycle-import-admin-report.md` | S17 寄语按天循环与 Excel 导入（管理端） | — | — |
| `docs/s19-invite-admin-report.md` | S19 邀请码准入（管理端） | 2026-10-12 | — |
| `docs/s19-invite-frontend-report.md` | S19 邀请码准入（前端侧，报告归档在 admin） | 2026-10-12 | — |
| `docs/v2-admin-report.md` | V2.0 管理后台：活动设置、排名积分化、组织调整、审计中文化 | 2026-10-13 | — |
| `docs/s26-ai-question-admin-report.md` | S26 AI 出题对话框（管理端） | 2026-10-16 | — |

**缺口**：`s10`、`s15`、`s16` 三个场景**只有 admin 报告，没有后端脚本**（`backend/test/` 下从未入库对应 `.py`）—— 因为这三个场景本身就是纯管理端 UI 验收。

---

## 3. 截图证据（`admin/test/images/`）

命名约定：`<批次或场景>-<序号>-<语义>.png`。

| 前缀 | 对应报告 | 张数 |
|---|---|---|
| `batch4-*` | `s10-rbac-admin-ui-report.md`（A1–A20 逐条对应） | 13 |
| `orgs-*` | 组织树管理 | 3 |
| `org-members-*` | `org-member-detail-report.md` | 3 |
| `questions-*` | 题库管理 | 5 |
| `quotes-cycle-*` | `s17-quote-cycle-import-admin-report.md` | 6 |
| `p2-*` | `p2-quotes-admin-report.md` | 2 |
| `rankings-*` | `s15-rankings-server-paging-report.md` 等 | 14 |
| `s5-*` | `s5-org-user-counts-report.md` | 2 |
| `s6-*` | `s6-admin-cockpit-screen-report.md` | 4 |
| `s7-*` | `s7-ondemand-perf-report.md` | 5 |
| `s16-*` | `s16-admin-review-fixes-report.md` | 1 |
| `s26-*` | `s26-ai-question-admin-report.md` | 9 |
| `v2-*` | `v2-admin-report.md` | 11 |
| `e2e-*` | `admin-datasync-test-report.md` | 2 |
| `nickname-rename-record.png` | `nickname-rename-record-report.md` | 1 |
| `console-errors.json` | 浏览器控制台错误抓取 | — |

⚠ **`console-errors.json` 未被 `.gitignore` 排除、已入库**。它是控制台错误文本抓取，理论上不含凭据，但**新增同类产物时必须确认不含 token / 密码**。`.gitignore` 的测试产物排除规则目前**只覆盖 `frontend/test/`**，未覆盖 `admin/test/`。

**截图编号存在缺口**：`rankings-08`、`rankings-12` 不存在（从 07 跳到 09、从 11 跳到 13）。属正常的作废/重拍，不影响证据链。

---

## 4. 报告的标准结构

以 `docs/s10-rbac-admin-ui-report.md` 为范例，一份合格的 admin 验收报告包含：

```markdown
# <场景号> <场景名> · 浏览器验收报告

日期：YYYY-MM-DD ｜ 环境：admin dev server (5173) + backend (8010, openGauss) ｜ 浏览器：<驱动方式>

## 范围
<本次验收覆盖哪些页面与路径>

## 改动清单
| 文件 | 改动 |
| --- | --- |
| `src/...` | ... |

## 验收结果（N/M 通过）
| # | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| A1 | ... | ✅ | <截图文件名> |

## 备注
<环境限制、已知问题、驱动方式说明>
```

**「证据」列必须填截图文件名或接口状态码**，不能留空 —— 这是本目录唯一的可追溯性保证。

---

## 5. 执行约定

### 5.1 验收流程

```bash
# 1. 起后端（另开终端）
cd backend && python run.py            # :8010

# 2. 起 admin dev server
cd admin && npm run dev                # :5173，Vite 代理 /api → 后端

# 3. 浏览器打开 http://localhost:5173 逐项验收并截图到 admin/test/images/

# 4. 构建门禁
cd admin && npm run build              # vue-tsc + vite build + zip
```

### 5.2 环境与地址

| 项 | 值 | 依据 |
|---|---|---|
| dev server 端口 | **5173**（`host: true`，支持局域网访问，`18a8848`） | `admin/vite.config.ts:9-10` |
| API 代理 | `/api` → 目标地址，`changeOrigin: true`、**`ws: true`** | `admin/vite.config.ts:11-17` |
| 环境变量 | **只有一个** `VITE_API_PROXY` | `admin/.env.development:3`、`admin/.env.prod:4` |
| 环境切换 | `npm run dev`（development）/ `npm run dev:prod` / `build --mode prod` | `vite.config.ts:5` 用 `loadEnv` |
| 报告中的端口漂移 | 早期报告出现过 **5178**（`docs/org-member-detail-report.md`，2026-10-02，5173 被占用时的自动递增） | — |

⚠ **联调默认指向已部署的远程后端** `https://swkjdj.sz-watech.com`（见项目记忆 `remote-backend-env`）。**做验收前必须确认 `.env.development` 里的 `VITE_API_PROXY` 指向的是本地还是生产** —— 指向生产时的写操作会污染真实数据。

### 5.3 已知坑

1. **无自动化验收脚本可复用**，每次都要重新走一遍浏览器流程。
2. **`npm run build` 会顺带产出 `dist.zip`**，只想验类型时注意别误发布。
3. **`ElResult` 组件被引用但未在 `src/plugins/element-plus.ts` 注册** —— 相关页面渲染异常。这是 `vue-tsc` **不会报**的运行时错误（组件是字符串解析），**必须靠浏览器验收发现**。
4. **403 无专门处理分支**，`api/request.ts` 不消费 `X-Account-Status` / `X-Activity-Status`，权限被撤销时用户只看到通用错误 —— 验收 RBAC 时需注意这一体验缺口。
5. **`admin/test/` 未被 `.gitignore` 的测试产物规则覆盖**，运行期产物需人工确认不入库。
6. `src/pages/` 与 `src/views/` **目录命名不一致**（`RankingsView.vue` 在 `pages/`，来源 `81b86e5`，原因未说明）—— 写报告「改动清单」时路径要核对清楚。

---

## 6. 与其它测试体系的关系

| 体系 | 位置 | 说明 |
|---|---|---|
| 后端冒烟 | `backend/test/` | 见 `.qoder/backend/test/README.md`；S10/S15/S16 **只有 admin 报告** |
| 小程序 automator | `frontend/test/automator/` | 见 `.qoder/frontend/test/README.md` |
| 提交级验证记录 | `docs/迭代记录.md` 每条的「验证」字段 | **权威**，格式为「admin build+浏览器实测」 |

---

## 7. 本目录的待改进项

| 项 | 说明 |
|---|---|
| 无可重复执行的自动化验收 | Playwright 从未入库为依赖，验收依赖人工/Agent 每次重走 |
| `.gitignore` 未覆盖 `admin/test/` 运行期产物 | `console-errors.json` 已入库，需人工把关 |
| 报告结构不统一 | 只有 `s10` 一份完整遵循 §4 的标准结构，其余格式各异（有的只有「范围 + 结果」两段） |
| 无按钮级权限测试 | 权限粒度只到菜单码，验收无法覆盖按钮级越权 |
| `ElResult` 未注册 | 属 `vue-tsc` 盲区，需靠浏览器验收发现，**尚未修复** |
