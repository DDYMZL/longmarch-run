# config.py

## 1. 文件路径
`backend/app/core/config.py`

## 2. 文件职责
后端唯一的配置定义与加载入口：基于 pydantic-settings 的 `Settings` 类，按系统环境变量 `APP_ENV` 选择加载 `backend/.env`（本地开发）或 `backend/.env.prod`（生产），并以 `lru_cache` 单例形式向全后端暴露配置项（`config.py:110-115`）。

## 3. 业务需求
- 前后端契约、微信对接、JWT 鉴权、积分/答题/连续行军等业务规则的可调参数集中管理，避免硬编码散落（`backend/AGENTS.md` §5「配置」条目要求：新增配置项加到本文件的 `Settings`，带中文注释与默认值）。
- 本地开发与生产双环境隔离：`f05531a`（2026-10-16）引入 `.env.prod` 与 `APP_ENV` 切换加载，两份 env 文件经用户决定均入库。
- 数据库连接串必填化：`fc2597e`（2026-10-13）openGauss 兼容性整改，杜绝静默回退到错误/过期的库。

## 4. 核心功能

### 4.1 env 文件选择（`config.py:9-15`）
- `_ENV_DIR`（`:11`）：`Path(__file__).resolve().parents[2]`，把 env 文件锚定到 `backend/` 根目录，不依赖启动时的工作目录（本地 `run.py` 与服务器 uvicorn/systemd 从不同 cwd 启动读到同一份配置）。
- `_APP_ENV`（`:14`）：**只从系统环境变量 `os.getenv("APP_ENV")` 读取**（strip + lower）。写进 `.env` 不生效，因为 env 文件选择发生在解析 `.env` 之前（`:12-13` 注释明确）。
- `_ENV_FILE`（`:15`）：`APP_ENV == "prod"` 时加载 `.env.prod`，其余情况（含未设置）加载 `.env`。

### 4.2 Settings 类（`config.py:18-107`）
- `model_config`（`:19-21`）：`env_file=_ENV_FILE`、`env_file_encoding="utf-8"`、`extra="ignore"`（env 文件中的未知键忽略，不报错）。
- 加载优先级：系统环境变量 > env 文件值 > 字段默认值（pydantic-settings 标准行为；`fc2597e` 验证实测「环境变量优先于 .env」）。
- 字段按注释分 10 组，见 §5 配置项清单。

### 4.3 单例获取（`config.py:110-115`）
- `get_settings()`（`:110-112`）：`@lru_cache` 装饰，进程内只实例化一次 `Settings`。
- 模块级 `settings = get_settings()`（`:115`）：绝大多数消费方直接 `from app.core.config import settings`；`services/event_service.py:16` 是唯一改用 `get_settings()` 调用的消费方（`:93`、`:124`）。因 `lru_cache`，两种方式拿到的是同一实例。

## 5. 输入与输出（配置项清单）

只记录名称、类型、默认值与用途，**不记录任何真实值**（`backend/.env`、`.env.prod` 的实际内容不写入本文档）。

### 应用（`:23-28`）
| 配置项 | 类型 | 默认值 | 用途 / 被谁引用 |
|---|---|---|---|
| `APP_NAME` | str | `"长征运动挑战 API"` | FastAPI title 与健康检查返回（`main.py:55`、`:92`） |
| `API_PREFIX` | str | `"/api"` | 全部 18 个路由模块的统一前缀（`main.py:69`） |
| `DEBUG` | bool | `True` | **backend 代码中无任何 `settings.DEBUG` 引用**（全仓 grep 无命中）；仅作为 env 文件里的环境标识存在 |
| `APP_ENV` | str | `"dev"` | Settings 字段本身**无代码引用**；真正的环境切换靠 `:14` 的 `os.getenv("APP_ENV")`，字段仅为运行期可读的标识 |

### 数据库（`:30-34`）
| 配置项 | 类型 | 默认值 | 用途 / 被谁引用 |
|---|---|---|---|
| `DATABASE_URL` | str | **无默认值（必填）** | 唯一连接串来源；缺失时 pydantic 校验报错、启动即失败（`:31` 注释明确此设计意图）。被 `core/database.py:42`、`:46`、`:50` 引用（打补丁分支判断 + 创建 engine） |

### JWT（`:36-40`）
| 配置项 | 类型 | 默认值 | 用途 / 被谁引用 |
|---|---|---|---|
| `JWT_SECRET` | str | 有内置**开发占位**默认值（非真实密钥，值不录入文档）；生产必须覆盖 | 三类令牌签发与校验的密钥（`core/security.py:19`、`:32`、`:49`、`:56`） |
| `JWT_ALGORITHM` | str | `"HS256"` | 签名算法（`core/security.py` 同上行号） |
| `JWT_EXPIRE_MINUTES` | int | `10080`（7 天） | 小程序用户令牌有效期（`core/security.py:17`） |
| `JWT_ADMIN_EXPIRE_MINUTES` | int | `720`（12 小时） | 管理员令牌（super/user 两类）有效期（`core/security.py:30`、`:47`）；`:40` 注释说明「权限每次请求查库，短时效兜底」 |

### 微信小程序（`:42-53`）
| 配置项 | 类型 | 默认值 | 用途 / 被谁引用 |
|---|---|---|---|
| `WX_APPID` | str | `""`（空） | 小程序 AppID；`core/wx.py:20`、`:26`、`:59`，`services/auth_service.py:46`、`sport_service.py:85`、`:150`、`wechat_service.py:31`、`:38`、`identity_service.py:304`。为空时登录走 mock openid（`:42` 注释） |
| `WX_SECRET` | str | `""`（空） | 小程序 AppSecret（**敏感，值不录入文档**）；引用点与 `WX_APPID` 成对出现（`core/wx.py:20`、`:27`，`auth_service.py:46`，`sport_service.py:85`、`:150`，`wechat_service.py:31`、`:39`） |
| `WX_LOGIN_ALLOW_MOCK` | bool | `False` | 仅限本地自动化测试：已配置凭证时微信换取失败仍回退 mock openid（`auth_service.py:46`）；`:45` 注释明确**生产必须为 false** |
| `WX_WEB_APPID` / `WX_WEB_SECRET` | str | `""`（空） | 微信开放平台网站应用凭证，扫码登录渠道阶段 2 预留（`:48` 注释）；**backend/app 代码中当前无引用**（全仓 grep 仅命中本文件、env 文件与 README/design 文档），与 ARCHITECTURE.md「`wx_web` 通道半成品」结论一致 |
| `WXACODE_ENV_VERSION` | str | `"trial"` | 小程序码环境版本；开发期 trial（体验版），生产发布后改 release（`:52` 注释）。被 `wechat_service.py:65`、`:78` 与 `routes/admin.py:902` 引用 |

### 扫码/绑定有效期（`:55-57`）
| 配置项 | 类型 | 默认值 | 用途 / 被谁引用 |
|---|---|---|---|
| `QR_LOGIN_TTL_SECONDS` | int | `300` | PC 扫码登录会话有效期（秒）；`identity_service.py:50`（写入 `expires_at`）、`routes/admin.py:138`（返回 `expires_in`） |
| `BIND_REQUEST_TTL_SECONDS` | int | `600` | 身份绑定请求有效期（秒）（`:55` 注释）；**backend/app 代码中当前无引用**（全仓 grep 仅命中本文件、env 文件与 README），绑定请求的过期实际由库内 `expires_at` 列判定（`identity_service.get_bind_request:145-160`，`:156-159` 过期即置 expired） |

### 管理后台账号（`:59-61`）
| 配置项 | 类型 | 默认值 | 用途 / 被谁引用 |
|---|---|---|---|
| `ADMIN_USERNAME` | str | `"admin"` | 管理后台账号登录用户名；`routes/admin.py:111`（明文比对） |
| `ADMIN_PASSWORD` | str | `""`（空；**敏感，值不录入文档**） | 管理后台账号登录密码；`routes/admin.py:108`（为空时账号登录 403 禁用、仅允许微信扫码）、`:112`（明文比对）。`06b6313` 起取消默认值 |

### 组织同步（`:63-64`）
| 配置项 | 类型 | 默认值 | 用途 / 被谁引用 |
|---|---|---|---|
| `ORG_SYNC_API_URL` | str | `""`（空） | 组织架构外部同步接口地址，留空时使用内置种子数据（`:63` 注释）；`services/admin_service.py:863` |

### 腾讯云 CloudBase Agent（`:66-73`）
| 配置项 | 类型 | 默认值 | 用途 / 被谁引用 |
|---|---|---|---|
| `CLOUDBASE_ENV_ID` | str | `""`（空） | CloudBase 环境 ID，用于拼接 ACP 地址；`cloudbase_service.py:73` |
| `CLOUDBASE_AGENT_ID` | str | `""`（空） | Agent ID；`cloudbase_service.py:74`，`ai_chat_service.py:242`、`:260`、`:393`、`:401`（用量日志 model 字段） |
| `CLOUDBASE_API_KEY` | str | `""`（空；**敏感，值不录入文档**） | Bearer 鉴权头；`cloudbase_service.py:154`、`:204`（为空直接报配置缺失）。`:67` 注释：仅供后端调用，禁止写入前端代码、接口响应或日志 |
| `CLOUDBASE_AGENT_URL` | str | `""`（空） | 显式 ACP 调用地址；留空时按 `https://{ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/{AGENT_ID}/acp` 拼接（`:71` 注释，实现见 `cloudbase_service.py:70-79`） |
| `CLOUDBASE_TIMEOUT_SECONDS` | int | `180` | 单批调用超时（秒）；`cloudbase_service.py:207` |

### AI 出题策略（`:75-78`）
| 配置项 | 类型 | 默认值 | 用途 / 被谁引用 |
|---|---|---|---|
| `AI_QUESTION_BATCH_SIZE` | int | `10` | 每批请求 Agent 生成的题数；`ai_question_service.py:319`、`:490` |
| `AI_QUESTION_MAX_CONCURRENCY` | int | `3` | 批间并发上限；`ai_question_service.py:223` |
| `AI_QUESTION_MAX_COUNT` | int | `100` | 单次生成/单次保存题数上限；`ai_question_service.py:299`、`:354`、`:638-639` |

### AI 智能中心运行时默认值（`:80-91`）
`:81-82` 注释明确：以下为 env 初始默认，管理端「配置中心」可在 `system_settings` 表逐项覆盖，生效值由 `ai_config_service.get_effective(db)` 合并（**DB 覆盖 > env 默认**）。9 项全部被 `ai_config_service.py:46-54` 的默认值映射表引用：

| 配置项 | 类型 | 默认值 | 用途 |
|---|---|---|---|
| `AI_ENABLED` | bool | `True` | AI 总开关，关闭后所有 AI 接口返回明确提示（`:83` 注释） |
| `AI_CHAT_DAILY_LIMIT` | int | `10` | 普通用户每天模型调用次数上限（北京时间当日） |
| `AI_GLOBAL_DAILY_LIMIT` | int | `2000` | 全站每天模型调用上限（防成本失控） |
| `AI_MAX_INPUT_CHARS` | int | `500` | 单次用户输入最大字符数 |
| `AI_MAX_OUTPUT_TOKENS` | int | `800` | 单次回答 Token 上限（约束约 500 汉字） |
| `AI_REQUEST_TIMEOUT` | int | `60` | 单次对话/讲解调用超时（秒） |
| `AI_MAX_RETRIES` | int | `1` | 可恢复失败的最大重试次数；亦被 `cloudbase_service.py:208` 用作缺省重试次数 |
| `AI_CONTEXT_TURNS` | int | `4` | 对话默认携带的最近有效历史轮数 |
| `AI_KNOWLEDGE_TOP_K` | int | `4` | 检索已发布知识资料的最大条数 |

### 长征活动规则（`:93-99`）
| 配置项 | 类型 | 默认值 | 用途 / 被谁引用 |
|---|---|---|---|
| `STRIDE_M` | float | `0.7` | 平均步长（米），距离(km) = 步数 × 步长 / 1000；`sport_service.py:43` |
| `STREAK_GOAL_STEPS` | int | `5000` | 连续行军每日达标步数；`streak_service.py:77`、`sport_service.py:229` |
| `ACTIVITY_START_DATE` | str | `"2026-09-01"` | 活动起始日，答题「第 N 期」等的基准；`quiz_service.py:53` |
| `QUIZ_QUESTION_SECONDS` | int | `90` | 每题作答时限（秒，服务器时间）；`quiz_service.py:312`、`:375` |
| `QUIZ_ANSWER_GRACE_SECONDS` | int | `2` | 截止后容许的网络延迟（秒），仅用于接收提交；`quiz_service.py:64` |
| `ACTIVITY_MASK_NICKNAME` | bool | `False` | 实时行动态昵称脱敏（需求 §8.5）；`event_service.py:93`、`:124`（经 `get_settings()`） |

### 积分规则 V2.0（`:101-104`）
| 配置项 | 类型 | 默认值 | 用途 / 被谁引用 |
|---|---|---|---|
| `POINTS_WALK_STEPS_PER_POINT` | int | `1000` | 每满多少步得 1 分（不足不计）；`points_service.py:36`、`:51`、`:56`、`:209` |
| `POINTS_QUIZ_PER_CORRECT` | int | `2` | 每答对 1 题得分；`points_service.py:60`、`:210` |
| `POINTS_QUIZ_DAILY_CAP` | int | `10` | 单日答题积分上限；`points_service.py:61`、`:211` |

（历史项 `POINTS_WALK_STEP_CAP`（单日计分步数上限 20000）由 `2f3f333` 引入、`9cb65b8` 删除。）

### 跨域（`:106-107`）
| 配置项 | 类型 | 默认值 | 用途 / 被谁引用 |
|---|---|---|---|
| `CORS_ORIGINS` | List[str] | `["*"]` | CORSMiddleware 允许来源；`main.py:63` |

## 6. 依赖关系
- **依赖**：标准库 `os`、`functools.lru_cache`、`pathlib.Path`、`typing.List`；第三方 `pydantic_settings.BaseSettings / SettingsConfigDict`（`:2-7`）。读取 `backend/.env`（本地开发，默认）或 `backend/.env.prod`（`APP_ENV=prod`）。原模板 `backend/.env.example` 已于 2026-10-17 删除。
- **被依赖（backend/app 内 18 个文件 import 本模块）**：`core/database.py:8`、`core/security.py:7`、`core/wx.py:13`、`main.py`、`api/routes/admin.py`，以及 services 层 13 个模块（`admin_service`、`ai_chat_service`、`ai_config_service`、`ai_question_service`、`auth_service`、`cloudbase_service`、`event_service`（用 `get_settings`）、`identity_service`、`points_service`、`quiz_service`、`sport_service`、`streak_service`、`wechat_service`）。
- 测试脚本（如 `test/s11_sport_sync_werun.py:173-176`、`s19_invite_admission.py:81-83`、`s20_v2_regression.py:303-304`）**直接改写 `settings` 单例属性**来模拟配置状态，用后还原。

## 7. 业务规则
- **加载时机**：`settings` 在模块 import 时即实例化（`:115`），env 文件选择与全部配置解析发生在进程启动最早期；运行期改 env 文件不生效（`lru_cache` + 模块级单例）。
- **必填即失败**：`DATABASE_URL` 无默认值，缺失时启动抛 pydantic 校验错误（`fc2597e` 实测「缺省且无 .env 时抛 missing 校验错误」）。
- **空值即功能门控**：`WX_APPID`/`WX_SECRET` 为空 → 登录 mock openid、微信运动回退模拟步数；`ADMIN_PASSWORD` 为空 → 管理端账号登录禁用（403，仅扫码）；`CLOUDBASE_API_KEY` 为空 → AI 调用报配置缺失；`ORG_SYNC_API_URL` 为空 → 组织同步用内置种子数据。
- **积分/答题/连续行军参数是业务规则的一部分**，与前端展示口径联动（`points_service.py:209-211` 把三个积分参数作为 `rules` 下发给小程序）。

## 8. 修改约束
- **生产必须覆盖的项**（依据代码注释与 `f05531a` 迭代记录「生产库连接串/JWT_SECRET/ADMIN_PASSWORD 为占位符，部署前替换」）：`DATABASE_URL`（必填）、`JWT_SECRET`、`ADMIN_PASSWORD`（不配置则账号登录禁用）、`WX_APPID`/`WX_SECRET`、`CLOUDBASE_API_KEY`（启用 AI 时）；生产还须 `WXACODE_ENV_VERSION=release`（`:52` 注释）、`WX_LOGIN_ALLOW_MOCK=false`（`:45` 注释）。
- **敏感值不得写入文档/前端/日志/接口响应**（`:67` 注释；`.qoder/README.md` §3.14）。
- 新增配置项必须带中文注释与默认值（`backend/AGENTS.md` §5）；`DATABASE_URL` 不得恢复内置默认连接串（`fc2597e` 的整改结论）。
- `APP_ENV` 切换逻辑（`:12-15`）不得改为从 `.env` 读取——文件选择先于 `.env` 解析，改了即失效。
- 改动积分/答题/时限类参数属于业务规则变更，须前后端同步（`backend/AGENTS.md` §4 不变量 4）。

## 9. 当前实现状态
- 已实现：双 env 文件切换、全部 10 组配置项、单例缓存。
- 已知问题（事实性陈述，非缺陷判定）：
  - `DEBUG`、`APP_ENV`（Settings 字段）、`WX_WEB_APPID`、`WX_WEB_SECRET`、`BIND_REQUEST_TTL_SECONDS` 五项**定义了但 backend/app 代码中无引用**（前两项仅作标识；WX_WEB 为阶段 2 预留；BIND_REQUEST_TTL_SECONDS 的配置意图与其无引用现状是否属遗漏——待确认）。
  - `JWT_SECRET` 默认值为开发占位符，若生产忘记覆盖将使用弱密钥（`:37`；`.env.prod` 中为占位符，部署前须替换——是否已替换属部署侧事实，待确认）。
  - `ADMIN_PASSWORD` 以明文存于 env 并在 `routes/admin.py:112` 明文比对，无哈希（现状记录）。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/core/config.py`（15 个提交）与 `docs/迭代记录.md` 对应条目，按时间倒序。

### 2026-10-17
- 需求：AI 智能中心 Phase A（历史助手/路线讲解/答题解析）需要运行时可调参数。
- 修改内容：`1600074` 新增 AI 智能中心 9 项运行时默认值（`AI_ENABLED`、`AI_CHAT_DAILY_LIMIT`、`AI_GLOBAL_DAILY_LIMIT`、`AI_MAX_INPUT_CHARS`、`AI_MAX_OUTPUT_TOKENS`、`AI_REQUEST_TIMEOUT`、`AI_MAX_RETRIES`、`AI_CONTEXT_TURNS`、`AI_KNOWLEDGE_TOP_K`，`:80-91`），可被 `system_settings` DB 覆盖。
- 关联文件：`services/ai_config_service.py`、`services/ai_chat_service.py`、`routes/ai.py`、`routes/ai_admin.py`、`docker/init/021_ai_center.sql`、`022_ai_admin_menus.sql`。
- 测试结果：冒烟 `test/s26_ai_center.py` 47/47（含真实 Agent 调用）；真库校验迁移/表索引/ORM 列 ALL_MATCH（`docs/迭代记录.md`）。

### 2026-10-16
- 需求：① 题库接入 CloudBase Agent AI 出题；② 生产配置与本地配置分离。
- 修改内容：`ea58b6c` 新增 `CLOUDBASE_*` 5 项（`:66-73`）与 `AI_QUESTION_*` 3 项（`:75-78`）；`f05531a` 新增 `APP_ENV` 切换加载（`:9-15`）与 `APP_ENV` 字段（`:28`），`.env`/`.env.prod` 均入库。
- 关联文件：`services/cloudbase_service.py`、`services/ai_question_service.py`、`backend/.env.prod`、根/后端 AGENTS.md、backend/README.md。
- 测试结果：`ea58b6c`：冒烟 `s25_ai_question_generate.py` 16/16、admin `npm run build` 通过、浏览器验收 10 项全通过；`f05531a`：Settings 双模式实测（默认读 .env，`APP_ENV=prod` 读 .env.prod）、SQLite TestClient 冒烟启动正常、build-backend.bat 产物校验通过（`docs/迭代记录.md`）。

### 2026-10-15
- 需求：步行积分口径与「累计运动(步)」统一，取消单日封顶。
- 修改内容：`9cb65b8` 删除 `POINTS_WALK_STEP_CAP` 配置项。
- 关联文件：`services/points_service.py`、前端积分明细页、s20/v2-miniprogram 测试断言。
- 测试结果：S20 26/26（含新边界 25000→25）、S23 13/13、S22 14/14；`node --check` 与 `py_compile` 通过（`docs/迭代记录.md`）。

### 2026-10-13
- 需求：① openGauss 兼容性整改；② 答题逐题限时；③ 积分台账重构（V2.0）。
- 修改内容：`fc2597e` 将 `DATABASE_URL` 改为必填（去掉内置默认连接串，`:30-34`），env 文件路径锚定 `backend/` 目录；`78a12ca` 新增 `QUIZ_QUESTION_SECONDS=90`、`QUIZ_ANSWER_GRACE_SECONDS=2`（`:97-98`）；`2f3f333` 新增积分规则 4 项（含后被删除的 `POINTS_WALK_STEP_CAP`，`:101-104`）。
- 关联文件：`core/database.py`、`backend/.env.example`、`test/s21_opengauss_compat.py`、`services/quiz_service.py`、`services/points_service.py`、`docker/init/017、018` 迁移。
- 测试结果：`fc2597e`：S21 针对本地 openGauss 4/4、TestClient 健康检查 200、S12 11/11；`78a12ca`：s18 21/21、s6/s11/s12/s19 全过、openGauss 并发冒烟通过；`2f3f333`：SQLite 冒烟 20/20、openGauss 回填核对 132 人 111 天差异 0、s11/s18/s19/s6 回归通过（`docs/迭代记录.md`）。

### 2026-10-11
- 需求：V1.0 扫码入驻登录健壮性——已配置微信凭证时换取失败不得回退 mock。
- 修改内容：`67c96b1` 新增 `WX_LOGIN_ALLOW_MOCK`（默认 false，`:45-46`）作为本地测试开关。
- 关联文件：`services/auth_service.py`（`_resolve_openid`）、`services/wechat_service.py`（`get_onboarding_png`）、`routes/admin.py`。
- 测试结果：S13 冒烟 13/13、S12 回归 11/11；真实微信出码与真机扫码待验证（`docs/迭代记录.md`）。

### 2026-10-09
- 需求：① 微信身份关联/扫码登录（迁移 010 配套配置）；② 本地启用管理账号登录与体验版小程序码。
- 修改内容：`06b6313` 新增 `JWT_ADMIN_EXPIRE_MINUTES=720`（`:40`）、`WX_WEB_APPID`/`WX_WEB_SECRET`（`:48-50`）、`QR_LOGIN_TTL_SECONDS=300`/`BIND_REQUEST_TTL_SECONDS=600`（`:55-57`），`ADMIN_PASSWORD` 取消默认值改为空（`:61`）；`587fd5b` 新增 `WXACODE_ENV_VERSION`（默认 `trial`，`:52-53`）。
- 关联文件：`core/security.py`、`services/identity_service.py`、`services/wechat_service.py`、`routes/admin.py`、`docker/init/010_identity_rbac.sql`。
- 测试结果：`06b6313`：database-init 容器成功应用 010、ORM 与 app.main 导入正常；`587fd5b`：TestClient 冒烟 `POST /api/admin/login` 200 + 超管令牌、扫码会话创建正常（`docs/迭代记录.md`）。

### 2026-10-03
- 需求：实时行军动态 P1-1，昵称脱敏开关（需求 §8.5）。
- 修改内容：`17a4d98` 新增 `ACTIVITY_MASK_NICKNAME: bool = False`（`:99`）。
- 关联文件：`services/event_service.py`（`mask_nickname`）、`routes/broadcast.py`、前端首页实时行军卡。
- 测试结果：待确认（`docs/迭代记录.md` 该条目未记录验证字段；相关测试见 `backend/test/p1_activities.py` 与 `test/docs/p1-activities-report.md`）。

### 2026-10-01
- 需求：① 管理后台 API；② 数据库切换 openGauss；③ 统一事件系统与连续行军。
- 修改内容：`337af78` 新增 `ADMIN_USERNAME`/`ADMIN_PASSWORD`（当时密码有非空默认值，后由 `06b6313` 改为空）与 `ORG_SYNC_API_URL`（`:59-64`）；`bceeb26` 将 `DATABASE_URL` 默认值由 SQLite 改为本地 openGauss 连接串（后由 `fc2597e` 改为必填）；`be7e126` 新增 `STRIDE_M`、`STREAK_GOAL_STEPS`、`ACTIVITY_START_DATE`（`:93-96`）。
- 关联文件：`routes/admin.py`、`services/admin_service.py`、`docker/compose.yml`、`services/sport_service.py`、`services/streak_service.py`、`services/quiz_service.py`。
- 测试结果：待确认（`docs/迭代记录.md` 三个条目均只有内容摘要、未记录验证字段）。

### 2026-09-30
- 需求：项目初始化。
- 修改内容：`a94e685` 创建本文件：`Settings`（app/数据库/JWT/微信/CORS 等初始配置项）、`get_settings`、`settings` 单例；env 文件当时为相对路径 `.env`。
- 关联文件：仓库初始代码（backend + frontend）。
- 测试结果：待确认（`docs/迭代记录.md` 该条目未记录验证字段）。
