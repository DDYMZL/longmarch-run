# 批次5 身份关联（小程序侧）测试报告

日期：2026-10-09 · 范围：《小程序与 PC 管理后台微信身份关联设计》§小程序侧——扫码确认页（bind）、账号与绑定页（account）、login redirect 支持、mine 入口

## 改动摘要

- `services/identity.js`（新增）：`qrInfo`（POST /auth/qr/info，查询场景并置 scanned）、
  `qrConfirm`（POST /auth/qr/confirm {scene, action}）、`listIdentities`（GET /auth/identities）、
  `unbind`（DELETE /auth/identities/{id}）。
- `pages/bind/bind.{js,wxml,wxss,json}`（新增，app.json 注册）：扫码确认页，按 scene 前缀分流
  L=PC 登录确认 / B=身份绑定确认；未登录先跳登录页（携带 redirect，登录后原路返回）；
  按场景状态渲染确认卡片（pending/scanned）、完成态（confirmed/used/cancelled）与错误态
  （failed 展示后端 failReason、失效/格式非法）；确认/取消提交防重复（submitting 标志）。
- `pages/account/account.{js,wxml,wxss,json}`（新增，app.json 注册）：账号与绑定页，
  身份列表（渠道名/AppID/验证时间/绑定时间，wx_mini 登录凭证不可解绑，wx_web 可解绑）、
  解绑确认（showModal）与空态；时间字段在 JS 预格式化为 YYYY-MM-DD HH:mm（WXML 无方法调用）。
- `pages/mine/mine.{js,wxml}`：新增「账号与绑定」菜单入口（goAccount）。
- `pages/login/login.js`：支持 `?redirect=` 参数——已登录直接回跳；登录成功优先回跳
  redirect（扫码确认流程场景凭证有效期短，不打断），无 redirect 时维持原有 org-select/首页分流。
- `backend/test/fixtures_identity_bind.py`（新增）：B 场景夹具——绑定请求无对外创建接口
  （wx_web 渠道阶段2 门控），测试经 ORM 直接落库两个待确认 B 场景（token 只存 sha256 摘要，
  有效期 4 小时，覆盖断言+截图两个阶段），输出 `fixtures-identity.json` 供套件读取。

## 验证结果（automator）

执行：`cd frontend/test/automator && SUPER_TOKEN=... node identity-ui-test.cjs` —— **15/15 通过**
（`results-identity.json` / `identity.log`）。角色授予/回收仅针对自动化测试用户且测试后立即回收
（`role_ids:[]`），未将普通用户升级为管理员。

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| I00 | 登录态就绪（已登录且已选组织） | 通过 |
| I01 | 无效场景（格式非法）展示错误态「无效的扫码场景」 | 通过 |
| I02 | B 场景渲染绑定确认卡片（phase=confirm mode=bind） | 通过 |
| I03 | 确认绑定成功进入完成态「已完成」 | 通过 |
| I04 | mine 页存在「账号与绑定」入口并可进入 | 通过 |
| I05 | 身份列表展示绑定结果（wx_web 已验证、可解绑） | 通过 |
| I06 | 解绑成功后列表进入空态 | 通过 |
| I07 | L 场景渲染登录确认卡片（phase=confirm mode=login） | 通过 |
| I08 | 无后台权限确认被拒并展示原因（403「无后台访问权限，请联系管理员授权」） | 通过 |
| I09 | API 授予 operator 角色（测试用户，测后回收） | 通过 |
| I10 | 有权限确认登录成功进入完成态 | 通过 |
| I11 | API 回收角色（清理） | 通过 |
| I12 | 未登录扫码跳转登录页 | 通过 |
| I13 | 登录后 redirect 原路返回扫码确认页 | 通过 |
| I14 | 取消操作进入「已取消」完成态 | 通过 |

截图巡礼（`node identity-shots.cjs`，与断言分离，每状态独立连接+主动导航起手）—— **6/6 通过**
（`identity-shots.log`，截图 `frontend/test/images/b5-*.png`，已逐张人工目检内容）：

| 截图 | 状态 |
| --- | --- |
| b5-01-mine-entry.png | mine 页含「账号与绑定」入口 |
| b5-02-bind-confirm-bind.png | B 场景绑定确认卡片（渠道 wx_web · wx-web-b4test） |
| b5-03-account-list.png | 账号与绑定：1 条 wx_web 身份（已验证 + 解绑按钮） |
| b5-04-account-empty.png | 账号与绑定空态（暂无已绑定身份） |
| b5-05-bind-confirm-login.png | L 场景登录确认卡片（确认登录 PC 管理后台？） |
| b5-06-bind-error.png | 错误态（无效的扫码场景） |

## 已踩坑记录

- **IDE 重启后存储用户被替换（orgId 丢失）**：首轮截图 b5-01 实际截到 org-select 页——
  taskkill 强杀 IDE 后重启，模拟器存储里的用户变成无 orgId 的新用户（启动期出现一次真实
  wx.login 建了新号），mine onShow 弹回组织选择。修复：截图脚本每个状态前 `ensureLogin`
  （已登录且已选组织则复用，否则重置登录态 → mock wx.login → doLogin → confirmSelect(1)），
  状态自愈，不依赖前序状态与 IDE 存储。
- **截图成功 ≠ 内容正确**：b5-01 首次「拍到了」但内容是错误页面；断言套件有 data 校验兜底，
  纯截图巡礼必须逐张目检内容，不能只看文件生成。
- **B 场景夹具 10 分钟有效期不够**：断言套件与截图巡礼两个阶段间隔超过 10 分钟，b5-03 恰在
  过期后 20 秒执行，qrInfo 返回「不存在或已过期」→ 错误卡片，等待确认卡超时。夹具有效期改 4 小时。
- **wx_web 绑定无创建接口**：B 场景只能经 ORM 落库（fixtures_identity_bind.py），不能像
  L 场景那样 POST /api/admin/wechat/qr 现取；断言与截图两个阶段各预留一枚待确认场景。
