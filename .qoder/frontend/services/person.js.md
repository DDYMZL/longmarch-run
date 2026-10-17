# person.js

## 1. 文件路径

`frontend/services/person.js`（17 行）

## 2. 文件职责

「长征人物志」服务层薄封装：仅「人物详情」一个只读函数，返回人物头像/名称/简介与相关历史事件节点（docstring `frontend/services/person.js:1-3`、`:7`）。

## 3. 业务需求

需求 §14「长征人物志」（docstring `:2` 标注）。P1-8 批次「长征人物志与答题连胜效果」交付（提交 `2a178b7`，`docs/迭代记录.md` 的 `2a178b7` 条目），本文件由该提交创建（`git log --follow` 仅此 1 个提交）。

## 4. 核心功能

| 函数 | 行号 | 后端接口 | 说明 |
|---|---|---|---|
| `getPerson(id)` | `:11-13` | `GET /api/persons/{id}` | 人物详情；`id` 直接拼入路径（`:12`），未做 encodeURIComponent——JSDoc 约定入参为 number（`:8`），调用方需保证数值型 |

请求经 `services/request.js`（`:4`），URL 拼接为 `API_BASE_URL + opts.url`（`frontend/services/request.js:69`）。

## 5. 输入与输出

- `getPerson(id)`：入参人物 id（number）；返回 `{id, name, avatar, brief, nodes:Array}`（JSDoc `:9`），`nodes` 为相关历史事件（路线节点）与历史时间（`:7`）。
- 异常：由 request.js 统一 reject（401 静默重登重试一次，`frontend/services/request.js:122-123`）；id 不存在时后端返回错误（具体错误码见 `.qoder/backend/app/api/routes/persons.py.md`）。

## 6. 依赖关系

- 依赖：仅 `services/request.js`（`:4`）。**无本地缓存**（不经 `services/store.js`）。
- 被依赖（grep `services/person`）：仅 `frontend/pages/person/person.js:7`（`:28` 调 `getPerson(id)`，人物志页本体）。
- 后端契约文档：`.qoder/backend/app/api/routes/persons.py.md`。

## 7. 业务规则

1. 人物与关联历史事件数据由后台维护、后端下发，前端只读展示，不本地造数（`frontend/AGENTS.md` §3.1「后端是唯一数据源」）。
2. 返回的 `avatar` 是后端下发的人物头像 URL（只读展示字段），与用户头像的本地持久化链路（`chooseAvatar` + `auth.persistAvatar`，`frontend/AGENTS.md` §4.4）无关，不适用 `.qoder/PROJECT.md` §8「架构级限制」第 7 项的用户头像丢失问题。

## 8. 修改约束

1. 返回结构 camelCase 硬契约（`backend/AGENTS.md` §4.1），改字段需与后端 persons 路由及 person 页同步。
2. 路径为复数 `/persons/{id}`（`:12`），与后端路由注册一致，勿「纠正」为单数。
3. 保持服务层薄：不得加入人物数据缓存或 Mock（`frontend/AGENTS.md` §3.1）。

## 9. 当前实现状态

- 已实现：唯一导出 `getPerson` 有真实调用方（§6），无死代码。
- 待开发：无（无列表接口——人物入口由路线节点关联跳转，见 `.qoder/backend/app/api/routes/persons.py.md`）。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/services/person.js`，共 **1 个提交**。

### 2026-10-03（`2a178b7`，08:40）
- 需求：长征人物志与答题连胜效果（P1-8，需求 §14）。
- 修改内容（涉本文件）：创建本文件（`getPerson`）；同批交付人物/关联表与人物志页 `pages/person/`（提交信息为唯一证据）。
- 关联文件：`frontend/pages/person/person.js`、后端 `app/api/routes/persons.py`。
- 测试结果：见 `docs/迭代记录.md` 的 `2a178b7` 条目。
