# identity.js

## 1. 文件路径

`frontend/services/identity.js`（51 行）

## 2. 文件职责

身份关联服务层：封装「扫码确认」与「身份绑定管理」两组后端 `/auth/*` 接口——PC 管理后台扫码登录确认、第三方身份绑定确认、已绑定身份列表与解绑（`frontend/services/identity.js:1-4` 模块 docstring）。扫码场景凭证格式 `L{token}`（登录确认）/ `B{token}`（绑定确认），**仅后端可生成**（`:3` 注释）。纯转发 `request.request`（`:5`），无本地状态。

## 3. 业务需求

- 来源：身份关联小程序侧（批次 5），`6ed1999`（2026-10-09）交付——扫码确认页 `pages/bind/bind` 与账号绑定页 `pages/account/account`、login redirect 支持、mine 入口（提交信息与 `docs/迭代记录.md` 的 `6ed1999` 条目）。
- 业务场景：管理员在 PC 后台出示二维码 → 用小程序扫码 → 手机端确认/取消登录；以及用户把第三方渠道身份（如企业微信等 provider，见后端文档）绑定到当前账号或解绑。完整业务流（含状态机与审计）见 `.qoder/backend/app/api/routes/identity.py.md` §3。

## 4. 核心功能

导出 4 个函数（`module.exports`，`:46-51`）：

| # | 函数 | 行号 | 后端端点 | 说明 |
|---|---|---|---|---|
| 1 | `qrInfo(scene)` | `:12-18` | `POST /api/auth/qr/info`，body `{scene}` | 查询扫码场景详情；**登录场景（L 前缀）查询即把会话置 scanned**（`:8` JSDoc，后端行为见 `.qoder/backend/app/api/routes/identity.py.md`）；返回 `{type, status, target?, expiresAt?, failReason?}`（JSDoc `:10`） |
| 2 | `qrConfirm(scene, action)` | `:25-31` | `POST /api/auth/qr/confirm`，body `{scene, action}` | 确认或取消；`action ∈ 'confirm'\|'cancel'`（JSDoc `:23`） |
| 3 | `listIdentities()` | `:34-36` | `GET /api/auth/identities` | 当前用户已绑定身份列表（`:33` JSDoc） |
| 4 | `unbind(identityId)` | `:39-44` | `DELETE /api/auth/identities/{identityId}` | 解绑指定身份；**wx_mini 登录凭证不可解绑，后端校验**（`:38` JSDoc） |

后端 4 端点的响应模型（`QrInfoOut`/`MessageOut`/`List[IdentityOut]`）、错误码与隐私边界（openid 不外发）见 `.qoder/backend/app/api/routes/identity.py.md` §2 端点表及后续章节，本文档不重复。注意该后端文件名为 `identity.py` 但路径全在 `/auth/*` 命名空间（命名与路径不一致的原因见该文档 §2 说明）。

## 5. 输入与输出

- `qrInfo(scene)`：scene 为扫码落地携带的完整凭证串（含 `L`/`B` 前缀）；凭证不存在/过期后端返回 404（`.qoder/backend/app/api/routes/identity.py.md` §3）。
- `qrConfirm(scene, action)`：会话状态非法（已使用/已失效）→ 400；登录场景无后台授权 → 403（同上文档）。
- `unbind(identityId)`：路径参数拼 URL（`:41`），无 body。
- 异常均以 Promise reject 冒泡到页面自行提示，本文件不 catch。

## 6. 依赖关系

- 依赖：`./request`（`:5`）→ `./config`（API_BASE_URL）→ 后端 `backend/app/api/routes/identity.py`。
- 被依赖（grep `services/identity` 与各函数名全量核实，测试目录除外）：
  - `frontend/pages/bind/bind.js:7`（require）；`:61` `.qrInfo(scene)`（扫码进入后拉场景详情渲染确认卡，页面流程注释 `bind.js:4`「qrInfo 查场景 → 展示确认卡片 → confirm/cancel → 结果态」）、`:128` `.qrConfirm(this.scene, 'confirm')`、`:153` `.qrConfirm(this.scene, 'cancel')`。
  - `frontend/pages/account/account.js:5`（require）；`:32` `.listIdentities()`、`:68` `.unbind(id)`。
- **准入/身份流的页面闸门**：`pages/bind/bind` 是扫码落地页（scene 由二维码携带，PC 登录确认与身份绑定确认**共用此页**，按 `qrInfo` 返回的 `type` 区分）；`pages/account/account` 从「我的」页进入（`6ed1999` 提交信息「mine 入口」）。登录守卫遵循 `frontend/AGENTS.md` §4.5（子页自行判断 `app.globalData.loggedIn`），本文件不含守卫逻辑。
- **零调用方导出**：无——4 个导出函数均有页面调用（上述 grep 证据）。

## 7. 业务规则

1. **凭证类型分流**：`L` 前缀 = PC 登录确认场景，`B` 前缀 = 身份绑定场景（`:3`）；前端不按前缀自行分支，统一先 `qrInfo` 由后端返回 `type/status` 决定渲染（`bind.js:4` 流程注释），状态机权威在后端（`.qoder/backend/app/api/routes/identity.py.md` §3）。
2. **一次性凭证**：确认后凭证失效（后端置 used/confirmed），重复 confirm 由后端 400 拒绝——前端不做幂等缓存。
3. **wx_mini 身份不可解绑**（`:38`）：小程序自身登录凭证是账号根身份，解绑校验在后端，前端仅透传错误。
4. 绑定确认的三重唯一性校验（身份已属他人/同渠道已绑/unionid 冲突 → 400，禁止自动合并）全部在后端事务内完成（`.qoder/backend/app/api/routes/identity.py.md` §3），前端只展示结果。

## 8. 修改约束

1. 端点路径属 `/auth/*` 命名空间硬契约（后端 `identity.py.md` §2 说明前端调用方 `frontend/services/identity.js:14`/`:27`/`:35`/`:41` 全部走 `/auth/*`），改路径须双端同步。
2. `qrInfo` 的返回结构（`type/status/target/expiresAt/failReason`）是 bind 页渲染契约；`target` 内**不含 openid**（后端隐私边界，`identity.py.md`），前端不得假设其存在。
3. 返回结构稳定性约束见 `frontend/AGENTS.md` §1；本层禁止加业务判断（分层规则 §3.1）。

## 9. 当前实现状态

- **已实现**：4 个函数全部可用且全部有真实调用方；对应后端 4 端点见 `.qoder/backend/app/api/routes/identity.py.md`；automator 15/15 断言 + 6 截图验收随 `6ed1999` 交付（提交信息）。
- **存在问题 / 已知事项**：无本文件层面问题。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/identity.js`，共 **1 个提交**；已核对存在于 `docs/迭代记录.md`。

### 2026-10-09（`6ed1999`，12:45）
- 需求：身份关联小程序侧（批次 5）。
- 修改内容（涉本文件）：创建 `identity.js`，封装 `qrInfo/qrConfirm/listIdentities/unbind` 四函数；同批交付扫码确认页 bind、账号绑定页 account、login redirect 支持与 mine 入口（提交信息）。
- 关联文件：`frontend/pages/bind/bind.js`、`frontend/pages/account/account.js`、`backend/app/api/routes/identity.py`。
- 测试结果：automator 15/15 断言 + 6 截图验收（提交信息）；详见 `docs/迭代记录.md` 的 `6ed1999` 条目。
