# 后端测试报告 —— 昵称修改（每人仅一次）

- 测试日期：2026-10-01
- 测试人：自动化验收（Qoder）
- 测试方式：HTTP 直连黑盒（真实后端 + openGauss）
- 测试脚本：`backend/test/nickname_change_smoke.py`（可重复执行）
- 证据文件：`backend/test/nickname-smoke-results.json`
- 关联需求：
  1. 登录页选择微信登录后直接用微信名称登录；
  2. 进入后可修改名称，一个人只允许修改一次；
  3. 修改记录在 PC 端排名洞察可见。

## 1. 测试环境

| 项 | 值 |
| --- | --- |
| 后端 | FastAPI + uvicorn，`http://127.0.0.1:8010`（全量重启加载最新代码） |
| 数据库 | openGauss（127.0.0.1:5118，库 `longmarch`），已执行 `docker/init/004_nickname_change.sql`（ALTER users 2 列 + 存量 84 人曾用名回填） |
| 测试用户 | 每轮由唯一 mock code 派生新用户（本轮 code=`e2e-nickname-<时间戳>`，用户 id=92） |

## 2. 结论摘要

**10 / 10 全部通过**，无阻塞缺陷。

| 用例 | 结果 | 关键断言 |
| --- | --- | --- |
| N01 管理端登录 | ✅ | admin 令牌签发 |
| N02 首次登录以微信名称建号 | ✅ | nickname=微信昵称测试员，nicknameChangedAt=null |
| N03 重复登录不覆盖昵称 | ✅ | 携带「登录时的新名字」登录后昵称仍为微信昵称测试员 |
| N04 首次修改昵称成功 | ✅ | nickname=长征小红军，nicknameChangedAt=2026-10-01T07:38:36 |
| N05 第二次修改被拒绝 | ✅ | 400「昵称仅可修改一次，无法再次修改」 |
| N06 已改名用户重复登录 | ✅ | 昵称保持改后值，不被微信名覆盖 |
| N07 排名洞察返回修改记录 | ✅ | original_nickname=微信昵称测试员 + nickname_changed_at 非空 |
| N08 人员详情返回修改记录 | ✅ | 同上（`/admin/users/92/overview`） |
| N09 空昵称被拒绝 | ✅ | 400 |
| N10 未登录修改被拒绝 | ✅ | 401 |

## 3. 回归验证

既有数据联动端到端套件 `backend/test/e2e_datasync.py` 复跑：**23 / 23 通过**（含排名总览、人员详情聚合、WebSocket 广播），本次改动无回归。

## 4. 变更清单

| 文件 | 变更 |
| --- | --- |
| `docker/init/004_nickname_change.sql` | users 表新增 `original_nickname`、`nickname_changed_at`，存量回填 |
| `app/models/models.py` | User 模型同步两列 |
| `app/services/auth_service.py` | 登录仅在创建时写昵称（记曾用名）；新增 `update_nickname`（仅一次） |
| `app/api/routes/auth.py` | 新增 `PUT /api/auth/nickname`（400 拦截 + WS 广播） |
| `app/schemas/schemas.py` | `UserOut` 增加 `nicknameChangedAt`；新增 `NicknameUpdateRequest`；管理端两个模型增加曾用名/修改时间 |
| `app/services/admin_service.py` | 排名总览与人员详情返回 `original_nickname` / `nickname_changed_at` |
