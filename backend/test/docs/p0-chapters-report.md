# P0-3 长征章节系统 测试报告（后端）

日期：2026-10-02 · 范围：`GET /api/march/route` 新增 `chapters / currentChapterId`；`POST /api/march/light-up` 新增 `newlyCompletedChapters`；`CHAPTER_COMPLETE` 事件

## 用例与结果（test/p0_chapters.py，黑盒 HTTP @8010）

| 用例 | 场景 | 期望 | 结果 |
| --- | --- | --- | --- |
| P0C-01 | 0 步新用户 | 5 章；第一章 ACTIVE（瑞金 target 0 已点亮，1/2，progress 0.5）；currentChapterId=1 | PASS |
| P0C-02 | 0 步 | 第 2~5 章全部 LOCKED | PASS |
| P0C-03 | +5000 步 light-up | newlyCompletedChapters 含「第一章 · 出发」（含 title 与 intro） | PASS |
| P0C-04 | +5000 步后 route | 章1 COMPLETED、章2 ACTIVE、currentChapterId=2 | PASS |
| P0C-05 | 累计 25000 步 light-up | 一次点亮跨章完成第 2、3 章（newlyCompletedChapters=[2,3]） | PASS |
| P0C-06 | 累计 25000 步后 route | 章1-3 COMPLETED、章4 ACTIVE、currentChapterId=4 | PASS |
| P0C-07 | 累计 65000 步 light-up | newlyCompletedChapters=[4,5] | PASS |
| P0C-08 | 累计 65000 步后 route | 全部 COMPLETED、currentChapterId=null、finished=true | PASS |
| P0C-09 | 足迹时间轴 | 5 条 CHAPTER_COMPLETE，文案「完成长征章节「第X章 · …」」 | PASS |
| P0C-10 | 重复 light-up | 幂等：newlyLit=[]、newlyCompletedChapters=[] | PASS |

**10/10 通过。**

## 备注

- 章节配置：`march_service.CHAPTERS`（5 章 × 2 节点，node_ids 对应 route_nodes 主键；intro 为公开史实概述）。章节状态基于节点状态计算，全部停用的章节不下发。
- 完成判定：`light_up_nodes` 对比点亮前后已完成章节集合，差集写 `CHAPTER_COMPLETE` 事件并随响应返回；不新增积分项，不改变节点点亮规则（需求 §4.5）。
- 排查插曲：本次冒烟前 8010 再次命中孤儿 uvicorn worker（spawn_main parent_pid=17284 已死、PID 27260 存活）供旧代码，`/openapi.json` 无 `newlyCompletedChapters` 字段暴露；`touch` 触发 WatchFiles 无效后清孤儿重启恢复。
