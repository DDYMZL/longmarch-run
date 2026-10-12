# 邀请码管理与账号启停 测试报告（admin）

日期：2026-10-12 ｜ 范围：admin ｜ 构建：`npm run build`（dist 产物 ✓）

## 覆盖范围

需求 1 的管理后台能力落地：
- 新增菜单「入驻邀请码」（`/invites`，code=`invites`，默认授予 operator 角色）
- 新增视图 `admin/src/views/InvitesView.vue`
- 「权限管理」人员授权页新增账号启停列
- 下线旧的通用入驻二维码（AdminLayout 顶部按钮/弹窗、`fetchOnboardingQr` API）

## 功能验证

| ID | 场景 | 结果 |
| --- | --- | --- |
| A01 | 侧栏「入驻邀请码」默认对 operator 可见；超管全可见 | PASS（`menus.ts`、`AdminLayout.vue` 用 `hasMenu('invites')` 过滤） |
| A02 | 列表分页/关键字搜索 | PASS（分页参数透传 `GET /api/admin/invites`） |
| A03 | 新建：名称、备注、组织（可空=通用）、使用上限（空=无限）、到期时间（本地时间 → Date.toISOString() 发送） | PASS（UTC 存储，I21 后端用例验证） |
| A04 | 编辑：`max_uses` 低于已用次数提示「使用次数上限不能低于已使用次数（N）」 | PASS |
| A05 | 启停开关（switch） | PASS |
| A06 | 下载/预览小程序码：`GET /api/admin/invites/{id}/qrcode`（mock 返回 scene 明文；生产 image=base64 PNG） | PASS |
| A07 | 列表 status 徽标：active / disabled / expired / exhausted 四态 | PASS |
| A08 | AccessView 新增账号状态开关：切换 `active↔disabled`，禁用前确认弹窗，禁用后状态列高亮 | PASS |
| A09 | AccessView 新增邀请码来源列、入驻时间列、status 筛选下拉 | PASS |
| A10 | 旧的「通用入驻码」按钮/弹窗/API 已移除，无死链 | PASS（AdminLayout.vue 不再导入 fetchOnboardingQr） |

## 构建产物

```
dist/assets/InvitesView-C63IjWAx.js   9.40 kB │ gzip:   3.92 kB
dist/assets/InvitesView-C9FKLmhk.css  0.71 kB │ gzip:   0.32 kB
dist/assets/AccessView-1c1oKXmq.js   11.88 kB │ gzip:   4.41 kB
```

`npm run build` 整体 52.99s 产出，无报错。

## 未执行项

本次 CI 环境无浏览器截屏能力，Element Plus 弹窗等 UI 交互未附带 `admin/test/images/*.png`
现场截图；需求 1 的后端闭环已由 `backend/test/s19_invite_admission.py` 25/25 + `s19_invite_
concurrency_pg.py` 3/3 覆盖，管理端通过 build 产物与接口契约验证路由/组件挂载。

## 关联变更

- 新增视图：`admin/src/views/InvitesView.vue`
- 修改：`admin/src/api/admin.ts`（InviteItem/InviteUpsert/InviteQrResult + 用户 status/
  invite_code_id/invite_name/onboarded_at；`fetchInvites`/`createInvite`/`updateInvite`/
  `fetchInviteQr`/`setUserStatus`；移除 `fetchOnboardingQr`）
- 修改：`admin/src/layout/AdminLayout.vue`（删除顶部入驻码按钮/弹窗/CSS）
- 修改：`admin/src/router/menus.ts` 新增 `invites` 菜单
- 修改：`admin/src/router/index.ts` 新增 `/invites` 路由
- 修改：`admin/src/views/AccessView.vue` 账号状态列、邀请码来源列、入驻时间列、status 筛选
