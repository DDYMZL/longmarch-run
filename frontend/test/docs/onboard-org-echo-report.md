# 入驻后「我的」页组织回显修复 · 测试报告

- 日期：2026-10-12
- 范围：`services/auth.js`、`pages/onboard/onboard.js`、`pages/org-select/org-select.js`

## 问题

首次扫码入驻并选择组织后，进入「我的」页组织栏显示「点击选择组织架构」，未回显所选组织。

## 根因

后端用户结构（`UserOut`）不含组织名称。入驻成功后 `saveServerUser` 把不带组织名称的用户写入 `app.globalData.user`；入驻页随后调用 `auth.updateLocalUser` 补写 `orgName/orgFullName`，但该函数只写 Storage、不同步 `app.globalData.user`，而「我的」页读取的是 `app.globalData.user`。

## 修复

1. `auth.updateLocalUser` 写 Storage 的同时同步 `app.globalData.user`（不改变登录态）；org-select 中重复的手工同步代码删除。
2. 入驻页仅在后端返回的 `orgId` 与所选组织一致时回填组织名称：已入驻身份重复提交时后端保留原组织，避免本地显示与后端不一致的组织。

## 验证

| 用例 | 方法 | 结果 |
| --- | --- | --- |
| 语法检查 | `node --check` 三个改动文件 | 通过 |
| 服务层调用链 | Node 注入假 `wx`/`getApp`，跑 `onboard` → `updateLocalUser` | 修复后 `globalData.user.orgFullName` 正确写入 |
| 首次入驻回显 | `test/automator/onboard-org-echo.cjs`：清空 Storage 与全局态模拟首次进入 → 入驻页提交 → 跳首页 → 切「我的」 | 通过：`.mine-org-text` 显示所选组织全称 |
| 「我的」修改组织回归 | 从「我的」进入 org-select（from=mine）选定组织后返回 | 通过：返回「我的」并显示新组织全称 |

## 已知限制

组织名称仍只是前端缓存字段：换设备或清除缓存后，`/auth/me` 不返回组织名称，「我的」页在用户重新选择组织之前不显示组织名称。如需彻底解决，需要后端在用户结构中下发组织名称。
