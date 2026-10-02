# S7 小程序死代码清理 · 回归冒烟报告

日期：2026-10-02 ｜ 脚本：`frontend/test/automator/smoke-cleanup.cjs`（miniprogram-automator，ws://127.0.0.1:9420，轻量探针不重启 IDE）｜ 结果：**7/7 通过**

## 范围

移除前端零引用的死代码，降低包体与维护噪音；不改任何运行时行为。

## 改动

| 文件 | 改动 |
| --- | --- |
| `utils/util.js` | 删除 `recentDates/randomInt/shuffle/seededSteps`（全仓 grep 零引用，Mock 时代遗留）；保留 `pad/formatDate/formatNumber/formatTime` |
| `services/store.js` | 删除 `_cache` 及 `getUserData/saveUserData/clearCache`（后端接管数据后无任何调用方）；保留 `KEY_PREFIX` 与登录迁移 `migrateUserData`（纯 Storage 操作） |
| `app.js` | `logout()` 不再调用已删除的 `store.clearCache()` |
| `services/request.js` | `clearSession()` 不再调用已删除的 `clearCache` |
| `frontend/AGENTS.md` | store.js 职责描述同步（去掉 clearCache 表述） |
| `test/automator/smoke-cleanup.cjs` | 新增：针对删除点的 7 用例轻量回归探针 |

## 用例结果

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| C1 | 登录链路正常（app.js/request.js/store.js 精简后） | ✅ |
| C2 | 选定组织后进入首页 | ✅ pages/home/home |
| C3 | march / quiz / mine 三个 tab 渲染 | ✅ |
| C4 | 登出后 loggedIn=false（logout 无 clearCache 依赖） | ✅ |
| C5 | 全程无「xxx is not a function / is not defined」运行时报错（监听 console，覆盖已删函数被误调的风险） | ✅ |

## 其他验证

- 全仓 grep 确认被删符号零引用：`recentDates|randomInt|seededSteps|getUserData|saveUserData|clearCache` 仅余本报告与探针注释中的说明文字；`shuffle` 仅余 quiz 页面内部自有实现（与 util 无关）。
- 所有改动文件 `node --check` 语法通过。

## 备注

- 探针按既定协议执行：cwd 为 `frontend/test/automator`，不重截图、不重启 IDE，断言与自动化桥状态隔离。
- `migrateUserData` 保留原因：真实后端登录时仍负责把 Mock 时代旧用户 ID 下的 Storage 数据一次性迁移到新 ID（design.md §用户数据无损迁移）。
