# wechat_service.py

## 1. 文件路径
`backend/app/services/wechat_service.py`（共 90 行）

## 2. 文件职责
微信服务端接口封装：小程序全局 access_token 的进程内缓存获取，以及携带 scene 的小程序码（`getwxacodeunlimit`）生成与 data URL 转换。凭证仅存进程内存、过期前 200 秒刷新、不落库、不写日志（模块 docstring，`backend/app/services/wechat_service.py:1-4`）。本文件不含 `code2Session` 登录换取逻辑（该逻辑在 `auth_service`，见 `.qoder/backend/app/services/auth_service.py.md`）。

## 3. 业务需求
- PC 扫码登录/绑定确认：管理端生成携带一次性 scene_token 的小程序码（落地页 `pages/bind/bind`，:16-17），供 `backend/app/api/routes/admin.py:131,135` 出码。
- 员工入驻邀请码：管理端按邀请码生成小程序码（落地页 `pages/launch/launch`，scene 为 `i=<邀请码>`，不含任何个人身份信息，:18-19），供 `backend/app/api/routes/admin.py:897-900` 出码；同码内容固定，成功结果进程内缓存复用（:76-84）。
- 未配置微信凭证或调用失败时返回 `None`，由调用方降级 mock（`get_wxacode_png` docstring :54；`backend/AGENTS.md` §2「微信对接」行）。
- 小程序码环境版本可配置（`WXACODE_ENV_VERSION`，默认 `trial`，`587fd5b` 引入），开发期体验版可扫码。

## 4. 核心功能
### 4.1 模块常量与缓存（:13-23）
- `WX_TOKEN_URL` / `WX_WXACODE_URL`：微信官方接口地址（:13-14）。
- `WXACODE_PAGE = "pages/bind/bind"`（:17）、`ONBOARD_PAGE = "pages/launch/launch"`（:19）。
- `_TOKEN_TTL_SECONDS = 7000`：微信 access_token 有效期 7200s，提前 200s 刷新（:21）。
- `_token_cache`（:22）与 `_invite_image_cache`（:23）：进程内 dict 缓存，无持久化。

### 4.2 `_fetch_access_token() -> Optional[str]`（:26-50）
私有：取全局 access_token。缓存未过期直接返回（:28-30）；`WX_APPID`/`WX_SECRET` 任一未配置返回 `None`（:31-32）；否则 GET 微信 token 接口（`grant_type=client_credential`，timeout 5s，:34-42），成功则写缓存并设 `expires_at = now + 7000`（:43-48），任何异常吞掉返回 `None`（:49-50）。

### 4.3 `get_wxacode_png(scene, page=WXACODE_PAGE) -> Optional[bytes]`（:53-73）
生成携带 scene 的小程序码图片字节。无 token 返回 `None`（:55-57）；POST `getwxacodeunlimit`（token 拼在 query，body 含 `scene/page/check_path=False/env_version`，timeout 10s，:58-68）；网络异常返回 `None`（:69-70）；仅当响应 `content-type` 以 `image` 开头才返回图片内容，否则（微信返回 JSON 错误体）返回 `None`（:71-73）。

### 4.4 `get_invite_image(scene) -> Optional[bytes]`（:76-84）
邀请码小程序码：以 `(WXACODE_ENV_VERSION, scene)` 为键查 `_invite_image_cache`（:78-79），未命中则调 `get_wxacode_png(scene, ONBOARD_PAGE)`，仅成功结果入缓存（:80-83）。

### 4.5 `to_data_url(image) -> str`（:87-90）
按文件头识别格式（`\x89PNG` 开头为 PNG，否则按 JPEG——微信默认返回 JPEG，`is_hyaline` 时为 PNG）转 `data:<mime>;base64,...` 字符串。

## 5. 输入与输出
| 函数 | 输入 | 输出 |
| --- | --- | --- |
| `_fetch_access_token` | 无（读 `settings` 与模块缓存） | `Optional[str]` token |
| `get_wxacode_png` | `scene: str`、`page: str`（默认 bind 页） | `Optional[bytes]` 图片内容；失败一律 `None` |
| `get_invite_image` | `scene: str`（邀请码 scene） | `Optional[bytes]` |
| `to_data_url` | `image: bytes` | `str`（data URL） |

本文件不抛业务异常：所有网络/解析失败都收敛为返回 `None`（:49-50,69-70,71-73），降级决策（mock 提示、下载置灰）由路由层处理。不访问数据库、无事务、无审计写入；HTTP 调用为 httpx 同步阻塞（timeout 5s/10s）。

## 6. 依赖关系
- import 依赖（:5-11）：标准库 `base64`、`time`；第三方 `httpx`；`app.core.config.settings`（配置项：`WX_APPID`、`WX_SECRET`、`WXACODE_ENV_VERSION`——仅记录名称与用途，值不写入文档）。
- 被依赖方（service 中唯一不依赖 models/其他 service 的对外网关之一）：
  - `backend/app/api/routes/admin.py:131`（扫码登录二维码，`get_wxacode_png` + scene_token）、`:135`（`to_data_url`）、`:897`（邀请码小程序码，`get_invite_image`）、`:899-900`（`to_data_url`、`ONBOARD_PAGE`）。
- 外部服务：`api.weixin.qq.com` 的 `/cgi-bin/token` 与 `/wxa/getwxacodeunlimit`（:13-14）。
- 不依赖数据库 session（与 `backend/AGENTS.md` §4 不变量 6 无涉）。

## 7. 业务规则
- token 缓存策略：进程内单例，7000s TTL 提前刷新（:21,29-30,47）；凭证不落库、不写日志（docstring :3）。
- 凭证缺失即静默降级：`WX_APPID`/`WX_SECRET` 未配置时不出码（:31-32），调用方按 mock 处理。
- 邀请码图片缓存以「环境版本 + scene」为键（:78）：切换 `WXACODE_ENV_VERSION` 后旧缓存自然失效（键不同）；缓存只存成功结果，失败不缓存、下次重试（:81-83）。
- scene 内容约束：绑定确认码 scene 为一次性 scene_token；邀请码 scene 为 `i=<邀请码>`，不含 openid/个人信息/Token（:16-19 注释；`docs/迭代记录.md` 的 `67c96b1` 条目同口径）。
- 响应类型判别：以 `content-type` 前缀 `image` 判定成功，微信错误 JSON 一律视为失败（:71-73）。

## 8. 修改约束
- 禁止把 access_token、`WX_SECRET` 等凭证写入日志、数据库或响应体（docstring :3；`docs/迭代记录.md` 的 `afbcba9` 条目「日志/响应脱敏」要求）。
- 配置项一律走 `app/core/config.py` 的 `Settings`，禁止硬编码密钥/URL（`backend/AGENTS.md` §5「配置」）；本文档与代码注释均不得出现真实凭证值。
- `get_wxacode_png` 的 `page` 参数与 `ONBOARD_PAGE`/`WXACODE_PAGE` 常量被 admin 路由直接引用（`backend/app/api/routes/admin.py:900`），改名/改默认页属破坏性变更，需同步小程序端落地页路径。
- 失败返回 `None` 的降级契约被调用方依赖（mock 分支），不得改为抛异常。
- `to_data_url` 的文件头判别对应微信实际返回 JPEG 的行为（`225f99c` 修复），前端下载扩展名依赖该 mime，勿简化为固定 PNG。

## 9. 当前实现状态
### 已实现
- access_token 进程内缓存 + 提前 200s 刷新（:21-50）。
- 小程序码生成（scene/page/env_version 参数化，:53-73）；邀请码图片按版本+scene 缓存（:76-84）；文件头识别格式转 data URL（:87-90）。
- 凭证未配置/网络失败/微信错误体三类失败统一返回 `None` 降级（:31-32,49-50,69-73）。

### 存在问题
- `_invite_image_cache` 无容量上限与过期清理（:23,83），邀请码 scene 数量大时进程内存持续增长；当前邀请码总量有限，风险可控但无兜底。
- token 缓存为进程内单例（:22），多 worker/多实例部署时各进程独立取 token，无分布式共享；微信侧多进程各自获取 token 是否互相挤失效，待确认（未见代码或文档处理）。
- 所有异常被静默吞掉且按设计不写日志（:49-50,69-70），线上出码失败时无后端排查线索，只能靠调用方 mock 表现倒推。

### 待开发
- 无代码内 TODO。`frontend` 真机扫码链路在 `67c96b1`/`225f99c` 条目中标注「待验证」，后续是否已补真机验收：待确认。

## 10. 迭代记录
数据来源：`git log --follow backend/app/services/wechat_service.py` 与 `docs/迭代记录.md` 对应条目。

### 2026-10-12（`afbcba9`，14:49）
- 需求：邀请码准入全链路（后端迁移/服务/路由/测试、admin 邀请码管理、小程序扫码准入）。
- 修改内容：入驻码函数演进为 `get_invite_image`（按邀请码 scene 出码 + 进程内缓存，:76-84），落地页 `ONBOARD_PAGE = pages/launch/launch`（:19）；旧通用入驻码接口 `/api/admin/onboarding-qrcode` 下线。
- 关联文件：`backend/app/api/routes/admin.py`、`backend/app/services/invite_service.py`、`backend/app/services/auth_service.py`、`docker/init/015_invite_admission.sql`、admin 邀请码管理页、小程序 launch/onboard 页。
- 测试结果：`docs/迭代记录.md` 的 `afbcba9` 条目记录——`test/s19_invite_admission.py` 25/25、真实 openGauss 并发 `s19_invite_concurrency_pg.py` 3/3、admin `npm run build` 通过、小程序 `node --check` 全部通过；真机扫码与 automator 三态截图未纳入本次 CI，需另行手工验收。

### 2026-10-11（`225f99c`，00:45）
- 需求：admin 顶栏新增员工入驻二维码查看与下载。
- 修改内容：新增 `to_data_url` 按文件头识别 PNG/JPEG（微信 `getwxacodeunlimit` 实际返回 JPEG，:87-90）；`get_onboarding_png` 更名 `get_onboarding_image`；下载扩展名随格式变化。
- 关联文件：`backend/app/api/routes/admin.py`、`admin/src/layout/AdminLayout.vue` 等。
- 测试结果：`docs/迭代记录.md` 的 `225f99c` 条目记录——admin `npm run build` 通过；S13 冒烟 13/13；浏览器验收弹窗显示体验版小程序码（`data:image/jpeg`）、下载可用；真机扫码进入小程序待验证。

### 2026-10-11（`67c96b1`，00:26）
- 需求：V1.0 扫码入驻登录健壮性与通用入驻小程序码接口。
- 修改内容：`get_wxacode_png` 参数化 `page`（:53），新增入驻码函数（成功结果按版本进程内缓存）与 `GET /api/admin/onboarding-qrcode`；scene 固定 `src=onboard` 不含个人信息。
- 关联文件：`backend/app/services/auth_service.py`、`backend/app/api/routes/admin.py`、`backend/app/core/config.py`（`WX_LOGIN_ALLOW_MOCK`）、design.md/README/AGENTS。
- 测试结果：`docs/迭代记录.md` 的 `67c96b1` 条目记录——S13 冒烟 13/13（SQLite 临时库，含微信失败 502、8 并发首登、401/权限矩阵）；S12 回归 11/11；真实微信出码与真机扫码待验证。

### 2026-10-09（`587fd5b`，14:11）
- 需求：本地启用管理账号登录，小程序码环境版本可配置（默认 trial，开发期体验版可扫码）。
- 修改内容：出码 `env_version` 由硬编码 `release` 改为读 `settings.WXACODE_ENV_VERSION`（:65,78）。
- 关联文件：`backend/app/core/config.py`、`backend/.env`（本地配置，不入库）。
- 测试结果：`docs/迭代记录.md` 的 `587fd5b` 条目记录——TestClient 冒烟 `POST /api/admin/login` 返回 200 + 超管令牌；扫码会话创建正常（`WX_SECRET` 未填时降级 mock）。

### 2026-10-09（`b431e4d`，10:27）
- 需求：微信扫码登录与身份关联（批次 2）——小程序码扫码会话、绑定确认事务、身份列表与解绑等。
- 修改内容：创建本文件，实现 access_token 缓存与 `get_wxacode_png`（绑定确认页 `pages/bind/bind`，:17），支撑 `/auth/qr/*` 与 `/admin/wechat/qr*` 扫码会话出码。
- 关联文件：`backend/app/services/identity_service.py`、`backend/app/api/routes/auth.py`、`backend/app/api/routes/admin.py`、`docker/init/010` 迁移（qr_login_sessions 等 8 表）。
- 测试结果：`docs/迭代记录.md` 的 `b431e4d` 条目记录——S8 集成测试 23/23 通过（`backend/test/s8_identity_admin.py`，报告 `backend/test/docs/s8-identity-admin.md`）。
