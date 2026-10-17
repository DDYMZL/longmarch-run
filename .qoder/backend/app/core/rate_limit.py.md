# rate_limit.py

## 1. 文件路径

`backend/app/core/rate_limit.py`（45 行）

## 2. 文件职责

后端唯一的**接口限流实现**：一个进程内滑动窗口计数器 + 4 个预置实例 + 一个把「超限」翻译成 HTTP 429 的调用入口。用于防止管理端账号密码爆破、扫码会话接口被刷、以及邀请码校验/入驻接口被刷。

模块 docstring（`:1-4`）明确了两条前提：**单进程部署适用，多 worker 部署需替换为 Redis**；**key 取客户端 IP**。

## 3. 业务需求

- **管理后台账号密码登录**（`POST /api/admin/login`）：账号密码来自 `settings.ADMIN_USERNAME` / `ADMIN_PASSWORD`，属可爆破的静态凭据，需要限流。来源：提交 `b431e4d`「微信扫码登录与身份关联（批次 2）」中的「接口限流」子项，设计文档 `docs/identity-binding-design.md`（见 `docs/迭代记录.md` 2026-10-09「小程序与 PC 管理后台微信身份关联设计文档」条目，其内容摘要明确列出「安全机制（凭证摘要、限流、撤销即时生效）」）。
- **微信扫码登录的会话创建与轮询**（`POST /api/admin/wechat/qr`、`GET /api/admin/wechat/qr/{qr_id}/status`）：创建会话会调用微信 `getwxacodeunlimit` 接口（有配额），轮询是高频接口，两者都需限流。同上来源。
- **邀请码校验与入驻**（`POST /api/auth/invite/verify`、`POST /api/auth/onboard`）：来源：提交 `afbcba9`「邀请码准入全链路」。`:34` 的注释写明了阈值取舍理由——「邀请码 16 位随机，限流仅防刷；企业出口 NAT 共用 IP 留足余量」，即这里限流**不是**主要的防爆破手段（16 位随机码本身不可枚举），阈值放宽到 60 次/分是为了避免同一企业出口 NAT 下的多名员工互相挤占额度。

## 4. 核心功能

### 4.1 `SlidingWindowLimiter`（`:11-27`）

滑动窗口限流器，类 docstring `:12`：「窗口内超过 max_calls 次即拒绝」。

- `__init__(max_calls, window_seconds)`（`:14-17`）：保存两个阈值，初始化 `self._hits: defaultdict = defaultdict(deque)`（`:17`）—— **key 为限流维度字符串，value 为该 key 的命中时间戳双端队列**。
- `hit(key) -> bool`（`:19-27`），执行顺序严格如下：
  1. `:20` 取 `now = time.time()`（**Unix 秒级浮点时间戳，非 monotonic**）。
  2. `:21` 取该 key 的队列（`defaultdict` 会在首次访问时**自动创建空 deque**）。
  3. `:22-23` 从队首弹出所有 `now - queue[0] > window_seconds` 的过期记录 —— 这是「滑动」的实现方式：窗口右边界是当前时刻，左边界是 `now - window_seconds`，逐条淘汰而非整桶重置。
  4. `:24-25` 若淘汰后 `len(queue) >= max_calls`，**返回 `False` 且不写入本次命中**。
  5. `:26-27` 否则 `queue.append(now)` 并返回 `True`。

**由此代码直接推出的行为特征**（非推测）：

- **被拒绝的请求不占用额度、也不延长窗口**（`:24-25` 提前 return，未到 `:26`）。即触发限流后持续打请求，不会让解封时间被不断推后；窗口从**最后一次被放行的请求**起算。
- 淘汰条件是**严格大于** `window_seconds`（`:22`），恰好等于窗口长度的记录仍算在窗口内。
- **返回 `False` 时不区分「刚刚超限」与「已超限很久」**，调用方拿不到剩余等待时间，故 429 响应**不含 `Retry-After` 头**（`:45` 只设 `status_code` 与 `detail`）。
- `_hits` **永不清理空队列**：`:21` 的 `defaultdict` 访问会为每个出现过的 IP 建一个 deque，`:22-23` 只清空队列内容、**不删除 key**。长期运行下 key 数量单调增长（每个 key 是一个空 deque，约数十字节量级），属内存缓慢增长，无自动回收。

### 4.2 四个预置实例（`:30-35`）

| 行号 | 实例 | `max_calls` | `window_seconds` | 注释给出的语义 |
|---|---|---|---|---|
| `:31` | `login_limiter` | 10 | 60 | 账号登录 10 次/分/IP（注释在 `:30`） |
| `:32` | `qr_create_limiter` | 10 | 60 | 扫码会话创建 10 次/分/IP（注释在 `:30`） |
| `:33` | `qr_poll_limiter` | 60 | 60 | 轮询 60 次/分/IP（注释在 `:30`） |
| `:35` | `invite_limiter` | 60 | 60 | 邀请码校验/入驻 60 次/分/IP（注释在 `:34`） |

四个实例都是**模块级单例**，在 `import app.core.rate_limit` 时创建，与 FastAPI 应用同生命周期。

### 4.3 `client_ip(request)`（`:38-39`）

单行实现：`return request.client.host if request.client else "unknown"`。

- 取的是 **TCP 直连对端地址**（Starlette 的 `request.client`），**不解析 `X-Forwarded-For` / `X-Real-IP` 头**。
- `request.client` 为 `None` 时（如非 HTTP 传输）统一归到字面量 `"unknown"` 这一个 key —— 所有此类请求**共用同一份额度**。

### 4.4 `require_rate(limiter, request, detail)`（`:42-45`）

调用入口，docstring `:43`「超限时抛 429」。实现：`if not limiter.hit(client_ip(request)): raise HTTPException(status_code=429, detail=detail)`。

- **不是 FastAPI 依赖（无 `Depends` 包装）**，而是在路由函数体内**手动调用的普通函数**，因此限流检查发生在路由函数体的第一行、在参数校验之后、在任何数据库操作之前。
- `detail` 由调用方传入，本文件不提供默认文案。

## 5. 输入与输出

| 名称 | 入参 | 返回 / 副作用 | 异常 |
|---|---|---|---|
| `SlidingWindowLimiter.__init__` | `max_calls: int`、`window_seconds: int` | 无返回；初始化 `_hits` | 无（不校验正负；`max_calls=0` 会导致永远拒绝，`window_seconds=0` 会导致每次调用都清空历史即等于不限流） |
| `SlidingWindowLimiter.hit` | `key: str` | `bool`：`True` = 放行并已记账，`False` = 拒绝且未记账；副作用为修改 `self._hits[key]` | 无 |
| `client_ip` | `request: Request` | `str`（IP 字面量或 `"unknown"`） | 无 |
| `require_rate` | `limiter`、`request`、`detail: str` | `None`（放行时无副作用返回） | **`HTTPException(status_code=429, detail=<调用方文案>)`** |

**唯一的错误码是 429**，本文件不产生其它状态码。429 的响应体为 FastAPI 默认的 `{"detail": "<文案>"}`（项目无统一响应信封，见 `.qoder/ARCHITECTURE.md` §4.1）。

**实际使用的 3 种 detail 文案**（grep 实测，均为中文、面向用户）：

| 文案 | 使用位置 |
|---|---|
| `登录尝试过于频繁，请稍后再试` | `admin.py:107` |
| `操作过于频繁，请稍后再试` | `admin.py:129`、`auth.py:50`、`auth.py:69` |
| `轮询过于频繁，请稍后再试` | `admin.py:149` |

## 6. 依赖关系

**上游依赖**：标准库 `time`（`:5`）、`collections.defaultdict` / `deque`（`:6`）；第三方 `fastapi.HTTPException` / `fastapi.Request`（`:8`）。**不 import 项目内任何模块**，不接触数据库、不使用 Redis，符合 `backend/AGENTS.md` §3.1「core 不 import 业务模块」。

**被谁依赖 —— 全部 5 个真实调用点**（`grep -rn "require_rate" backend/app` 实测，无遗漏）：

| 调用点 | HTTP 方法 + 完整路径 | 使用的实例 | 路由函数 |
|---|---|---|---|
| `app/api/routes/admin.py:107` | `POST /api/admin/login` | `login_limiter` | `login`（`:101-102` 装饰器与签名，签名含 `request: Request`） |
| `app/api/routes/admin.py:129` | `POST /api/admin/wechat/qr` | `qr_create_limiter` | `create_wechat_qr`（路径字面量在 `:120`，签名在 `:124`） |
| `app/api/routes/admin.py:149` | `GET /api/admin/wechat/qr/{qr_id}/status` | `qr_poll_limiter` | `poll_wechat_qr`（路径字面量在 `:143`，签名在 `:147`） |
| `app/api/routes/auth.py:50` | `POST /api/auth/invite/verify` | `invite_limiter` | `verify_invite`（`:47-48`） |
| `app/api/routes/auth.py:69` | `POST /api/auth/onboard` | `invite_limiter` | `onboard`（`:63-64`） |

导入方为 `admin.py:16` 与 `auth.py:6`（均为 `from app.core import rate_limit`）。

**测试脚本调用点**（按 `.qoder/README.md` §4 不逐个建档）：`test/s19_invite_admission.py:60`（import）、`:91`（`rate_limit.invite_limiter._hits.clear()`）；`test/s19_invite_concurrency_pg.py:24`、`:66`（同样直接清 `_hits`）。两处测试都**绕过公开 API 直接操作私有字段 `_hits`** 来重置限流状态。

**明确未被限流保护的接口**（grep 确认 `require_rate` 在以下文件中零命中）：

| 接口 | 说明 |
|---|---|
| `POST /api/auth/login`（`auth.py:29-30`） | 小程序微信登录。处理函数签名**不含 `request: Request`**，无法直接接入现有 `require_rate`。其成本由微信 `code2session` 调用次数间接约束 |
| `POST /api/auth/qr/info`（`identity.py:27`）、`POST /api/auth/qr/confirm`（`identity.py:54`） | 小程序侧扫码场景查询与确认/取消。`identity.py` 全文无 `rate_limit` 引用 |
| `app/api/routes/ai.py` 全部接口 | **`.qoder/ARCHITECTURE.md` §10.1 称 4 个实例「分别用于登录、邀请码校验、AI 问答等敏感入口」，此说法与代码不符**：`ai.py` 无 `require_rate` 调用。AI 侧另有一套**按用户的日调用额度**机制（`services/ai_usage_service.py:20-21` 定义 `AiLimitError`，`routes/ai.py:47` 映射为 429；`AiDisabledError` 在 `routes/ai.py:45` 映射为 403），与本文件的按 IP 滑动窗口是两套独立机制 |

**数据库表**：无。限流状态完全不落库，重启即清零。

## 7. 业务规则

1. **限流维度只有 IP**（`:38-39` + `:44`），不区分用户、不区分令牌。同一 IP 下的所有调用方共享额度；未登录接口（本文件覆盖的 5 个接口全部无需登录或仅需 body 参数）也只能按 IP 限流。
2. **判定与记账在同一步完成**：`hit()` 返回 `True` 即已记账，不存在「先查后写」的两段式调用，因此不会漏计。
3. **被拒绝的请求不消耗额度**（见 §4.1），限流不会因持续攻击而无限延长封锁期。
4. **限流先于业务**：5 个调用点全部把 `require_rate` 放在路由函数体首行，先于 `settings.ADMIN_PASSWORD` 校验（`admin.py:108`）、先于任何 `db` 查询与事务。因此触发限流时**不产生任何数据库写入、不产生审计日志**。
5. **限流与鉴权是独立机制**：本文件不校验令牌；令牌校验在 `api/deps.py`。429（限流）与 401/403（鉴权）不会互相替代。
6. **进程内计数**：4 个实例的 `_hits` 是模块级变量，**多 worker / 多副本部署下每个进程各算一份，实际阈值被放大 N 倍**；进程重启后计数清零。这两条都写在 docstring `:1` 里，是已知且被接受的取舍（当前单进程部署，见 `.qoder/ARCHITECTURE.md` §15 第 1 项）。

## 8. 修改约束

- **不得把 `require_rate` 改成 FastAPI 依赖（`Depends`）而不改全部 5 个调用点**：当前是函数体内手动调用，改为依赖会改变执行时机（依赖在参数校验前执行），且 `detail` 文案需要按接口区分，不能简单共用一个依赖。
- **新增受保护接口时，路由函数签名必须显式加 `request: Request`**（参照 `auth.py:48`、`admin.py:102`），否则拿不到客户端地址。
- **替换为 Redis 实现时必须保留 `SlidingWindowLimiter.hit(key) -> bool` 的语义**（返回 `False` 时不记账），否则「拒绝不延长窗口」这一现有行为会变化。两个 s19 测试脚本直接访问 `_hits.clear()`，替换存储后这两处需同步改造。
- **`client_ip` 若改为读取 `X-Forwarded-For`，必须同时确认反代链路可信**：生产为 nginx → `127.0.0.1:8010`（`.qoder/ARCHITECTURE.md` §12.2），nginx 配置文件不在本仓库。当前实现只取 TCP 对端地址，**因此生产环境下 `request.client.host` 很可能是 nginx 的回环地址，导致全部客户端共用一个限流 key（限流退化为全局阈值）**。这一推论成立与否取决于 uvicorn 是否开启 `--proxy-headers` 以及 nginx 是否设置 `proxy_set_header X-Real-IP`；**生产实际启动命令与 nginx 配置均不在仓库内，待确认**。
- **`core` 层禁止 import 业务模块**（`backend/AGENTS.md` §3.1）；本文件当前仅依赖标准库与 fastapi，新增函数须保持。
- **阈值调整需同步 `:30` / `:34` 的注释**：注释里写死了具体数值（「10 次/分/IP」「60 次/分/IP」），改参数不改注释会造成文档与代码不一致。
- **429 是本文件产生的唯一状态码**（`.qoder/ARCHITECTURE.md` §4.3 的状态码表已登记，依据栏即写 `core/rate_limit.py`）。注意项目内**另有一处 429** 来自 `app/api/routes/ai.py:47`（`AiLimitError` → AI 日调用限额，按用户维度），两者语义不同，排查 429 时须先看 `detail` 文案区分来源。

## 9. 当前实现状态

**已实现**：

- 滑动窗口算法（真滑动，非固定桶）：`SlidingWindowLimiter`（`:11-27`）。
- 4 个预置实例，覆盖 5 个敏感接口（管理端登录、扫码会话创建、扫码状态轮询、邀请码校验、邀请码入驻）。
- 统一的 429 出口 `require_rate`（`:42-45`）。
- 全部 4 个实例**均有真实调用者**，无死代码；`login_limiter` / `qr_create_limiter` / `qr_poll_limiter` 各 1 处，`invite_limiter` 2 处。

**存在问题 / 已知局限**：

1. **进程内内存态**（docstring `:1` 自述）：多 worker 部署阈值放大 N 倍；重启清零。当前单进程部署未暴露。
2. **`_hits` 的 key 永不回收**（`:21` 的 `defaultdict` 建 key，`:22-23` 只清内容不删 key）：长期运行下 key 数随出现过的 IP 数单调增长。单条开销小，但无上限、无 TTL 清理。
3. **`hit()` 无锁**：本文件的调用方全部是 `def`（同步）路由，FastAPI 会把它们放到线程池执行，故 `_hits` 会被多线程并发访问。`deque` 的单次 `append` / `popleft` 在 CPython 下是原子的，但 `:24` 的 `len()` 判定与 `:26` 的 `append` 之间**没有互斥保护**，理论上高并发同 key 时可能放行略超 `max_calls` 的请求。属限流器常见的宽松实现，代码中无注释说明是否为有意取舍（**待确认**）。
4. **使用 `time.time()` 而非 `time.monotonic()`**（`:20`）：系统时钟被回拨/跳变时窗口计算会失真（时钟回拨会让旧记录看起来「未过期」而长期占额度）。生产是否有 NTP 校时导致的实际影响**待确认**。
5. **429 响应不含 `Retry-After` 头**，客户端无法得知何时可重试；小程序与管理后台侧也未针对 429 做专门 UI 分支（AI 聊天页有「429 额度用尽」提示条，但那是 AI 日额度、非本文件产生）。
6. **反代场景下 IP 维度可能失效**（详见 §8 第 4 条），生产实际表现**待确认**。
7. **文档滞后**：`.qoder/ARCHITECTURE.md` §10.1 把 AI 问答列为本文件的服务对象，与代码不符（详见 §6）。

**待开发**：

- **Redis 集中式限流**：docstring `:1` 与 `backend/test/docs/s19-invite-admission-report.md:86` 均写明「多副本部署需换集中式限流器（Redis 等）」，当前**未实施**，项目也未引入 Redis（`.qoder/ARCHITECTURE.md` §6.5）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- backend/app/core/rate_limit.py`（2 条提交，全部列出），验证结论对照 `docs/迭代记录.md`。

### 2026-10-12

- 需求：邀请码准入全链路（V2.0 前置的安全加固）—— 小程序改为「扫邀请码准入」，需要防止 `/api/auth/invite/verify` 与 `/api/auth/onboard` 被刷。
- 修改内容：提交 `afbcba9`。新增 `invite_limiter = SlidingWindowLimiter(max_calls=60, window_seconds=60)`（`:35`）及其阈值取舍注释（`:34`）；模块 docstring `:3` 由「仅用于管理端登录与扫码接口的防爆破/防刷」扩为「仅用于管理端登录、扫码接口与邀请码入驻接口的防爆破/防刷」。文件由 43 行增至 45 行（当前版本）。**`SlidingWindowLimiter` 算法与 `client_ip` / `require_rate` 未改动。**
- 关联文件：`app/api/routes/auth.py`（`:50`、`:69` 两个新调用点）、`app/services/invite_service.py`、`app/services/auth_service.py`、`docker/init/015_invite_admission.sql`、`admin/src/views/InvitesView.vue`、`frontend/pages/onboard/`、`frontend/services/auth.js`。
- 测试结果：`backend/test/s19_invite_admission.py` 功能/权限/脱敏 25/25 通过；`backend/test/s19_invite_concurrency_pg.py` 真实 openGauss 并发 3/3 通过；报告 `backend/test/docs/s19-invite-admission-report.md`（其 `:15` 记录了 `invite_limiter` 60s/60 次/IP，`:86` 记录了「进程内滑动窗口，多副本部署需换集中式限流器」）。（来源：提交信息正文 + `docs/迭代记录.md` 2026-10-12 条目）

### 2026-10-09

- 需求：微信扫码登录与身份关联（批次 2）—— 管理端账号密码登录可被爆破，扫码会话创建会消耗微信接口配额，轮询是高频接口，三者都需要限流。
- 修改内容：提交 `b431e4d`。**新建文件**，43 行：`SlidingWindowLimiter` 类（`__init__` + `hit`）、`login_limiter` / `qr_create_limiter` / `qr_poll_limiter` 三个实例、`client_ip`、`require_rate`。算法与实例阈值自建立至今**未变**。
- 关联文件：`app/api/routes/admin.py`（`:107`、`:129`、`:149` 三个调用点）、`app/api/routes/identity.py`、`app/services/identity_service.py`、`app/core/security.py`（管理员令牌 `typ` 区分）、`app/api/deps.py`、`docker/init/010_*.sql`。
- 测试结果：S8 集成测试 23/23 通过（`backend/test/s8_identity_admin.py`，报告 `backend/test/docs/s8-identity-admin.md`）。（来源：`docs/迭代记录.md` 2026-10-09「微信扫码登录与身份关联后端」条目的「验证」字段）
