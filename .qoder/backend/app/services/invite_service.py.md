# invite_service.py

## 1. 文件路径
`backend/app/services/invite_service.py`（241 行）

> **引用约定**：本文中所有**代码**引用一律为「仓库根相对路径 + 行号」（如 `backend/app/api/routes/admin.py:877`）；本文件自身的行号简写为 `:NN`。
> 对 `.qoder/PROJECT.md`、`.qoder/ARCHITECTURE.md`、`.qoder/REQUIREMENTS.md`、`.qoder/decisions/README.md`、`docs/迭代记录.md` 这几份**总览/台账类文档**，本文只给「路径 + 章节号/条目号/条目标题」而**不给行号**——编写期间实测这些文件正被并发修订、行号发生过整体位移（例如 `docs/迭代记录.md` 中同一提交条目在数十分钟内位移 6 行，`.qoder/PROJECT.md` 的「已知问题」表位移 2 行），写死行号会立刻失效并误导读者。对**不会变动的历史归档件**（如 `docs/身份绑定与自动登录改造分析报告.md`、`backend/test/docs/*.md` 测试报告）仍保留行号。

## 2. 文件职责
入驻邀请码服务。模块 docstring（`:1-6`）自述三条规则，本文件的全部实现都围绕它们展开：

1. 邀请码**只决定「首次入驻」资格**——已入驻用户登录不再校验原邀请码，过期/停用/用满都不影响存量用户（`:3`）。
2. 核销使用**带全部有效性条件的单条 UPDATE**，按影响行数判定成功，并发下不会超发（`:4`）。
3. 邀请码属于**入驻凭证，不写入日志与审计明细**，审计只记 id 与名称（`:5`）。

代码上分三段（`:110` 的 `# ---------------- 管理端维护 ----------------` 是显式分隔注释）：

| 段 | 行号 | 职责 |
|---|---|---|
| 常量与异常 | `:19-30` | 码字符集/长度、scene 前缀、格式正则、用户状态常量、`InviteError` |
| 生成与入驻校验（小程序侧） | `:33-107` | `generate_code`、`scene_of`、`_check_usable`、`get_usable`、`_ensure_in_scope`/`ensure_org_in_scope`、`consume`、`user_scope_org`/`check_user_org_scope` |
| 管理端维护 | `:111-241` | `_org_names`、`_status_of`、`to_out`、`list_invites`、`_validate_fields`、`_invite_or_error`、`create_invite`、`update_invite`、`get_invite`、`set_user_status` |

**本文件不负责**（避免误读函数名）：
- **建号与签发 Token**：在 `backend/app/services/auth_service.py:92-155`（`onboard`）。本文件的 `consume` **不提交事务**（`:78` docstring 明写「不提交」），由 `onboard` 统一 commit。
- **每请求断权**：停用账号的 403 + `X-Account-Status: disabled` 在 `backend/app/api/deps.py:46-53`；WebSocket 握手 4403 在 `backend/app/api/routes/ws.py:46-50`。二者都只是**读本文件导出的 `STATUS_ACTIVE` 常量**（`:24`），判定逻辑不在本文件。
- **小程序码图片**：`backend/app/services/wechat_service.py:76-84`（`get_invite_image`，按 `(WXACODE_ENV_VERSION, scene)` 进程内缓存）；落地页常量 `ONBOARD_PAGE = "pages/launch/launch"` 在 `backend/app/services/wechat_service.py:19`。
- **表结构与 ORM**：`invite_codes` 建表在 `docker/init/015_invite_admission.sql:7-21`，ORM 映射在 `backend/app/models/models.py:208-228`。
- **人员授权页的「邀请码来源」列**：`backend/app/services/access_service.py:160-165` 直接查 `InviteCode.id/name`，**不经本文件**。

## 3. 业务需求
- **入驻与邀请码**：`.qoder/REQUIREMENTS.md` §2.2「入驻与邀请码 — 已实现」共 10 行规则表，其中「邀请码格式」「scene 格式」「核销方式」「一次性语义」「组织越界」「敏感信息约束」6 行直接以本文件为依据。
- **准入模型**：`.qoder/PROJECT.md` §1「项目基本信息」表的「目标用户」行——「企业内部员工（须持管理后台签发的邀请码扫码入驻，未入驻者不建号、不发 Token）」；后台「入驻邀请码（含小程序码）」页见 `.qoder/PROJECT.md` §7「已上线功能 · 管理后台（11 菜单）」段。
- **架构口径（回指，不重复正文）**：`.qoder/ARCHITECTURE.md` §5.2「小程序用户鉴权链」、§4.6「准入控制通过响应头传递」、§7「微信能力集成」的 scene 前缀语义段、§9.4「事务边界（不统一，须知悉）」、§10.1「限流」、§10.2「审计」。
- **已登记决策（回指）**：`.qoder/decisions/README.md` 索引表中的四行——「准入控制走 HTTP 响应头」、「并发控制用**条件 UPDATE + `with_for_update()` 行锁**，不用乐观锁版本号」、「邀请码**不写入日志与审计明细**」、「邀请码**只决定首次入驻资格**」。**注意后三行对本文件的行号引用整体偏大 1 行，且「行锁」一行的结论对本文件并不成立**，见 §9.4「文档偏差」。
- **交付批次**：`docs/迭代记录.md` 2026-10-12「邀请码准入全链路（功能开发/安全加固）」，提交 `afbcba9`。该批次同时交付后端迁移 `015`、管理端「入驻邀请码」页与账号启停、小程序启动页三态与 `pages/onboard`。
- **命名待确认**：口头/任务口径中的「V1.1 准入优先闭环」在仓库文档中**无此措辞**（grep `准入优先`、`优先闭环` 全仓 `.md` 无命中）。`docs/迭代记录.md` 中出现的「V1.1 功能一」指的是**题库 Excel 模板下载与批量导入**，与邀请码无关。本文一律使用仓库内有据可查的名称「邀请码准入」。

## 4. 核心功能

### 4.1 常量与异常（`:19-30`）
| 名称 | 行号 | 值 / 说明 |
|---|---|---|
| `CODE_ALPHABET` | `:19` | `string.ascii_letters + string.digits`，即大小写字母 + 数字，共 **62** 个字符 |
| `CODE_LENGTH` | `:20` | `16`。码空间 62^16 |
| `SCENE_PREFIX` | `:21` | `"i="`。小程序码 scene 形如 `i=<code>`，前端解析正则见 `frontend/pages/launch/launch.js:25-35`（回指 `.qoder/ARCHITECTURE.md` §7 的 scene 前缀语义段） |
| `_CODE_PATTERN` | `:22` | `^[A-Za-z0-9]{1,32}$`。上限 32 对应微信 scene 长度限制（`docker/init/015_invite_admission.sql:5` 注释明写） |
| `STATUS_ACTIVE` | `:24` | `"active"`。**跨模块协议常量**，被 `backend/app/services/auth_service.py:81`、`backend/app/services/auth_service.py:87`、`backend/app/services/auth_service.py:132`、`backend/app/api/deps.py:48`、`backend/app/api/routes/ws.py:46` 直接引用 |
| `STATUS_DISABLED` | `:25` | `"disabled"`。**本文件内仅在 `USER_STATUSES` 元组中出现**（`:26`）；路由层的 `X-Account-Status: disabled` 头是硬编码字符串（`backend/app/api/deps.py:52`），并未引用本常量 |
| `USER_STATUSES` | `:26` | `(STATUS_ACTIVE, STATUS_DISABLED)`，`set_user_status` 的白名单（`:227`） |
| `InviteError(ValueError)` | `:29-30` | 邀请码不可用于入驻（无效/停用/过期/用满/组织越界）。**继承 `ValueError`**，因此路由层可以只 `except ValueError` 兜住它（`backend/app/api/routes/auth.py:81-82`）；需要区分语义时再单独 `except InviteError`（`backend/app/api/routes/auth.py:53`、`backend/app/api/routes/org.py:72`） |

### 4.2 生成与 scene 拼装（`:33-38`）
- `generate_code()`（`:33-34`）：`"".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))`。用 `secrets` 而非 `random`，属密码学安全随机源。**不查库、不重试**——唯一性由 `invite_codes.code` 的 UNIQUE 约束兜底（`docker/init/015_invite_admission.sql:21`、`backend/app/models/models.py:218`）。
- `scene_of(code)`（`:37-38`）：返回 `SCENE_PREFIX + code`，即 `i=<code>`。纯字符串拼接，**不校验 code 格式**。调用方 `backend/app/api/routes/admin.py:896` 传入的是刚从库里取出的 `invite.code`。

### 4.3 入驻校验（小程序侧，`:41-107`）

#### `_check_usable(invite, now)`（`:41-50`）
四道判定，**按固定顺序短路**，顺序直接决定用户看到哪条文案：

| 顺序 | 行号 | 条件 | 抛出文案 |
|---|---|---|---|
| 1 | `:42-43` | `invite is None` | 邀请码无效 |
| 2 | `:44-45` | `not invite.is_enabled` | 邀请码已停用 |
| 3 | `:46-47` | `expires_at is not None and expires_at <= now` | 邀请码已过期 |
| 4 | `:48-49` | `max_uses is not None and used_count >= max_uses` | 邀请码使用次数已满 |

全部通过返回 `invite` 本身（`:50`）。`expires_at`/`max_uses` 为 `None` 分别表示**永不过期**/**不限次数**（`docker/init/015_invite_admission.sql:6`）。

#### `get_usable(db, code, now=None)`（`:53-61`）
按码取可用邀请码，**不核销**。docstring `:54` 明写「格式非法与不存在同样返回『邀请码无效』」——这是**有意的枚举防暴破设计**：正则不匹配（`:58`）时直接把 `invite` 置 `None`，连查询都不发。入参先 `strip()`（`:55`），默认时间 `datetime.utcnow()`（`:61`）；调用方也可显式传入统一的 `now`（`backend/app/services/auth_service.py:111`），以保证同一次入驻流程内「校验」与「核销」用同一时间基准。

#### `_ensure_in_scope(db, scope_org_id, org_id)`（`:64-70`）与 `ensure_org_in_scope(db, invite, org_id)`（`:73-74`）
docstring `:65`：「组织须存在；限定范围时另要求组织位于范围根的子树内（含自身）」。实现方式是**回溯祖先链**而非展开子树：调 `org_service.get_path(db, org_id)`（`:66`，`backend/app/services/org_service.py:59-69`，逐级向上查、环路保护 32 层）得到从顶级到该组织的 `[{id, name}]`，取 id 集合。

- `path_ids` 为空 → `InviteError("所选组织不存在")`（`:67-68`）
- `scope_org_id is not None and scope_org_id not in path_ids` → `InviteError("所选组织不在邀请码允许的范围内")`（`:69-70`）
- `scope_org_id is None`（通用码）→ 只校验组织存在性，**不限范围**

`ensure_org_in_scope` 只是把 `invite.org_id` 传进去的一层薄封装，供入驻流程调用（`backend/app/services/auth_service.py:112`）。

**查询次数**：`get_path` 是「每层一次 `get_org`」，故本函数的查询数 = 目标组织的层级深度（≤32）。这与 `org_service.subtree_org_ids`（整表一次加载 + 内存遍历）口径不同，但语义等价且无需加载全表。

#### `consume(db, invite_id, now)`（`:77-90`）——并发核销的唯一写入点
docstring `:78`：「原子核销一次（**不提交**）：有效性条件全部写在 WHERE 中，影响 1 行即成功。」

```
update(InviteCode)
  .where(id == invite_id,
         is_enabled IS TRUE,
         (max_uses IS NULL OR used_count < max_uses),
         (expires_at IS NULL OR expires_at > now))
  .values(used_count = used_count + 1)
  .execution_options(synchronize_session=False)
```
（`:79-89`，条件原文见 `:82-85`，自增见 `:87`，返回 `result.rowcount == 1` 见 `:90`）

三点必须注意：
1. `used_count = used_count + 1` 是 **SQL 侧表达式自增**，不是「读出来 +1 写回去」，因此不存在读改写竞态。
2. **没有 `with_for_update()` 行锁，也不需要**：正确性完全依赖数据库对同一行 UPDATE 的串行化——后到的事务会阻塞到先到的事务提交，然后重新用**最新行值**评估 WHERE，此时 `used_count < max_uses` 已不成立，`rowcount` 为 0。`grep -c with_for_update` 本文件结果为 **0**。（这与 `.qoder/decisions/README.md`「并发控制用条件 UPDATE + `with_for_update()` 行锁」一行把本文件列为依据之一不符，见 §9.4「文档偏差」。）
3. `synchronize_session=False`（`:88`）：不回写 ORM 会话中的对象状态，因此调用方手里已加载的 `InviteCode` 实例的 `used_count` **仍是旧值**，需要重新查询才能看到新值。

**唯一调用点**：`backend/app/services/auth_service.py:114`。

#### `user_scope_org(db, user)`（`:93-100`）与 `check_user_org_scope(db, user, org_id)`（`:103-107`）
- `user_scope_org`：docstring `:94`「用户可选组织范围的根（专属邀请码入驻用户）；历史用户与通用码用户返回 `None`」。`user.invite_code_id is None` 直接返回 `None`（`:95-96`，即 015 迁移里回填的「历史用户」，见 `docker/init/015_invite_admission.sql:24`、`docker/init/015_invite_admission.sql:26`）；否则**只查 `InviteCode.org_id` 一列**（`:97-99`，用 `.scalar()`），`org_id` 非空再 `org_service.get_org` 取组织对象（`:100`）。共 1~2 次查询。
- `check_user_org_scope`：docstring `:104`「已入驻用户改选组织时沿用其入驻邀请码的组织范围（历史用户不受限）」。`scope is None` 时**直接放行**（`:106`），非 `None` 则复用 `_ensure_in_scope`（`:107`）。调用点 `backend/app/api/routes/org.py:71`。

**注意**：范围来自**当前**邀请码的 `org_id`，不是入驻时快照。管理端改了邀请码的 `org_id`，已入驻用户的可选范围随之改变（见 §9 已知问题 2）。

### 4.4 管理端维护（`:111-241`）

#### `_org_names(db, org_ids)`（`:111-116`）
批量把组织 id 集合换成 `{id: name}`。空集合直接返回 `{}`（`:112-113`），否则一次 `IN` 查询（`:114-116`）。**这是本文件唯一的去 N+1 手段**：`list_invites` 对整页只查一次组织名（`:162`）。

#### `_status_of(invite, now)`（`:119-128`）
把 `_check_usable` 的异常翻译成管理端展示用的状态串：

| 返回值 | 判定 | 行号 |
|---|---|---|
| `"active"` | `_check_usable` 未抛异常 | `:120-121`、`:128` |
| `"disabled"` | 抛异常且 `not is_enabled` | `:123-124` |
| `"expired"` | 抛异常且 `expires_at <= now` | `:125-126` |
| `"exhausted"` | 抛异常且以上都不成立（即只剩「用满」一种可能） | `:127` |

**优先级为 disabled > expired > exhausted**：一个既停用又过期的码显示 `disabled`。四个字符串与 `backend/app/schemas/schemas.py:880` 的 docstring 一一对应，管理端据此渲染标签。这四个状态串**没有定义为模块常量**（与 `STATUS_ACTIVE` 不同），是裸字面量。

#### `to_out(invite, org_name, now=None)`（`:131-146`）
组装管理端出参 dict，共 **13 个字段**：`id`、`code`（`:134`，**明文原码**）、`name`、`remark`、`org_id`、`org_name`、`max_uses`、`used_count`、`expires_at`、`is_enabled`、`status`（`:143`，`now` 缺省取 `datetime.utcnow()`）、`created_by`、`created_at`。字段与 `backend/app/schemas/schemas.py:879-894`（`AdminInviteOut`）逐一对应；`org_name` 由调用方传入（因为要批量查），**不在本函数内查库**。

#### `list_invites(db, page, page_size, keyword="")`（`:149-164`）
返回 `(total, [dict])`。

- 关键字过滤：**只匹配 `name`**，`icontains(keyword, autoescape=True)`（`:153-154`）。`autoescape=True` 转义 `%`/`_` 通配符，防 LIKE 注入。**不搜 `code`、不搜 `remark`**（见 §9 已知问题 4）。
- 计数与取页是**两条 SQL**：`query.count()`（`:155`）+ `ORDER BY id DESC` 加 `offset/limit`（`:156-161`）。排序键为 `id` 倒序（新建在前）。
- 组织名批量查一次（`:162`）。
- **整页共用同一个 `now`**（`:163`），因此同一页内各行的 `status` 判定基准一致，不会出现「同页两个相同过期时间的码状态不同」。
- 总查询数：**3**（count + 分页 + 组织名），与页大小无关。

#### `_validate_fields(db, org_id, max_uses)`（`:167-171`）
两条校验，均抛 **`ValueError`**（不是 `InviteError`）：`org_id` 非空但组织不存在 → 「组织不存在」（`:168-169`）；`max_uses` 非空且 `< 1` → 「使用次数上限须大于 0」（`:170-171`）。后者是对 Pydantic `Field(None, ge=1)`（`backend/app/schemas/schemas.py:917`、`backend/app/schemas/schemas.py:926`）的**服务层重复兜底**，保证直接调服务（如测试脚本）时同样受约束。

#### `_invite_or_error(db, invite_id)`（`:174-178`）
按 id 取邀请码，不存在抛 `ValueError("邀请码不存在")`。`update_invite`（`:201`）与 `get_invite`（`:220`）共用。

#### `create_invite(db, fields, actor_type, actor_id, actor_name)`（`:181-194`）
1. `_validate_fields`（`:184`）
2. `InviteCode(code=generate_code(), created_by=actor_name, **fields)`（`:185`）——**码由服务端生成，不接受入参**；`created_by` 存操作人用户名（`backend/app/api/routes/admin.py:853` 传 `admin.username`）
3. `db.add` + `db.flush()`（`:186-187`）——flush 是为了拿到自增 `invite.id` 供审计使用
4. 审计 `invite.create`，detail 仅 `{invite_id, name}`（`:188-191`），`target_user_id=None`
5. `db.commit()`（`:192`）、`db.refresh(invite)`（`:193`）
6. 返回 `to_out(...)`，组织名单独再查一次（`:194`）

**没有码冲突重试**：62^16 空间下碰撞概率可忽略，但真撞上会抛 `IntegrityError`，而路由层只 `except ValueError`（`backend/app/api/routes/admin.py:855-856`），结果是 **500**（见 §9 已知问题 3）。

#### `update_invite(db, invite_id, fields, actor_type, actor_id)`（`:197-216`）
docstring `:200`：「部分更新（名称/备注/组织/上限/有效期/启停）；上限不得低于已使用次数。」

1. `_invite_or_error`（`:201`）
2. **合并后**再校验：`org_id = fields.get("org_id", invite.org_id)`、`max_uses = fields.get("max_uses", invite.max_uses)`（`:202-203`），传入 `_validate_fields`（`:204`）——即「本次没改的字段」也按当前值参与校验
3. `max_uses is not None and max_uses < invite.used_count` → `ValueError(f"使用次数上限不能低于已使用次数（{invite.used_count}）")`（`:205-206`）。**这是唯一一处把库内数据带进错误文案的地方**
4. **盲写循环** `for key, value in fields.items(): setattr(invite, key, value)`（`:207-208`）——服务层**无字段白名单**，可写范围完全由入参 dict 的键决定，实际边界在 `AdminInviteUpdate`（`backend/app/schemas/schemas.py:920-927`，只含 `name/remark/org_id/max_uses/expires_at/is_enabled`）与 `backend/app/api/routes/admin.py:870` 的 `model_dump(exclude_unset=True)`（见 §9 已知问题 1）
5. `invite.updated_at = datetime.utcnow()`（`:209`）——**必须手工赋值**：`backend/app/models/models.py:228` 的 `updated_at` 只有 `default=datetime.utcnow`，**没有 `onupdate=`**，SQLAlchemy 不会自动刷新它
6. 审计 `invite.update`，detail `{invite_id, name, fields: sorted(fields)}`（`:210-213`）——**只记字段名列表，不记新值**，`sorted()` 保证同一组字段名的 JSON 稳定可比对
7. `db.commit()`（`:214`）、`db.refresh`（`:215`）、返回 `to_out`（`:216`）

**`fields` 为空 dict 时**：不触发任何 `setattr`，但仍会刷 `updated_at`、写一条 `fields: []` 的审计并 commit。路由层未拦这种情况（`backend/app/api/routes/admin.py:870-872` 只拦 `name`/`is_enabled` 显式为 `null`）。

#### `get_invite(db, invite_id)`（`:219-220`）
`_invite_or_error` 的公开别名，返回 **ORM 对象而非 dict**。调用点 `backend/app/api/routes/admin.py:893`，用于取 `invite.code` 拼 scene（`backend/app/api/routes/admin.py:896`）。

#### `set_user_status(db, user_id, status, actor_type, actor_id)`（`:223-241`）
docstring `:226`：「启用/停用用户（停用即时生效：受保护接口每请求查库校验）。」

1. `status not in USER_STATUSES` → `ValueError("无效的用户状态")`（`:227-228`）。路由层另有 Pydantic `pattern="^(active|disabled)$"` 前置拦截（`backend/app/schemas/schemas.py:930-931`）
2. 查用户，不存在 → `ValueError("用户不存在")`（`:229-231`）
3. **`if user.status != status:`（`:232`）——状态未变化时什么都不做**：不改字段、不写审计、不 commit，直接 `return user`（`:241`）。这是幂等设计
4. 变化时：赋值（`:233`）→ 审计 `user.enable` / `user.disable`（按 `status == STATUS_ACTIVE` 二选一，`:234-238`），`target_user_id=user_id`、`detail=None` → `db.commit()`（`:239`）→ `db.refresh`（`:240`）

**停用为什么「即时生效」**：不在本文件，而在 `backend/app/api/deps.py:37`（每次 `get_current_user` 都查库）+ `backend/app/api/deps.py:48`（比对 `STATUS_ACTIVE`）。JWT 本身不失效，是每请求查库把它作废的。

**这是本文件内聚性最弱的一个函数**——它操作的是 `users` 表而非 `invite_codes`。归置于此的原因可从迁移看出：`docker/init/015_invite_admission.sql:23-28` 把 `users.status`/`invite_code_id`/`onboarded_at` 与 `invite_codes` 表作为**同一个「准入」批次**引入，管理端也把它们放在同一个「人员授权」页（菜单码 `access`，`backend/app/api/routes/admin.py:787`；而邀请码 CRUD 用菜单码 `invites`，见 `backend/app/api/routes/admin.py:834`、`:848`、`:868`、`:889` 四处同一文件内的 `require_menu("invites")`）。

### 4.5 函数 → 调用方一览
| 本文件符号 | 行号 | 调用点（仓库根相对路径:行号） |
|---|---|---|
| `STATUS_ACTIVE` | `:24` | `backend/app/services/auth_service.py:81`、`backend/app/services/auth_service.py:87`、`backend/app/services/auth_service.py:132`；`backend/app/api/deps.py:48`；`backend/app/api/routes/ws.py:46` |
| `InviteError` | `:29` | `backend/app/api/routes/auth.py:53`；`backend/app/api/routes/org.py:72`；`backend/app/services/auth_service.py:117`、`backend/app/services/auth_service.py:118` |
| `generate_code` | `:33` | `backend/app/api/routes/admin.py` 无直接调用（经 `create_invite:185`）；测试 `backend/test/s19_invite_admission.py:112`、`backend/test/s19_invite_concurrency_pg.py:50` |
| `scene_of` | `:37` | `backend/app/api/routes/admin.py:896` |
| `get_usable` | `:53` | `backend/app/api/routes/auth.py:52`（校验接口）；`backend/app/services/auth_service.py:111`、`backend/app/services/auth_service.py:116`（入驻与失败原因复查） |
| `ensure_org_in_scope` | `:73` | `backend/app/services/auth_service.py:112` |
| `consume` | `:77` | `backend/app/services/auth_service.py:114`（**全仓唯一**） |
| `user_scope_org` | `:93` | `backend/app/api/routes/org.py:36`（`GET /api/org/mine` 回填 `scopeOrgId`/`scopeOrgName`）；本文件 `:105` |
| `check_user_org_scope` | `:103` | `backend/app/api/routes/org.py:71`（`POST /api/org/select`） |
| `list_invites` | `:149` | `backend/app/api/routes/admin.py:836` |
| `create_invite` | `:181` | `backend/app/api/routes/admin.py:852` |
| `update_invite` | `:197` | `backend/app/api/routes/admin.py:875` |
| `get_invite` | `:219` | `backend/app/api/routes/admin.py:893` |
| `set_user_status` | `:223` | `backend/app/api/routes/admin.py:793` |
| `to_out` / `_status_of` / `_org_names` / `_check_usable` / `_ensure_in_scope` / `_validate_fields` / `_invite_or_error` | — | **仅本文件内部使用**，无外部调用点 |

## 5. 输入与输出

### 5.1 分层约定
本文件是 service 层，**不依赖任何 Pydantic schema**（`:7-17` 的导入段只有 stdlib、sqlalchemy、models、两个 service）。入参是原生 `dict`/标量，出参是 `dict` 或 ORM 对象，schema 校验与序列化都在路由层完成。这符合 `backend/AGENTS.md` §3.1 的分层规则，回指 `.qoder/ARCHITECTURE.md` §3.1。

**命名契约**：`to_out` 返回 **snake_case** 键，对应管理端 schema `AdminInviteOut`（`backend/app/schemas/schemas.py:879-894`，继承裸 `BaseModel` 而非 `CamelModel`）。小程序侧**从不接收本文件的输出**——`InviteVerifyOut`（`backend/app/schemas/schemas.py:61-66`）继承 `CamelModel`，字段只有 `name`/`orgId`/`orgName`，由 `backend/app/api/routes/auth.py:56-60` 手工构造。

### 5.2 端点映射
| 端点 | 鉴权 | 用到的本文件符号 | 路由位置 |
|---|---|---|---|
| `POST /api/auth/invite/verify` | **公开** + `invite_limiter`（60 次/60 秒/IP，`backend/app/core/rate_limit.py:35`） | `get_usable`、`InviteError` | `backend/app/api/routes/auth.py:47-60` |
| `POST /api/auth/onboard` | **公开** + 同一限流器 | `STATUS_ACTIVE`、`InviteError`（经 `auth_service`）；`get_usable`/`ensure_org_in_scope`/`consume` 在 `backend/app/services/auth_service.py:111-114` | `backend/app/api/routes/auth.py:63-84` |
| `GET /api/org/mine` | `get_current_user` | `user_scope_org` | `backend/app/api/routes/org.py:32-39` |
| `POST /api/org/select` | `require_activity_participation` | `check_user_org_scope`、`InviteError` | `backend/app/api/routes/org.py:58-82` |
| `GET /api/admin/invites` | `require_menu("invites")` | `list_invites` | `backend/app/api/routes/admin.py:824-837` |
| `POST /api/admin/invites` | `require_menu("invites")` | `create_invite` | `backend/app/api/routes/admin.py:840-856` |
| `PATCH /api/admin/invites/{invite_id}` | `require_menu("invites")` | `update_invite` | `backend/app/api/routes/admin.py:859-878` |
| `GET /api/admin/invites/{invite_id}/qrcode` | `require_menu("invites")` | `get_invite`、`scene_of` | `backend/app/api/routes/admin.py:881-904` |
| `PATCH /api/admin/users/{user_id}/status` | `require_menu("access")` | `set_user_status` | `backend/app/api/routes/admin.py:778-797` |

`require_menu` 工厂见 `backend/app/api/deps.py:150-160`（无该菜单码 403）。`invites` 菜单与 operator 角色默认授权由 `docker/init/015_invite_admission.sql:31-40` 种入。

**`GET /api/admin/invites/{id}/qrcode` 的出参**（`backend/app/api/routes/admin.py:898-904`）：`{image, page, scene, env_version, mock}`。路由 docstring `backend/app/api/routes/admin.py:891` 明写「码内仅含启动页路径与 `scene=i=<邀请码>`，不含 OpenID、Token 或个人信息」。`image` 为 `None` 时 `mock=true`（未配置微信凭证或生成失败，`backend/app/schemas/schemas.py:870`）。**注意该响应体里 `scene` 字段含明文邀请码**——这是设计使然（管理端要展示/下载），但意味着这条接口的响应不能进日志。

### 5.3 异常 → HTTP 状态码
| 本文件抛出 | 文案 | 路由转换 | 状态码 |
|---|---|---|---|
| `InviteError` | 邀请码无效 / 已停用 / 已过期 / 使用次数已满 | `backend/app/api/routes/auth.py:53-54` | 400 |
| `InviteError` | 所选组织不存在 | `backend/app/api/routes/org.py:72-74`（按文案分流） | **404** |
| `InviteError` | 所选组织不在邀请码允许的范围内 | `backend/app/api/routes/org.py:72-74` | 400 |
| `ValueError`（入驻链路上被 `InviteError` 之外的分支抛出，如「请填写姓名」） | — | `backend/app/api/routes/auth.py:81-82` | 400 |
| `ValueError("组织不存在")` / `("使用次数上限须大于 0")` / `(f"使用次数上限不能低于已使用次数（N）")` | — | `backend/app/api/routes/admin.py:876-878`（`update`，非「邀请码不存在」→400）；`backend/app/api/routes/admin.py:855-856`（`create`，一律 400） | 400 |
| `ValueError("邀请码不存在")` | — | `backend/app/api/routes/admin.py:876-878`（按文案分流）、`backend/app/api/routes/admin.py:894-895` | **404** |
| `ValueError("无效的用户状态")` | — | `backend/app/api/routes/admin.py:794-796` | 400 |
| `ValueError("用户不存在")` | — | `backend/app/api/routes/admin.py:794-796`（按文案分流） | **404** |

**路由层靠「比对异常文案字符串」决定 404 还是 400**（`backend/app/api/routes/admin.py:795`、`backend/app/api/routes/admin.py:877`、`backend/app/api/routes/org.py:73`）。改文案 = 改状态码，见 §8。

## 6. 依赖关系

### 6.1 下游依赖（本文件 `:7-17` 导入）
| 依赖 | 行号 | 用途 |
|---|---|---|
| `re` / `secrets` / `string` | `:7-9` | 格式正则、密码学安全随机、字符集 |
| `datetime.datetime` | `:10` | 全部时间比较用 **naive UTC**（`datetime.utcnow()`，`:61`、`:143`、`:163`、`:209`） |
| `typing.List/Optional/Tuple` | `:11` | 类型注解 |
| `sqlalchemy.or_`、`sqlalchemy.update` | `:13` | `consume` 的条件 UPDATE（`:79-89`） |
| `sqlalchemy.orm.Session` | `:14` | 类型注解；**会话一律由调用方经 `Depends(get_db)` 注入**，本文件不自建 Session |
| `app.models.models`：`InviteCode`、`Organization`、`User` | `:16` | 三张表：`invite_codes`、`organizations`、`users` |
| `app.services.audit_service` | `:17` | 三处审计写入（`:188`、`:210`、`:234`）。`audit_service.record` **只 `db.add`、从不 commit**（`backend/app/services/audit_service.py:1-5` docstring、`backend/app/services/audit_service.py:28-36`），因此「变更 + 审计」在同一事务原子落库 |
| `app.services.org_service` | `:17` | `get_path`（`:66`）、`get_org`（`:100`、`:168`） |

**无循环依赖**：`backend/app/services/org_service.py:6-13` 的导入段不含 `invite_service`。

### 6.2 上游调用方
`backend/app/api/routes/auth.py:20`、`backend/app/api/routes/org.py:18`、`backend/app/api/routes/admin.py:91`、`backend/app/api/deps.py:11`、`backend/app/api/routes/ws.py:14`、`backend/app/services/auth_service.py:19`；测试 `backend/test/s19_invite_admission.py:112`、`backend/test/s19_invite_concurrency_pg.py:29`。

**注意 `backend/app/api/deps.py:11` 与 `backend/app/api/routes/ws.py:14` 导入本文件只是为了拿 `STATUS_ACTIVE` 这一个字符串常量**——即依赖注入层与 WebSocket 层都对 invite_service 产生了导入依赖。

### 6.3 涉及的数据表
| 表 | 读/写 | 位置 |
|---|---|---|
| `invite_codes` | 读（`:57`、`:98`、`:115`、`:175`）+ 写（`:87` 条件 UPDATE、`:186` insert、`:207-209` update） | 建表 `docker/init/015_invite_admission.sql:7-21`；ORM `backend/app/models/models.py:208-228` |
| `users` | 读（`:229`）+ 写（`:233` 仅 `status` 列） | 列由 `docker/init/015_invite_admission.sql:25-27` 引入 |
| `organizations` | **只读**（`:115` 名称、经 `org_service` 的 `:66`/`:100`/`:168`） | — |
| `audit_logs` | 写（经 `audit_service`，`:188`/`:210`/`:234`） | — |

`invite_codes` 上**没有外键约束**：`org_id`（`docker/init/015_invite_admission.sql:12`）与 `users.invite_code_id`（`docker/init/015_invite_admission.sql:26`）都是裸 `INTEGER`。组织存在性完全靠服务层 `_validate_fields:168` 保证；因此**删除组织不会阻止，也不会级联清理引用它的邀请码**（此时 `to_out` 的 `org_name` 会是 `None`，`_org_names` 查不到该行）。

### 6.4 第三方与配置
本文件**无任何第三方 HTTP 调用、无 `settings` 读取**（导入段 `:7-17` 不含 `app.core.config`）。相关配置项都在别处：`WX_APPID`/`WX_SECRET`（`backend/app/core/config.py:43` 起）决定小程序码是真实生成还是 mock，`WXACODE_ENV_VERSION`（`backend/app/core/config.py:53`，默认 `"trial"`）参与图片缓存键（`backend/app/services/wechat_service.py:78`）与二维码响应（`backend/app/api/routes/admin.py:902`）。**本文件不存在 `ORG_SYNC_API_URL` 之类的外部数据源依赖**。

## 7. 业务规则

### 7.1 码的生成规则
- 长度固定 16（`:20`），字符集大小写字母 + 数字共 62（`:19`），逐位 `secrets.choice`（`:34`）。
- **服务端生成，客户端不可指定**：`create_invite:185` 把 `code=generate_code()` 写在构造参数首位，`fields` 里即使带 `code` 也会因关键字重复而 `TypeError`（`AdminInviteCreate` 本身也没有 `code` 字段，`backend/app/schemas/schemas.py:913-917`）。
- **不预检重复**：靠 UNIQUE 约束（`docker/init/015_invite_admission.sql:21`）。

### 7.2 有效期与使用时限
| 规则 | 值 / 行为 | 依据 |
|---|---|---|
| 有效期可选 | `expires_at` 为 `NULL` = 永不过期 | `docker/init/015_invite_admission.sql:15`、`backend/app/models/models.py:224`；本文件 `:46`、`:85` |
| 过期判定 | `expires_at <= now` 即过期（**闭区间**，等于当前时刻算过期） | `:46-47`；SQL 侧取反为 `expires_at > now`（`:85`） |
| 次数上限可选 | `max_uses` 为 `NULL` = 不限次数 | `docker/init/015_invite_admission.sql:13`、`backend/app/models/models.py:222`；本文件 `:48`、`:84` |
| 上限下界 | 非空时须 `>= 1`；Pydantic `ge=1` + 服务层 `< 1` 双重校验 | `backend/app/schemas/schemas.py:917`、`backend/app/schemas/schemas.py:926`；本文件 `:170-171` |
| 上限不得低于已用 | `max_uses < used_count` 直接拒绝 | `:205-206` |
| 用满判定 | `used_count >= max_uses`（Python）／ `used_count < max_uses`（SQL） | `:48`、`:84` |
| 时区 | 库内存 **UTC naive**；入参由 `_InviteExpiry.to_utc` 归一 | `docker/init/015_invite_admission.sql:6`「时间均为 UTC」；`backend/app/schemas/schemas.py:902-910` |
| 展示 | 管理端把 UTC 转本地时区展示 | `docs/迭代记录.md` 2026-10-12「邀请码准入全链路」条目「内容 · 管理后台」段 |

**时区实现的实际情况**：`_InviteExpiry` 的 docstring（`backend/app/schemas/schemas.py:903`）写「naive 视为**服务器本地时间**」，但它调用的 `local_to_utc`（`backend/app/core/helpers.py:40-44`）对 naive 值统一 `replace(tzinfo=BEIJING_TZ)`，而 `BEIJING_TZ` 是**硬编码 UTC+8**（`backend/app/core/helpers.py:9`）。即无论服务器时区如何，naive 入参都按北京时间解释。见 §9「文档偏差」。

### 7.3 并发一致性保证（本文件最核心的规则）
**结论：靠单条带全部有效性条件的 UPDATE + 数据库行级串行化，判定 `rowcount == 1`；不用行锁、不用乐观锁版本号、不需要 `used_count` 上的约束。**

- 写入点唯一：`consume:79-89`。`backend/app/models/models.py:212` docstring 明写「`used_count` 仅由 invite_service 的条件 UPDATE 原子递增」，`docker/init/015_invite_admission.sql:14` 只给了 `DEFAULT 0`。全仓再无其它 `used_count` 写入点（`create_invite`/`update_invite` 的字段白名单不含它）。
- 四个有效性条件（id、`is_enabled`、次数、有效期）**全部在 WHERE 内**（`:82-85`），因此「校验」与「递增」在同一条语句里原子完成，不存在 check-then-act 窗口。
- 并发失败路径：`consume` 返回 `False` → `backend/app/services/auth_service.py:115` `db.rollback()` → `backend/app/services/auth_service.py:116` 重新 `get_usable` 以取得**精确原因**（停用/过期/用满）→ `backend/app/services/auth_service.py:117` 抛 `InviteError("邀请码使用次数已满")`。注意 `:117` 的文案是**硬编码**的，`:116` 那次 `get_usable` 抛出的异常会被 `:118` 的 `except InviteError` 捕获并走「复用已入驻用户」分支（`:119-124`），只有在该身份确实未入驻时才把 `:117` 的异常继续上抛。
- 实测依据：`backend/test/s19_invite_concurrency_pg.py`（真实 openGauss）P01「多身份并发不超额」、P02「同一身份并发只建一个用户只核销一次」、P03「唯一约束冲突回滚复用已存在用户」，见 `docs/迭代记录.md` 2026-10-12「邀请码准入全链路」条目的「验证」段（原文见 §10）。

**同一 code 被并发消费时的一致性保证来自哪里**（任务问点，明确回答）：
1. **不是**唯一约束——`uq_invite_codes_code`（`docker/init/015_invite_admission.sql:21`）保证的是**码值不重复**，与核销计数无关。
2. **不是**行锁——本文件无 `with_for_update()`。
3. **是**「条件 UPDATE 的原子性 + 数据库对同行写者的阻塞与重评估」：第二个事务在行锁上等待，第一个提交后它读到的是**新的** `used_count`，WHERE 不再成立，`rowcount=0`，业务侧判为失败并回滚。
4. 「一人一号」由另一条独立约束保证：`users.openid` 唯一（冲突时 `backend/app/services/auth_service.py:144-149` 回滚并复用已存在用户，回滚同时**撤销已核销的那一次**，见 `backend/app/services/auth_service.py:97-99` docstring）。

### 7.4 幂等性
| 操作 | 幂等性 | 依据 |
|---|---|---|
| `get_usable` | **完全幂等**（只读，不核销） | `:53-61`；`backend/app/api/routes/auth.py:47` summary「校验入驻邀请码（不核销）」 |
| `consume` | **非幂等**（每次成功调用 `used_count` +1） | `:87` |
| 入驻整体 | **对同一微信身份幂等**：已入驻直接复用、不再核销 | `backend/app/services/auth_service.py:102-104`（进入即复用）、`backend/app/services/auth_service.py:118-124`（`InviteError` 后复查复用）、`backend/app/services/auth_service.py:97-99` docstring 明列「中途退出后重新扫码、重复提交、并发提交」 |
| `create_invite` | **非幂等**，每次调用产生一条新码 | `:185-186` |
| `update_invite` | 结果幂等（同样的 `fields` 重复提交得到同样的库状态），但**每次都写一条审计并刷新 `updated_at`**，含 `fields` 为空 dict 的情况 | `:207-214` |
| `set_user_status` | **完全幂等且零副作用**：状态未变化时不写审计、不 commit | `:232-241` |

### 7.5 事务边界（谁提交）
本文件**混用两种约定**，修改前必须先确认目标函数属于哪一种（回指 `.qoder/ARCHITECTURE.md` §9.4）：

| 函数 | 提交者 | 行号 |
|---|---|---|
| `consume` | **调用方**（`auth_service.onboard`，`backend/app/services/auth_service.py:143`）。docstring `:78` 明写「不提交」；失败时由调用方 `db.rollback()`（`backend/app/services/auth_service.py:115`、`backend/app/services/auth_service.py:120`） | `:79-90` |
| `get_usable` / `ensure_org_in_scope` / `user_scope_org` / `check_user_org_scope` / `get_invite` / `list_invites` | 只读，无提交 | — |
| `create_invite` | **自己**：`flush`（`:187`，为拿自增 id）→ 审计 → `commit`（`:192`）→ `refresh`（`:193`） | `:181-194` |
| `update_invite` | **自己**：审计 → `commit`（`:214`）→ `refresh`（`:215`）。**无显式 rollback**，异常时靠 `get_db()` 的 `finally: db.close()` 隐式回滚 | `:197-216` |
| `set_user_status` | **自己，且仅在状态变化时**：`commit`（`:239`）→ `refresh`（`:240`） | `:223-241` |

审计与业务变更同事务：`audit_service.record` 只 `db.add`（`backend/app/services/audit_service.py:28-36`），本文件三处审计（`:188`、`:210`、`:234`）都紧邻其后的 `commit`，因此「改邀请码 + 记审计」要么同时落库要么同时不落。

### 7.6 敏感信息处理（只写机制，不写值）
| 场景 | 机制 | 依据 |
|---|---|---|
| 审计明细 | **只记 `invite_id` 与 `name`**，创建时 `{invite_id, name}`（`:190`），更新时 `{invite_id, name, fields: sorted(fields)}`——**字段名列表，无新值**（`:212`）；启停用户时 `detail=None`（`:237`）。三处均不含 `code` | `:5` docstring；`.qoder/decisions/README.md`「邀请码不写入日志与审计明细」行 |
| 入驻审计 | `user.onboard` 的 detail 为 `{invite_id, invite_name, org_id}`，同样不含码 | `backend/app/services/auth_service.py:139-142` |
| 校验接口 | `POST /api/auth/invite/verify` **刻意不返回码与使用次数**，只回 `name`/`orgId`/`orgName` | `backend/app/api/routes/auth.py:49` docstring、`backend/app/api/routes/auth.py:56-60`；`backend/app/schemas/schemas.py:61-66` |
| 管理端 | `to_out:134` **返回明文 `code`**，`AdminInviteOut.code`（`backend/app/schemas/schemas.py:883`）随之暴露；二维码响应体 `scene` 亦含明文码（`backend/app/api/routes/admin.py:896`、`backend/app/api/routes/admin.py:901`）。这是设计需要（管理员必须能取到码去分发），但受 `require_menu("invites")` 保护 | `:131-146` |
| 枚举防护 | 格式非法与库中不存在**返回同一文案「邀请码无效」**，不泄露码是否存在 | `:54` docstring、`:56-60` |
| 暴破防护 | 两个公开入口都过 `invite_limiter`（60 次/60 秒/IP，超限 429） | `backend/app/api/routes/auth.py:50`、`backend/app/api/routes/auth.py:69`；`backend/app/core/rate_limit.py:34-35`、`backend/app/core/rate_limit.py:42-45` |
| 日志 | 本文件**无任何 logging 调用**（导入段 `:7-17` 不含 logging） | `docs/迭代记录.md` 2026-10-12 条目「日志/响应脱敏：不含 openid、session_key、wx code、邀请码原码、AppSecret」 |

> 本文档遵循同一约束：**不记录任何真实邀请码值、真实 openid、真实姓名或手机号**。

### 7.7 组织范围（专属码）规则
- `org_id` 为 `NULL` = **通用码**，入驻时可选任意存在的组织（`:69` 的 `scope_org_id is not None` 短路）。
- `org_id` 非空 = **专属码**，入驻只能选该组织**及其后代**（`:65` docstring、`:69-70`；`docker/init/015_invite_admission.sql:6`；`.qoder/REQUIREMENTS.md` §2.2「组织越界」行）。
- 范围约束**不止作用于入驻**：已入驻用户后续调 `POST /api/org/select` 也沿用其入驻邀请码的范围（`:104` docstring、`backend/app/api/routes/org.py:71`）。但注意 `/org/select` 对已有 `org_id` 的用户会**先**被 403 锁定拦截（`backend/app/api/routes/org.py:68-69`，`org_service.ORG_LOCKED`），所以这条范围校验实际只对「入驻时未定组织、之后首次选组织」的用户生效。
- `GET /api/org/mine` 用 `scopeOrgId`/`scopeOrgName` 把范围下发给小程序，供其锁定组织选择栈底（`backend/app/api/routes/org.py:34`、`backend/app/api/routes/org.py:37-38`；`frontend/pages/onboard/onboard.js` 侧行为见 `docs/迭代记录.md` 2026-10-12 条目「小程序」段）。
- 判定方式是**回溯祖先链**（`org_service.get_path`，`:66`），不是展开子树；两种写法结果等价。

### 7.8 账号启停规则
- 状态只有 `active`/`disabled` 两值（`:26`；Pydantic 正则 `backend/app/schemas/schemas.py:931`；数据库列 `docker/init/015_invite_admission.sql:25` 默认 `'active'`）。
- 存量用户全部回填 `active`，`invite_code_id` 为空即「历史用户」（`docker/init/015_invite_admission.sql:24`、`docker/init/015_invite_admission.sql:28`）。
- 停用**即时生效**且作用于全部受保护接口与 WS（`backend/app/api/deps.py:46-53`、`backend/app/api/routes/ws.py:46-50`），机制是每请求查库比对 `STATUS_ACTIVE`，而非吊销 JWT。
- 登录侧同样按状态分流：`active` 发 Token，`unregistered`/`disabled` 都不发（`backend/app/services/auth_service.py:79-83`；`backend/app/api/routes/auth.py:31-35` docstring）。
- 管理端**不能改自己的账号状态**（超管除外）：`backend/app/api/routes/admin.py:789-790` 返回 400。
- 停用用户重新提交入驻：`_resume` 抛 `AccountDisabledError`（`backend/app/services/auth_service.py:86-89`），路由转 403 + `X-Account-Status: disabled`（`backend/app/api/routes/auth.py:77-80`）。**停用不会释放已核销的次数**。

## 8. 修改约束
1. **两份有效性条件必须同步修改**：`_check_usable:41-50`（Python 判定，供校验接口与状态派生）与 `consume:82-85`（SQL 判定，供核销）是**手工维护的两份等价逻辑**，没有共用定义。当前一致性为：`expires_at <= now` 过期 ↔ `expires_at > now` 可核销；`used_count >= max_uses` 用满 ↔ `used_count < max_uses` 可核销；`not is_enabled` 停用 ↔ `is_enabled IS TRUE`。**新增任何有效性维度（例如「限活动期」「限组织」）必须同时改这两处，否则会出现「校验通过但核销失败」或反之**。这是本文件最重要的修改约束。
2. **`_status_of:119-128` 是第三份隐含副本**：它靠 `_check_usable` 抛异常后**重新按顺序判定**来推导状态，若 `_check_usable` 的条件顺序或条件集变了，`:123-127` 的分支也必须跟着改，否则状态串会错标。
3. **不要给 `consume` 加 `db.commit()`**：`backend/app/services/auth_service.py:95`「同一事务提交」与 `backend/app/services/auth_service.py:97-99`「并发撞 openid 唯一约束时回滚（核销随之撤销）」都依赖 `consume` 保持未提交。一旦自提交，唯一约束冲突时的核销就无法回滚，会出现「用户没建成、次数被吃掉」。
4. **不要给 `consume` 加 `with_for_update()`**：`synchronize_session=False`（`:88`）与行锁语义无冲突，但加锁会改变事务阻塞特征；当前实现已被 `backend/test/s19_invite_concurrency_pg.py` 在真实 openGauss 上验证（3/3，见 §10），改动需重跑该并发脚本。
5. **`STATUS_ACTIVE = "active"`（`:24`）是跨模块协议常量**，被 5 处直接引用（§4.5 表），并与数据库列默认值 `'active'`（`docker/init/015_invite_admission.sql:25`）、Pydantic 正则 `^(active|disabled)$`（`backend/app/schemas/schemas.py:931`）、响应头值 `disabled`（`backend/app/api/deps.py:52`）、WS 关闭码 4403 分支（`backend/app/api/routes/ws.py:49`）绑定。改字符串等于改协议，需同步迁移与前端。
6. **异常文案是路由分流的依据**：`"邀请码不存在"`→404（`backend/app/api/routes/admin.py:877`）、`"用户不存在"`→404（`backend/app/api/routes/admin.py:795`）、`"所选组织不存在"`→404（`backend/app/api/routes/org.py:73`）。改文案会静默把 404 变成 400。
7. **`code` 不得进入日志、审计 detail、错误响应或小程序侧任何出参**（`:5` docstring；`.qoder/decisions/README.md`「邀请码不写入日志与审计明细」行）。管理端出参（`to_out:134`）与二维码 `scene`（`backend/app/api/routes/admin.py:901`）是**仅有的两个合法明文出口**，新增出口须先确认权限与日志脱敏。
8. **`update_invite` 的盲写循环（`:207-208`）没有服务层白名单**，安全边界只在 `AdminInviteUpdate`（`backend/app/schemas/schemas.py:920-927`）。**扩展该 schema 时必须逐字段评估**：一旦加入 `code`/`used_count`/`created_by`/`id`，管理员就能改码值、伪造核销数、篡改创建人。若要长期稳妥，应在 `:207` 前加显式字段白名单。
9. **`updated_at` 必须手工赋值**：ORM 列无 `onupdate=`（`backend/app/models/models.py:228`），`update_invite:209` 是本文件唯一的刷新点。新增任何写路径都要照做，否则该列会一直停在创建时刻。
10. **审计只用 `audit_service.record`，不要自己 commit 审计**：`backend/app/services/audit_service.py:1-5` 明确「只加入会话、不提交」。本文件三处审计（`:188`、`:210`、`:234`）都遵循「先 record 后由本函数 commit」的顺序。
11. **不要在 service 内自建 `Session`**：会话一律由路由层 `Depends(get_db)` 注入（回指 `.qoder/ARCHITECTURE.md` §9.4）。全仓唯一例外是流式 CSV 导出，与本文件无关。
12. **时间一律 naive UTC**：本文件所有 `datetime.utcnow()`（`:61`、`:143`、`:163`、`:209`）与库内 UTC 列（`docker/init/015_invite_admission.sql:6`）配套。若引入 `now_utc()`（`backend/app/core/helpers.py:12`）等带时区实现，需确认比较双方 tzinfo 一致，否则 Python 会直接抛 `TypeError`。
13. **`generate_code` 不要改成可预测来源**（时间戳、递增序列、`random`）：码是准入凭证，`secrets`（`:8`、`:34`）是有意选择。

## 9. 当前实现状态

### 9.1 已实现（有据可查）
- 邀请码生成、校验（不核销）、组织范围校验、原子核销：`:33-90`
- 已入驻用户的组织范围派生与改选校验：`:93-107`
- 管理端分页列表（关键字过滤 + 组织名批量 + 统一状态基准）、创建、部分更新、单条查询、状态派生：`:111-220`
- 用户账号启停（幂等、带审计）：`:223-241`
- 小程序码 scene 拼装：`:37-38`（图片生成在 `backend/app/services/wechat_service.py:76-84`）
- 迁移 `docker/init/015_invite_admission.sql` 已纳入 `docker/init` 迁移链；开发库 `schema_migrations` 已含 001→022 全部 22 条（环境事实，回指 `.qoder/PROJECT.md`）
- 测试覆盖：`backend/test/s19_invite_admission.py`（功能/安全，I01–I25）、`backend/test/s19_invite_concurrency_pg.py`（真实 openGauss 并发，P01–P03）

### 9.2 已知问题与限制
| # | 问题 | 依据 | 处置 |
|---|---|---|---|
| 1 | **`update_invite` 盲写 `setattr` 无服务层白名单**，可写字段完全由入参 dict 决定。当前被 `AdminInviteUpdate`（`backend/app/schemas/schemas.py:920-927`，仅 6 字段）与 `exclude_unset=True`（`backend/app/api/routes/admin.py:870`）双重收窄，`code`/`used_count`/`created_by` 目前不可达；但这是**靠 schema 兜的隐式约束**，扩展 schema 即静默放开 | `:207-208` | 待确认（未见登记） |
| 2 | **改邀请码 `org_id` 会追溯改变已入驻用户的可选组织范围**：`user_scope_org:97-99` 读的是邀请码**当前**的 `org_id`，不是入驻时快照；`users` 表也没有「入驻时范围」列（`docker/init/015_invite_admission.sql:25-27` 只有 `status`/`invite_code_id`/`onboarded_at`）。是否为预期语义**待确认** | `:93-107` | 待确认 |
| 3 | **`create_invite` 无码冲突重试，且路由只捕 `ValueError`**：真撞 UNIQUE 会抛 `IntegrityError`，`backend/app/api/routes/admin.py:855-856` 接不住 → **500**。62^16 空间下概率可忽略，但错误码语义不正确 | `:185-186`；`docker/init/015_invite_admission.sql:21` | 未登记 |
| 4 | **列表关键字只搜 `name`**，不搜 `code`/`remark`。管理员拿到的往往是码值本身，用码搜索会**搜不到**（且 `get_usable` 也不接受 id）。是否符合后台搜索语义**待确认** | `:153-154` | 待确认 |
| 5 | **`update_invite` 对空 `fields` 仍写审计并刷 `updated_at`**：`fields={}` 时不改任何列，但会产生一条 `fields: []` 的审计记录。路由层 `backend/app/api/routes/admin.py:870-872` 只拦 `name`/`is_enabled` 显式为 `null`，不拦空 body | `:207-214` | 未登记 |
| 6 | **`set_user_status` 放在 invite_service 内聚性弱**：它操作 `users` 表、受 `access` 菜单码保护（`backend/app/api/routes/admin.py:787`），与邀请码 CRUD 的 `invites` 菜单码不同。归置原因可追溯到 015 迁移把两者作为同一「准入」批次引入（`docker/init/015_invite_admission.sql:3-6`、`docker/init/015_invite_admission.sql:23-28`） | `:223-241` | 现状记录 |
| 7 | **`USER_STATUSES` 复用了邀请码状态串常量**：`STATUS_ACTIVE`/`STATUS_DISABLED`（`:24-25`）语义上是「用户账号状态」，却与 `_status_of` 返回的邀请码状态 `"active"`/`"disabled"`（`:124`、`:128`）字面相同但**含义不同**（一个是 `users.status`，一个是派生展示态）。两套机制独立，容易误读 | `:24-26`、`:119-128` | 现状记录 |
| 8 | **邀请码状态串未常量化**：`"disabled"`/`"expired"`/`"exhausted"`/`"active"` 是裸字面量（`:124`、`:126`、`:127`、`:128`），与 `backend/app/schemas/schemas.py:880` 的 docstring 靠约定对齐，改一处不会报错 | `:119-128` | 未登记 |
| 9 | **`STATUS_DISABLED`（`:25`）在本文件内只被 `USER_STATUSES` 引用**，路由层的 `X-Account-Status: disabled`（`backend/app/api/deps.py:52`）是硬编码字符串，未复用常量 | `:25-26` | 未登记 |
| 10 | **`invite_codes.org_id` 无外键**：删除组织后引用它的邀请码仍显示（`org_name` 变 `None`），且专属码的范围校验会因 `get_path` 回溯到已删节点而行为改变。`_org_names:114-116` 用 `IN` 查询，查不到就静默缺键 | `docker/init/015_invite_admission.sql:12`；`:111-116` | 未登记 |
| 11 | **`scene_of:37-38` 不校验 code 格式**，直接拼接。当前调用点的 code 来自库内（`backend/app/api/routes/admin.py:893-896`），受 UNIQUE + 生成器约束，实际不会超长；但函数本身对任意入参都返回 `i=<入参>` | `:37-38` | 现状记录 |
| 12 | **`admin_menus.sort_order` 重号（已登记，用户决定只记录不修改）**：015 迁移给 `invites` 菜单写入 `sort_order=10`，与 `ai_overview`=10 撞号，三处 `order_by(AdminMenu.sort_order)` 在同分时返回顺序不稳定 | `docker/init/015_invite_admission.sql:31-33`；登记于 `.qoder/PROJECT.md` §8「代码级技术债」第 26 项 | **只记录不修改**（2026-10-17 用户决定） |
| 13 | **限流器为单进程内存态**：`invite_limiter`（`backend/app/core/rate_limit.py:35`）在多 worker 部署下每个进程独立计数，实际阈值会被放大。已登记为架构级限制 | `.qoder/PROJECT.md` §8「架构级限制」第 4 项（单进程内存态清单，明列「邀请码图片缓存」与限流器） | 已登记 |

### 9.3 明确未实现（不要当作已完成）
- **员工名册 + 手机号绑定 + 绑定码的准入方案未实现**：`docs/身份绑定与自动登录改造分析报告.md` 提出以「员工名册 / 绑定码 / 准入策略」替代当前邀请码方案（该文件 `:5` 自述「本方案替代 V1.1 功能三中的『一次性绑定码』方案」，`:86-94` 列出待新增的 `backend/app/services/employee_service.py`、`backend/app/api/routes/admin_employee.py`、`backend/test/s13_employee_access.py` 等）。**经核对，这三个文件在仓库中均不存在**（`backend/app/services/`、`backend/app/api/routes/`、`backend/test/` 三个目录下逐一目视确认）。该报告提交信息为「待确认后编码」（`cc66b8b`），后续 `7fcd037` 只补充了确认结果，未见编码提交。**当前生效的准入机制仍是本文件的邀请码方案。**
- **无「撤销/作废单个已入驻用户的邀请码关联」能力**：`users.invite_code_id` 只有入驻时写入（`backend/app/services/auth_service.py:133`），本文件无任何清除或改写路径。
- **无邀请码使用明细**：核销只累加 `used_count`（`:87`），**不记录「谁在何时用了这个码」的独立流水表**。「哪个用户来自哪个码」只能反查 `users.invite_code_id`（`docker/init/015_invite_admission.sql:26`、`docker/init/015_invite_admission.sql:29` 索引）与 `audit_logs` 的 `user.onboard` detail（`backend/app/services/auth_service.py:139-142`）。
- **无批量导入/导出邀请码**：Excel 导入只实现了 `question` 与 `quote`（回指 `.qoder/backend/app/services/import_service.py.md`）。
- **无按组织/状态筛选的列表查询**：`list_invites:149-164` 只支持 `name` 关键字 + 分页，无 `org_id`、无 `status`、无时间范围过滤（对比 `access_service.list_users` 有 `org_id`/`has_access`/`status` 三个筛选，`backend/app/api/routes/admin.py:772-774`）。
- **无删除邀请码接口**：路由只有 GET/POST/PATCH（`backend/app/api/routes/admin.py:824-878`），停用（`is_enabled=false`）是唯一「下线」手段。

### 9.4 文档偏差（代码正确，引用/注释过时）
| 位置 | 偏差 | 实际 |
|---|---|---|
| `.qoder/decisions/README.md`「并发控制用条件 UPDATE + `with_for_update()` 行锁」行 | 把本文件列为「条件 UPDATE + `with_for_update()` 行锁」的依据之一；其依据列原文为「`backend/app/services/sport_service.py:105-111`；`points_service.py:71-77`；`invite_service.py:5`」（后两条为裸文件名，照录以便定位） | 本文件**无 `with_for_update()`**（`grep -c with_for_update` 结果为 0），只用条件 UPDATE；「并发下不会超发」的说明在本文件 **`:4`**，`:5` 是「不写日志与审计明细」——即该处**行号偏大 1 且结论对本文件不成立** |
| `.qoder/decisions/README.md`「邀请码不写入日志与审计明细」行 | 依据列原文为「`backend/app/services/invite_service.py:6`（文档串明说）」（路径格式正确） | 但**行号偏大 1**：「不写入日志与审计明细」在本文件 **`:5`**；`:6` 只是 docstring 的结束引号 |
| `.qoder/decisions/README.md`「邀请码只决定首次入驻资格」行 | 依据列原文为「`invite_service.py:4`（文档串明说）」（裸文件名，照录） | **行号偏大 1**：「只决定首次入驻资格」在本文件 **`:3`**；`:4` 是核销方式 |
| `backend/app/schemas/schemas.py:903` | `_InviteExpiry` docstring 称「naive 视为**服务器本地时间**」 | `local_to_utc`（`backend/app/core/helpers.py:40-44`）对 naive 值硬编码 `BEIJING_TZ`（`backend/app/core/helpers.py:9`，UTC+8），与服务器时区无关 |
| `backend/app/models/models.py:212` | 「`used_count` 仅由 invite_service 的条件 UPDATE 原子递增」 | 与代码一致（唯一写入点 `:87`）。此处**列为佐证而非偏差** |
| `.qoder/REQUIREMENTS.md` §2.2 | 依据列写作 `services/invite_service.py:19-20` 等**裸文件名/相对路径**形式 | 行号本身经核对**全部正确**（`:19-20`、`:33-34`、`:21`、`:22`、`:3`、`:4`、`:5`、`:64-70`）；仅引用格式不符合本目录「仓库根相对路径」约定 |

### 9.5 待确认清单
1. 「V1.1 准入优先闭环」这一命名的出处——仓库 `.md` 全量 grep 无命中（见 §3）。
2. 管理端修改邀请码 `org_id` 追溯影响已入驻用户范围，是否为预期语义（§9.2 问题 2）。
3. 列表关键字只搜 `name` 是否符合后台搜索语义（§9.2 问题 4）。
4. `docs/身份绑定与自动登录改造分析报告.md` 的落地时间与是否替代本文件——报告本身标注「待确认后编码」，`7fcd037` 仅补充确认结果（§9.3）。
5. 生产环境是否多 worker 部署（若是，`invite_limiter` 与小程序码图片缓存的实际效果需重估，§9.2 问题 13）。

## 10. 迭代记录
数据来源：`git log --follow --oneline -- backend/app/services/invite_service.py`（**仅 1 个提交**）与 `docs/迭代记录.md` 对应条目。

> 引用约定：`docs/迭代记录.md` 在本目录编写期间被并发修改、行号发生过整体位移，故本文**只按「日期 + 条目标题 + 提交号」定位该文件，不写其行号**。

### 2026-10-12 · 邀请码准入全链路（功能开发/安全加固）
- **提交**：`afbcba9`（范围：backend、admin、frontend、docker、docs）。本文件由该提交**一次性创建**，此后无任何修改。`git log -S` 复核确认 `check_user_org_scope`、`_status_of`、`user_scope_org` 三个符号均首见于 `afbcba9`。
- **需求**：把小程序准入从「任何微信用户可直接建号」改为「必须持 PC 后台签发的有效邀请码才能首次入驻」，并配套管理端邀请码管理与账号启停。
- **本文件相关内容（`docs/迭代记录.md` 2026-10-12「邀请码准入全链路（功能开发/安全加固）」条目「内容 · 后端」段原文要点）**：
  - 迁移 `docker/init/015_invite_admission.sql`：新增 `invite_codes` 表、`users.status/invite_code_id/onboarded_at` 列、`invites` 菜单与 operator 角色默认授权。
  - `/api/auth/login` 改为状态式返回 `{status: active|unregistered|disabled, token?, user?}`，**未入驻不再自动建号也不签发 Token**；禁用用户所有受保护接口 403 并带 `X-Account-Status: disabled` 响应头，WS 握手禁用用户 4403 关闭。
  - 新增 `/api/auth/invite/verify`（不核销，`invite_limiter` 60s/60 次/IP 限流）与 `/api/auth/onboard`（事务内条件 UPDATE 原子核销 + 建号 + 审计，openid 唯一约束冲突回滚复用已存在用户）；专属码限定该组织及其下级子树，`/org/select` 同步校验。
  - 新增 `/api/admin/invites` CRUD/启停/小程序码/`PATCH /api/admin/users/{uid}/status`；旧 `/api/admin/onboarding-qrcode` 下线。
  - 日志/响应脱敏：不含 openid、session_key、wx code、**邀请码原码**、AppSecret。
- **关联文件**：`backend/app/services/auth_service.py:92-155`（`onboard`）、`backend/app/api/routes/auth.py:47-84`、`backend/app/api/routes/org.py:32-82`、`backend/app/api/routes/admin.py:778-904`、`backend/app/api/deps.py:46-53`、`backend/app/api/routes/ws.py:46-50`、`backend/app/models/models.py:208-228`、`backend/app/schemas/schemas.py:55-76`、`backend/app/schemas/schemas.py:869-935`、`docker/init/015_invite_admission.sql`、`backend/app/core/rate_limit.py:34-35`、`backend/app/services/wechat_service.py:19`、`backend/app/services/wechat_service.py:76-84`、`frontend/pages/launch/launch.js`、`frontend/pages/onboard/`、`admin/src/views/InvitesView.vue`。
- **测试结果（`docs/迭代记录.md` 该条目「验证」段原文，逐条照录；仅把原文中的 `test/...` 相对路径按本目录引用规范展开为仓库根相对路径）**：
  - 后端 `backend/test/s19_invite_admission.py` **25/25 通过**（I01–I25：未入驻拒绝、各种无效码、专属码越界、历史用户不受限、停用 38 受保护接口 403、WS 4403、管理端 CRUD/审计/UTC、脱敏、过期 Token 复用用户）。
  - 真实 openGauss 并发 `backend/test/s19_invite_concurrency_pg.py` **3/3**（P01 多身份并发不超额、P02 同一身份并发只建一个用户只核销一次、P03 唯一约束冲突回滚复用已存在用户）。**P03 初次失败后修 `auth_service.onboard` 为 `rollback → 复用已存在用户`，连跑 3 次通过。**
  - admin `npm run build` 通过。
  - 小程序侧 `node --check` 全部通过；**真机扫码与开发者工具 automator 的三态截图未纳入本次 CI，需另行手工验收（已在报告「未执行项」中标注）**。
  - 报告：`backend/test/docs/s19-invite-admission-report.md`、`admin/test/docs/s19-invite-admin-report.md`、`admin/test/docs/s19-invite-frontend-report.md`。
- **对本文件的直接影响**：P03 的修复落在 `backend/app/services/auth_service.py:144-149`（`IntegrityError` → rollback → 复用），**本文件的 `consume` 未因该缺陷被修改**——它的「不提交」契约（`:78`）正是修复能成立的前提。
- **后续回归（本文件未被这些提交修改，仅测试脚本被更新）**：`docs/迭代记录.md` 中 2026-10-13 五个条目的「验证」段均记录了 s19 回归结果，按时间顺序为——
  | 提交 | 条目标题 | 「验证」段中的 s19 相关原文 |
  |---|---|---|
  | `ce14a95` | V2.0 需求一：活动时间控制（后端） | 「`s19_invite_admission.py` 回归 25/25 通过。」 |
  | `2f3f333` | V2.0 需求三/四：积分台账重构与总积分排名（后端） | 「回归：s11 8/8、s18 14/14、s19 25/25（已按新规则更新断言）、s6 8/8 通过。」 |
  | `07d02af` | V2.0 需求五：所属部门首次确定后锁定（后端） | 「s19 25/25 通过：I16/I17 已按锁定规则更新，覆盖专属码首次选组织的范围约束（越界 400、范围内 200、再次选择 403、`locked=true`）。」 |
  | `78a12ca` | V2.0 需求六：每题 90 秒限时作答（后端） | 「s6、s11、s12、s19（含 openGauss 并发）全部通过。」 |
  | `19b0d73` | V2.0 后端综合回归 S20 与设计文档同步 | 「s20 25/25 通过；s18 21/21、s19 25/25、s19-PG 3/3 回归通过。」 |

  其中 `07d02af` 与 `2f3f333` 修改了 `backend/test/s19_invite_admission.py` 的断言（部门锁定、积分新规则），`ce14a95`/`78a12ca`/`19b0d73` 为纯回归。**五者均未触及 `backend/app/services/invite_service.py`**（与 `git log --follow` 只有 1 个提交一致）。

### 未变更说明
自 `afbcba9`（2026-10-12）创建以来，`backend/app/services/invite_service.py` **没有任何后续提交**（`git log --follow` 输出仅 1 行）。因此本文件不存在「历史演进」维度；上文 §9.4 记录的文档偏差与 §9.2 的已知问题**均属首版即存在**，而非后续修改引入的回归。
