# wx.py

## 1. 文件路径
`backend/app/core/wx.py`

## 2. 文件职责
微信平台接口工具（模块 docstring `:1-5`）：提供 `code2session`（用 `wx.login` 的 code 换 openid/unionid/session_key）与 `decrypt_werun`（AES-128-CBC 解密微信运动加密数据并校验 watermark）两个纯工具函数。基础设施层，不依赖业务模块；**session_key 不落库、不写日志，取到即用即弃**（`:3` 注释，ARCHITECTURE.md 不变量 12）。

## 3. 业务需求
- 小程序登录：`POST /api/auth/login` 需要用微信 code 换取 openid 作为用户唯一标识（`services/auth_service.py:43`）。
- 步数同步接入微信运动真实数据（`3df3fd0`，2026-10-10，本文件创建的唯一动因）：用户反馈「实际没走 9000 步，同步后当天却写入约 9000 步」，根因此前后端对无参请求一律用伪随机模拟步数落库；修复要求前端上送 `wx.getWeRunData()` 的加密数据，后端解密取真实步数，**杜绝模拟步数写库**（`docs/迭代记录.md` 该条目）。
- 未配置 `WX_APPID`/`WX_SECRET` 时 `code2session` 返回 None，由调用方自行降级（`:4` docstring），支撑本地无凭证开发。

## 4. 核心功能

### 4.1 常量 `WX_CODE2SESSION`（`:15`）
微信登录凭证校验接口地址 `https://api.weixin.qq.com/sns/jscode2session`。**这是本文件唯一直接调用的微信接口**；`cgi-bin/token`（全局凭据）与 `wxa/getwxacodeunlimit`（小程序码）在 `services/wechat_service.py` 中另行调用，不在本文件。

### 4.2 `code2session(code)`（`:18-42`）
- 凭证门控（`:20-21`）：`WX_APPID` 或 `WX_SECRET` 任一为空 → 直接返回 `None`，不发请求。
- HTTP 调用（`:23-32`）：`httpx.get`，query 参数 `appid`/`secret`/`js_code`/`grant_type=authorization_code`，**超时 5.0 秒**（`:31`），**无重试**。
- 响应处理（`:33-40`）：`resp.json()` 解析；无 `openid` 字段（含微信返回 errcode 错误的情形）→ `None`（`:34-35`）；成功则返回**只含三个键**的 dict：`openid`、`unionid`（`data.get`，可能为 None——仅小程序绑定开放平台账号时微信才返回）、`session_key`（`:36-40`）。
- 异常处理（`:41-42`）：**裸捕 `Exception` 一律返回 `None`**——网络错误、超时、JSON 解析失败对调用方不可区分，统一表现为「换取失败」。本函数不抛异常。

### 4.3 `decrypt_werun(session_key, encrypted_data, iv)`（`:45-61`）
- 解密（`:48-55`）：`session_key`/`iv`/`encrypted_data` 均 base64 解码后走 pycryptodome 的 `AES.MODE_CBC` 解密；手工校验 PKCS#7 填充字节 `pad`，越界（<1 或 >32）抛错（`:52-54`）；去填充后 UTF-8 解码并 `json.loads`（`:55`）。
- 解密过程任何异常统一转抛 `ValueError("微信运动数据解密失败，请重新同步")`（`:56-57`）。
- watermark 校验（`:58-60`）：`payload["watermark"]["appid"]` 必须等于 `settings.WX_APPID`，否则抛 `ValueError("微信运动数据校验失败，请重新同步")`——防止跨小程序重放加密数据。
- 成功返回解密后的完整 payload dict（`:61`），微信运动数据中业务方消费的是 `stepInfoList`（消费点 `sport_service.py:92-96`）。

## 5. 输入与输出
| 函数 | 入参 | 成功返回 | 失败行为 |
|---|---|---|---|
| `code2session` | `code: str`（`wx.login` 临时凭证） | `{openid, unionid, session_key}` dict | 返回 `None`（未配置凭证 / 响应无 openid / 任何异常）；**不抛异常、无错误码** |
| `decrypt_werun` | `session_key, encrypted_data, iv`（均 base64 字符串） | 解密 payload dict（含 `stepInfoList`、`watermark`） | 抛 `ValueError`（中文用户文案）：解密失败或 watermark.appid 不匹配 |

调用方对失败的处理（错误码在调用方产生，不在本文件）：
- `auth_service._resolve_openid`（`auth_service.py:41-48`）：返回 None 时，若已配置凭证且 `WX_LOGIN_ALLOW_MOCK=false` → 抛 `WxLoginError`，路由转 **502**、不回退 mock；否则回退 `_mock_openid`（`:35-38`，md5 派生 `mock_` 前缀）。
- `sport_service._resolve_steps`（`sport_service.py:85-102`）：换取失败或缺 `session_key` → `ValueError("微信会话换取失败，请重新同步")`（`:88-89`），路由转 400；解密失败/伪造数据的 `ValueError` 同样转 400，**零写入**。

## 6. 依赖关系
- **依赖**：标准库 `base64`、`json`（`:6-7`）；第三方 `httpx`（同步 GET）、`Crypto.Cipher.AES`（pycryptodome，`3df3fd0` 新增依赖）；`app.core.config.settings`（`:13`）。
- **被依赖**：
  - `code2session`：`services/auth_service.py:17`（import）、`:43`（登录）；`services/sport_service.py:23`（import）、`:87`（步数同步换 session_key）。
  - `decrypt_werun`：`services/sport_service.py:23`、`:90`（解密微信运动数据）。
  - 测试脚本 `test/s11_sport_sync_werun.py`、`s20_v2_regression.py` 等直接引用/替换这两个函数做加解密往返与伪造数据用例。
- **不依赖**任何 models/services/schemas（core 层单向约束，`backend/AGENTS.md` §3.1）。

## 7. 业务规则
- **session_key 即用即弃**（`:3` 注释）：仅在内存中传给 `decrypt_werun`，不写库、不打日志、不下发前端；`auth_service` 登录链路只持久化 openid/unionid（身份行经 `identity_service.ensure_wx_mini_identity`，`auth_service.py:57-60`）。
- **真实数据优先、绝不编造步数**：真实用户（非 `mock_` 前缀 openid）且已配置凭证时，拿不到微信运动数据即抛错，不回退模拟步数（`sport_service.py:100-102`）；mock 回退仅限「mock 登录用户或未配置凭证」的开发场景。
- **watermark.appid 强校验**：解密数据必须来自本小程序，防重放（`:58-60`）。
- 降级判定权在调用方：本文件对「未配置凭证」与「微信侧失败」都只返回 None，是否允许 mock 由 `WX_LOGIN_ALLOW_MOCK`（登录链路）或 openid 前缀/凭证状态（步数链路）决定。

## 8. 修改约束
- 不得把 session_key 写入日志、数据库或接口响应（`:3` 注释与不变量 12）。
- `code2session` 「失败返回 None 不抛异常」的契约被 `auth_service.py:44-48` 与 `sport_service.py:88-89` 依赖，改为抛异常属破坏性变更。
- `decrypt_werun` 失败必须抛 `ValueError`（路由层按「service 抛 ValueError → 400」的统一约定转换，`backend/AGENTS.md` §5 异常条目）；watermark 校验（`:58-60`）不得移除。
- 手机号快速验证、头像获取等能力**不在本文件也不在计划内落地**：`docs/身份绑定与自动登录改造分析报告.md`（提交 `cc66b8b`）确认平台不满足手机号快捷验证条件、改用批量绑定码方案（`docs/迭代记录.md` 2026-10-11「改造分析报告补充确认结果」，提交 `7fcd037`）；用户头像由前端上送字符串参数（`auth_service.wx_login(db, code, avatar)`，`auth_service.py:68-70`），后端不调微信头像接口。
- 超时 5 秒、无重试是当前既定实现；如需调整须同步评估登录/步数同步两条链路的小程序侧 10 秒请求超时（`frontend/services/request.js:73`，ARCHITECTURE.md §11.4 口径）。

## 9. 当前实现状态
- 已实现：code2session 换取、微信运动数据 AES 解密与 watermark 校验、未配置凭证降级门控。
- 能力边界（现状记录）：
  - 本文件只覆盖微信 3 个对接接口中的登录换取与本地解密两件事；`cgi-bin/token` 与小程序码在 `services/wechat_service.py`（ARCHITECTURE.md §7）。
  - `code2session` 不区分失败原因（errcode 未解析、异常被吞），线上排障只能靠调用方的 502/400 文案；无日志输出。
  - `unionid` 是否有值取决于小程序是否绑定微信开放平台账号（代码用 `data.get("unionid")` 容错，`:38`）；绑定状态属平台侧事实——待确认。
  - 无手机号解密、无内容安全等其它微信能力（未开发）。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/core/wx.py`（1 个提交）与 `docs/迭代记录.md`，按时间倒序。

### 2026-10-10
- 需求：步数同步接入微信运动真实数据，杜绝模拟步数写库（用户反馈实际未走 9000 步却被写入约 9000 步；提交 `3df3fd0`）。
- 修改内容：创建本文件——`code2session`（code 换 session_key）+ `decrypt_werun`（AES-128-CBC 解密 + watermark.appid 校验）；`auth_service` 收敛复用本文件的 `code2session`（此前登录换取逻辑在 service 内）；`sport_service.sync_today` 真实用户解密取步数，缺数据/解密失败 400 不写库，仅 mock 用户或未配置凭证时回退模拟。
- 关联文件：`services/sport_service.py`、`services/auth_service.py`、前端 `services/sport.js`（授权 scope.werun → wx.login → getWeRunData 上送）、`backend/requirements.txt`（新增 pycryptodome）。
- 测试结果：S11 后端冒烟 8/8（`test/s11_sport_sync_werun.py`，含加解密往返/watermark 校验/缺当日步数/伪造数据 400 零写入）、e2e 全链路 178/178 回归、小程序 automator 验收 4/4（截图 s11-01）；真机（已开通微信运动设备）端到端回归待用户确认（`docs/迭代记录.md`）。
