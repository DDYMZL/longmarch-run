# S32 复制导入题目 · 后端测试报告

- 日期：2026-10-28
- 范围：`POST /api/admin/questions/paste-import`、`POST /api/admin/questions/batch-score`
- 脚本：`backend/test/s32_paste_question_import.py`（TestClient + 临时 SQLite）
- 结果：`backend/test/s32-paste-question-import-results.json`，**7/7 通过**
- 无 SQL 迁移、无新表新列

## 1. 口径

- 单次最多 500 道。服务端忽略客户端分值，统一写入 20。
- 一次查出已有题干、一次取最大 id，`add_all` 后一次提交。非法或重复的行跳过，其余照常写入。
- 改分是一条 `UPDATE ... WHERE id IN (...)`，分值 1–100，最多 500 个 id。

## 2. 用例

| 编号 | 场景 | 结果 |
| --- | --- | --- |
| P01 | 三题一次写入，分值均为 20 | 通过 |
| P02 | 库内重复、批内重复、答案不在选项中：跳过，合法题写入 | 通过 |
| P03 | 501 道整批拒绝，不写库 | 通过 |
| P04 | 500 道写入 0.24 秒，再改分 0.06 秒，500 行分值变为 30 | 通过 |
| P05 | 改分只影响传入的 id | 通过 |
| P06 | 分值 0 与空 id 列表返回 400 | 通过 |
| P07 | 未登录 401 | 通过 |

## 3. 结论

500 题的写入和改分都在一次数据库往返内完成，耗时远低于接口超时。
