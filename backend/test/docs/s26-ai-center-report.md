# S26 · AI 智能中心（Phase A 后端）验收报告

- 日期：2026-10-17
- 范围：需求《长征步迹 AI 智能中心开发需求 V1.0》Phase A 后端部分——历史助手对话（§3.1）、路线节点讲解（§3.2）、答题解析（§3.3）、管理端 AI 智能中心接口（§3.4 的服务/接口层）、题目工坊持久化、配置中心、用量日志；数据库迁移 `docker/init/021_ai_center.sql`、`022_ai_admin_menus.sql`（docker/ 按仓库规则不随任务提交，已在本地 openGauss 应用并登记 schema_migrations）。
- 脚本：`backend/test/s26_ai_center.py`（TestClient + SQLite 临时库 `_smoke_s26.db`，不依赖 8010/openGauss；L 组真实调用 Agent 需 API Key 与 `LM_TEST_DNS_MAP`）。
- 结果文件：`backend/test/s26-ai-center-results.json`。

## 1. 冒烟套件：47/47 PASS

| 组 | 覆盖 | 结果 |
| --- | --- | --- |
| C 配置中心 | 生效值/默认/范围/三类提示词、覆盖持久化、非法值 400、鉴权 401/403、响应不泄密钥 | 5/5 |
| K 知识库 | 增改删查、草稿→发布流转、校验 400、鉴权 403、发布后才可检索 | 7/7 |
| H 历史助手 | camelCase 契约落库、连续对话带历史、列表/详情、跨账号隔离（读/删 404、带他人会话提问 400）、删除清消息、超长 400、空输入 422、AI 关闭 403 不调模型、日限额 429、上游故障 502 回滚用户消息、来源为已发布资料、用量日志落库、不泄密钥 | 12/12 |
| R 路线讲解 | 优先已发布知识、无知识回退节点字段、草稿绝不出现、节点 404、AI 关闭仍 200 且不调模型 | 6/6 |
| Q 答题解析 | 题库解析直返不调模型、无解析才调模型且提示词以库内正确答案为准、未作答 400、AI 关闭 403、题目不存在 400 | 6/6 |
| W 题目工坊 | 任务+草稿持久化、列表/详情回溯、编辑重算待修正问题、审核通过/驳回、幂等导入题库（仅通过项、回填 question_id、重复导入 skipped）、鉴权 403、知识接地、失败 502 落库 | 11/11 |
| G 回归安全 | 旧内存态出题链路不受影响、响应不泄密钥 | 2/2 |
| L 真实 Agent | 真实调用完成一次历史助手对话 | 1/1 |

关键实测值（摘自 results json）：
- H01 契约：`conversationId/reply/sources/title/usedTokens`，用户+助手消息落库 2 条。
- H05 隔离：他人会话 get=404 del=404、带他人会话 ID 提问 400，原会话完好。
- H10 限额：前 2 次 200、第 3 次 429。
- H11 上游故障：502 且会话/消息数不变（不残留半截对话）。
- Q02 防作弊服务端兜底：提示词 `ans_in_prompt=True`（以库内正确答案为准，不信客户端）。
- W06/W07 导入：仅 approved 入库并回填 question_id；重复导入 skipped，题库不增。
- L01 真实 Agent：reply 163 字、usedTokens=19989（2026-10-17 关闭外网 VPN 后无 dns_shim 复跑值；此前带 shim 首跑为 143 字/19715）；空来源场景模型拒答不编造。

## 2. 真实 openGauss 验证（docker 容器 longmarch-opengauss，5118）

一次性校验脚本跑完后已删除（不留临时脚本入库），实测结果：

1. `021_ai_center.sql`、`022_ai_admin_menus.sql` 经容器内 gsql 应用成功，并按 init-db.sh 约定向 `schema_migrations(version, applied_at)` 登记；脚本遵循 `docker/SQL_CONSTRAINTS.md`（DO 块建索引、无 ON CONFLICT、事务包裹）。
2. 新增 6 张表、9 个索引、5 条管理菜单（ai_knowledge/ai_config/ai_workshop/ai_usage 相关）逐一存在。
3. ORM models 与真库列逐表比对 ALL_MATCH（含 JSON/JSONB 列类型）。
4. JSON 列写入/读回 round-trip 正常；验证数据随后回滚删除，库恢复干净（不污染现有业务数据）。
5. 真库上真实 Agent 对话一次：reply 194 字、usedTokens=431，内容为 1934–1936 年长征史实概述，与已发布知识来源一致。

## 2b. 复跑记录（2026-10-17，外网 VPN 关闭后）

- 本机对 CloudBase 网关域名的 fake-ip 劫持（198.18.x）根因确认为外网 VPN 的 DNS 接管；VPN 关闭后 `socket.getaddrinfo` 返回真实 IP（81.69.x）。
- 不设 `LM_TEST_DNS_MAP`（dns_shim 空转）重跑全量：**47/47 PASS**，L01 真实 Agent 原生网络直达（reply 163 字、usedTokens=19989），`s26-ai-center-results.json` 已更新为该次结果。dns_shim 仅保留为网络异常时的兜底手段。

## 3. 环境与限制说明

- 本机网关对 CloudBase 域名的 DNS 劫持（fake-ip 198.18.x）已于 2026-10-17 确认根因为外网 VPN；VPN 关闭后真实 Agent 调用无需任何 hosts/DNS 干预（见 §2b）。普通 uvicorn/httpx 进程在 VPN 开启态超时属环境限制，非代码缺陷。
- 小程序模拟器真实链路（UI → 本机后端 → Agent）已验收，见 `frontend/test/docs/ai-chat-page-report.md`；真机链路待验证。

## 4. 待验证 / 后续阶段

- 管理后台 Vue 五个子页面（§3.4 前端）、运行概览与调用记录（usage/cost）、node-detail 讲解面板、答题页 AI 讲解按钮：按需求 §13 排在后续阶段，本提交未包含。
- 小程序 AI 问答页真机（非模拟器）体验与真实 Agent 回答展示：待验证（模拟器渲染与交互已验收，见 `frontend/test/docs/ai-tab-swap-report.md` 与 ai-chat 截图）。
