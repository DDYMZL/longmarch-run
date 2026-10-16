# S26 后端验收报告 · AI 智能出题（CloudBase Agent）+ Excel 导入保留

- 日期：2026-10-16
- 范围：`backend/app/services/cloudbase_service.py`、`backend/app/services/ai_question_service.py`、`backend/app/api/routes/admin.py`、`backend/app/schemas/schemas.py`、`backend/app/core/config.py`
- 冒烟脚本：`backend/test/s25_ai_question_generate.py`（结果 JSON：`test/s25-ai-question-generate-results.json`）
- 结论：**冒烟 16/16 通过**（含 2 次真实 CloudBase Agent 调用）；管理后台浏览器验收见 `admin/test/docs/s26-ai-question-admin-report.md`

## 1. 接口说明

### POST /api/admin/ai/generate-questions

管理员 JWT + `questions` 菜单权限（`require_menu("questions")`）。生成结果**只返回草稿，不写库**。

请求：

```json
{
  "topic": "红军长征中的重要战役",
  "count": 10,
  "question_type": "single",
  "difficulty": "medium",
  "category": "event",
  "extra_requirements": "史实准确，避免重复，附简明解析"
}
```

- `count`：1~100（`AI_QUESTION_MAX_COUNT`），后端按 `AI_QUESTION_BATCH_SIZE` 拆批、`AI_QUESTION_MAX_CONCURRENCY` 并发调用 Agent，一次性返回；
- `question_type`：仅 `single`（小程序答题逻辑仅支持单选，多选/判断不开放）；
- `difficulty`：`easy|medium|hard|mixed`，仅作生成约束，**不入库**；
- `category`：`event|route|figure` 或空串（不限）。

响应：`{ requested, generated, valid_count, invalid_count, items: [{ index, data: AdminQuestionUpsert, errors: [] }], batch_errors: [] }`。
`items[].errors` 非空时表示该草稿待修正（答案缺失/选项不完整/与库内或批内重复等），前端禁止勾选保存。

错误码：参数非法 400/422；未登录 401；无 `questions` 菜单 403；Agent 超时/鉴权失败/服务不可用/回复截断 502；Agent 回复无法解析为题目 400（明确中文提示）。

### POST /api/admin/ai/questions/batch-save

同样受 `require_menu("questions")` 保护。请求 `{ "questions": [AdminQuestionUpsert...] }`（上限 100 条）。
**后端逐条重新校验**（复用 `admin_service._validate_question`）+ 库内查重 + 批内查重；主键沿用现有 `max(id)+1` 分配方式；单事务提交，异常整体回滚。
响应：`{ saved, failed, failures: [{ index, reason }] }`，`index` 从 1 起对应提交顺序。

## 2. 环境变量（仅后端，禁止进入前端/仓库公开文件/日志/响应）

```
CLOUDBASE_ENV_ID=longmarch-run-d5gp70nsd0d2ca307
CLOUDBASE_AGENT_ID=agt-zy-7gnauryrb6fad70e
CLOUDBASE_API_KEY=<环境 service_role ApiKey>
CLOUDBASE_AGENT_URL=            # 留空则按 https://{ENV_ID}.api.tcloudbasegateway.com/v1/aibot/bots/{AGENT_ID}/acp 拼接
CLOUDBASE_TIMEOUT_SECONDS=180   # 单批调用超时
AI_QUESTION_BATCH_SIZE=10       # 每批生成题数
AI_QUESTION_MAX_CONCURRENCY=3   # 批间并发上限
AI_QUESTION_MAX_COUNT=100       # 单次生成/保存上限
```

`.env.example` 只含占位符；真实密钥仅写在 `backend/.env` 与 `backend/.env.prod`（按用户决定入库，由用户本人提交）。
日志只记录异常类名与批序号，不记录密钥、不记录完整请求体；响应经 A13 用例断言不含密钥指纹。

## 3. ACP 协议实现要点（实测确认）

- `POST {CLOUDBASE_AGENT_URL}`，头：`Content-Type: application/json; charset=utf-8`、`Accept: text/event-stream`、`Authorization: Bearer {KEY}`；
- body 为 JSON-RPC 2.0 `session/prompt`，无需预建 sessionId（网关自动创建并在 `params.sessionId` 回传）；
- SSE 仅累加 `params.update.sessionUpdate == "agent_message_chunk"` 且 `content.type == "text"` 的 `content.text`；忽略 thought/usage/phase 事件；
- 结束判定：`result.stopReason` 必须为 `end_turn|stop_sequence`，否则视为截断报错；最后 `data: [DONE]`；
- 请求体必须 UTF-8 编码（中文乱码会导致 Agent 回复乱码）。

## 4. 冒烟结果（16/16）

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| A01 | Excel 模板下载未受影响（双工作表/表头） | 200，sheets=2 |
| A02 | Excel 预览+确认导入未受影响 | preview 3/0，imported=3 |
| A03 | 生成接口参数校验（主题/数量/难度/分类/题型） | 400/422 符合预期 |
| A04 | 未登录 401；无 questions 菜单管理员 403（生成与保存均校验） | 通过 |
| A05 | Agent 故障映射：超时/鉴权/服务异常/截断→502，无效 JSON→400 | 通过 |
| A06 | Markdown 代码围栏包裹的 JSON 可解析 | generated=2 valid=2 |
| A07 | 草稿校验：答案缺失/选项不全/答案为空/标签重复/库内重复/结构非法 | valid=1 invalid=6 |
| A08 | 生成仅返回草稿，正式题库无变化 | before==after |
| A09 | 批量保存后端重校验：合法题入库 id=max+1 连续，非法题进 failures | saved=4 failed=3 |
| A10 | 重复题识别：库内重复、批内重复 | 通过 |
| A11 | 空列表保存 400 | 通过 |
| A12 | 保存后列表可查，字段结构与 Excel 导入题目同构 | same_shape=True |
| A13 | 生成/保存/列表响应不泄露 CLOUDBASE_API_KEY | 5 个响应均无指纹 |
| A14 | **真实 Agent** 生成 10 道单选：结构合规、答案唯一且在选项内 | generated=10 valid=10 |
| A15 | **真实 Agent** 生成 50 道：长响应完整、去重通过 | generated=50 valid=50 unique=50 |
| A16 | 小程序下发契约不变：camelCase 且不含 answer/analysis | keys=[id,options,question,score,type] |

## 5. 数据库变更说明

**无任何变更**。AI 题目写入现有 `questions` 表，字段约定与 Excel 导入完全一致；难度不入库，故无需迁移，生产库零改动。

## 6. 线上部署步骤

1. 更新代码：`cd /mnt/data/longmarch-run && git pull`；
2. 在服务器 `backend/.env.prod` 追加第 2 节的 CloudBase 变量（密钥从腾讯云控制台获取，勿经聊天工具传输）；
3. 重启服务：`systemctl restart longmarch-backend`（`APP_ENV=prod`）；
4. 验证：`curl -s http://127.0.0.1:8010/api/admin/questions/import-template -o /dev/null -w '%{http_code}'` 应为 200（需带管理员令牌的业务接口同理）；管理后台「题库维护 → AI 智能出题」生成 10 题并保存 1 题，列表可查；
5. 无需执行任何 SQL 迁移。

## 7. 兼容性与安全结论

- Excel 模板下载/导入/题库增删改查接口全部保持原状（A01/A02/A12）；
- 小程序答题接口请求与响应格式未改动（A16）；
- API Key 仅存在于后端进程环境，浏览器、仓库公开文件、日志、接口响应均不含密钥（A13）；
- AI 结果必须管理员勾选确认后经 batch-save 入库，且入库前后端二次校验（A08/A09）。
