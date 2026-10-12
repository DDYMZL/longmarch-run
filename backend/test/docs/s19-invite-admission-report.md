# S19 邀请码准入与账号停用 测试报告（backend）

日期：2026-10-12 ｜ 范围：backend ｜ 脚本：`backend/test/s19_invite_admission.py`、`backend/test/s19_invite_concurrency_pg.py`

## 背景

需求 1：小程序入驻必须由管理后台生成邀请码；未扫码/用无效（无效/停用/过期/用满）码进入
的用户不得被建号。既有账号不动，历史用户（无邀请码来源）继续可用。

## 实现要点

- 迁移 `docker/init/015_invite_admission.sql`：新增 `invite_codes`、`users.status/invite_code_id/
  onboarded_at`、`invites` 菜单、operator 角色默认授权。
- 服务层 `backend/app/services/invite_service.py`：
  - 校验（verify）：不核销，`invite_limiter`（60s/60 次/IP）限流；
  - 核销（consume）：原子条件 UPDATE `used_count + 1 WHERE enabled=TRUE AND NOT expired
    AND (max_uses IS NULL OR used_count < max_uses)`；
  - 组织范围（`check_user_org_scope`）：专属码限定该组织及其下级子树。
- `auth_service.onboard`：同一事务内 consume + 建号 + 审计 `user.onboard`；openid 唯一约束冲突
  →回滚撤销核销 → 再查已存在用户复用（避免并发/重入「死码」）。
- `/api/auth/login`：改为状态式返回 `{status: active|unregistered|disabled, token?, user?}`，
  未入驻不建号；禁用用户 token 不签发。
- `deps.get_current_user`：禁用用户所有受保护接口 403 并带 `X-Account-Status: disabled`；
  ws 握手禁用用户返回 4403 关闭。
- 日志脱敏：`wechat_service` / `auth_service` 不打印 openid、code、session_key、邀请码。

## 测试结果

### 1. 功能、权限、鉴权、脱敏（25/25 通过）

证据：`backend/test/s19-invite-admission-results.json`。

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| I01 | 未入驻登录返回 unregistered 且不建号不签发 Token | PASS |
| I02 | 无邀请码入驻被拒且不建号 | PASS |
| I03 | 无效/非法/超长邀请码校验与入驻均拒绝 | PASS |
| I04 | 已过期邀请码拒绝 | PASS |
| I05 | 已停用邀请码拒绝 | PASS |
| I06 | 已用满邀请码拒绝 | PASS |
| I07 | 校验有效码返回名称与组织范围、不核销、不回显原码与次数 | PASS |
| I08 | 持有效码入驻建号、核销+1、审计写 `user.onboard`、Token 可用、再次登录 active | PASS |
| I09 | 专属码越界/不存在组织拒绝且不核销，范围内下级组织成功 | PASS |
| I10 | 已入驻身份重复入驻返回同一用户、不再核销、不覆盖资料 | PASS |
| I11 | 原邀请码过期/停用/用满后已入驻用户登录仍 active | PASS |
| I12 | 同一身份 8 并发入驻：全部成功、1 个用户、仅核销 1 次 | PASS |
| I13 | 8 不同身份并发抢 max_uses=3：恰好 3 个成功且 used_count=3 | PASS |
| I14 | 建号撞唯一约束：回滚撤销核销并复用已有用户 | PASS |
| I15 | 停用：登录 disabled、38 受保护接口 403、入驻 403、WS 4403；启用后恢复 | PASS |
| I16 | 历史用户（无邀请码）登录 active、改选组织不受限 | PASS |
| I17 | 专属码用户改选组织越界 400、范围内 200、`/org/mine` 返回范围 | PASS |
| I18 | code2session 失败：登录/入驻 502 且不建号 | PASS |
| I19 | 38 用户受保护接口无/伪造 Token 均 401 | PASS |
| I20 | 47 管理接口拒绝普通用户 Token | PASS |
| I21 | 管理端邀请码 CRUD/启停/小程序码/UTC 存储/审计 | PASS |
| I22 | 用户状态：无 access 菜单 403、非法状态 422、用户不存在 404、列表含状态并可筛选、审计 | PASS |
| I23 | 响应与日志不含 openid/session_key/wx code/邀请码/AppSecret | PASS |
| I24 | `WX_LOGIN_ALLOW_MOCK=true` mock openid 识别，未入驻不建号 | PASS |
| I25 | 过期 Token 401，重新登录 active 并复用同一用户 | PASS |

### 2. 真实 openGauss 并发（3/3 通过）

证据：`backend/test/s19-invite-concurrency-pg-results.json`。

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P01 | 单码多身份并发消费不超额、线程局部事务独立回滚 | PASS |
| P02 | 同一身份并发入驻只建一个用户、只核销一次 | PASS |
| P03 | 回滚复用已存在用户（openid 唯一约束冲突触发） | PASS |

> P03 初次失败：auth_service.onboard 捕获 `IntegrityError` 后未再查已存在用户直接抛错，
> 导致后入请求 400。修复为捕获 `InviteError`+`IntegrityError` 后 `rollback` 并复用已有用户，
> 连跑 3 次全部通过。

## 替代/废弃

- `backend/test/s13_onboard_login.py` 原本覆盖「首次登录自动建号」的旧路径，与新「邀请码才建号」
  冲突，统一被 s19 替代，已 `git rm`。
- 旧的管理端 `GET /api/admin/onboarding-qrcode` 通用入驻码接口删除，由
  `/api/admin/invites/{id}/qrcode` 单码下发替代。

## 风险与注意事项

- 并发消费依赖 `invite_codes.used_count` 唯一行上的条件 UPDATE，openGauss 行锁保证互斥；
  若后续引入分片/读写分离需评估。
- `invite_limiter` 为进程内滑动窗口，仅做防刷手段，多副本部署需换集中式限流器（Redis 等）。
- 真机测试需在微信开发者工具下真实扫码（trial/release 包），scene ≤ 32 字符已验证。
