# S9 RBAC 与审计接口 冒烟测试报告

- 脚本：`backend/test/s9_rbac_access.py`（TestClient，直连数据库，不依赖 8010 端口残留进程）
- 时间：2026-10-09
- 结果：**30/30 通过**；s8 复测 23/23 通过（回归无破坏）
- 关联提交：批次 3（RBAC 四表服务 + `/admin/users|roles|audit-logs` + 既有接口挂 `require_menu` + WS 改造）

## 覆盖矩阵（对照设计文档 §4.2 / §7 开发要求）

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| A1 超管全放行 | super 令牌访问 users/roles/audit-logs/me（9 菜单）与业务接口均 200 | PASS |
| A2a 无角色用户令牌 | typ=user 令牌无启用角色 → 403「后台访问权限已被撤销或禁用」 | PASS |
| A2b 普通小程序令牌 | 访问后台接口 401 | PASS |
| A3 require_menu 强制 | operator 可用 dashboard，users/roles/audit-logs 全部 403 | PASS |
| A4 人员列表筛选 | 关键词命中唯一、has_access=true/false 互斥、角色明细含 operator | PASS |
| A5 角色 CRUD | 创建（code 自动生成）/无效菜单 400/编辑全量覆盖/内置禁删/被引用禁删/删除成功 | PASS |
| A6 授权链路 | access 角色可管理授权；被授权者即时获得访问；grant 审计区分 super/user 操作人 | PASS |
| A7 禁用即时生效 | 禁用 operator 后同令牌 dashboard 立即 403（access 菜单仍可用）；重新启用恢复 | PASS |
| A8 错误分支 | 用户不存在 404、角色不存在 400、编辑不存在 400、未授权角色禁用 404 | PASS |
| A9 审计筛选 | action+actor_type 组合、actor_type=user 昵称解析、date 命中今日、历史日期为空 | PASS |
| A10 WS 鉴权改造 | 管理员/用户可连、坏令牌 4401、权限撤销后建连 4403 | PASS |

## 测试发现并修复的缺陷

1. **`delete_role` 外键违反**：删除角色时未先删 `admin_role_menus` 行，openGauss 报
   `ForeignKeyViolation (admin_role_menus_role_id_fkey)`。修复：删除角色前先按 `role_id`
   清理菜单关联行（`app/services/access_service.py`），复测 A5f 通过。

## 安全约束落实（设计文档 §7）

- 测试不绕过鉴权：用户令牌均通过 `create_admin_token_for_user` 签发，授权通过
  super 令牌调用 RBAC API 完成（被测功能本身），未在测试中直接插入授权行冒充管理员；
- 撤销/禁用即时生效由 A7/A10 双路径验证（REST 每请求查库 + WS 建连查库）；
- 未硬编码任何微信密钥或管理员密码；`ADMIN_PASSWORD` 默认空，账号登录需显式配置
  （批次 6 全链路回归已统一适配：s4/s5/s6/s7/p2_quotes/nickname_change_smoke/e2e_full_flow
  均改为 `create_admin_token("admin")` 铸造超管令牌；e2e_full_flow 的 D01/D02 按
  `ADMIN_PASSWORD` 是否配置分别断言「403 禁用」或「环境密码登录成功/错误密码 401」）。

## 残留数据清理

脚本 cleanup() 删除冒烟用户（u1/u2/u3 及其积分/运动/答题/勋章/事件/授权/审计行）、
`ROLE_NAME_PREFIX` 测试角色及 `access.*` 审计行，可重复执行。
