# P0-3 长征章节系统（小程序侧）测试报告

日期：2026-10-02 · 范围：march 页章节卡 + 章节完成仪式卡、home 页同步弹层接章节队列、共用抵达队列播放器抽取

## 改动摘要

- `services/march.js`：`lightUpNodes()` 返回结构升级为 `{newlyLit, newlyCompletedChapters}`。
- `pages/march/march.js`：data 新增 `chapters/currentChapter`；`renderRoute` 预计算 `progressPct` 并选出当前章节（全部完成时展示末章）；`playArriveIfNeeded` 消费 `_pendingLit + _pendingChapters` 两个挂起队列。
- `pages/march/march.wxml/wxss`：地图上方新增当前章节卡（标题 + 已点亮/总数 + 进度条）；弹层新增章节仪式分支（🚩 + 「🎉 章节完成」+ 标题 + 历史介绍）。
- `pages/home/home.js/wxml/wxss`：`handleSyncSteps/handleAddSteps` 适配新返回结构；弹层同样支持章节仪式卡（`.chapter-lit-card .lit-chapter-intro`）。
- `utils/arrivePopup.js`（新增）：home/march 共用的抵达队列播放器（节点卡 2400ms → 章节卡 3400ms），消除两页重复实现（自查优化项）。
- 后端配套：`route` 下发 `chapters/currentChapterId`；`light-up` 返回 `newlyCompletedChapters`；写 `CHAPTER_COMPLETE` 事件（见 backend/test/docs/p0-chapters-report.md，10/10 通过）。

## 验证结果

| 项 | 方式 | 结果 |
| --- | --- | --- |
| JS 语法 | `node --check`（march.js / home.js / services/march.js / utils/arrivePopup.js） | 通过 |
| 页面断言 | `test/automator/p0-chapters.cjs`（results-p0ch.json） | 3/3 通过 |
| 视觉证据 | `test/images/20-march-chapter-card.png`（第二章 ACTIVE 章节卡）、`21-march-chapter-ceremony.png`（第二章完成仪式卡，真实队列弹出） | 人工核对通过 |
| 重构回归 | 抽取共用播放器后重跑 p0-chapters.cjs | 3/3 通过 |

automator 断言明细：P0CH-01 0 步章节卡展示「第一章 · 出发」1/2、进度 50%；P0CH-02 +5000 步章节完成仪式卡弹出（kind=chapter，含标题与历史介绍）；P0CH-03 仪式结束后章节卡切换为「第二章 · 转折」ACTIVE、第一章 COMPLETED。

## 备注

- 截图 21 为 light-up 真实响应驱动的仪式卡（非合成重放）；一次性补拍脚本 `shot-chapter-ceremony.cjs` 保留备查（独立连接 + setData 直放，规避桥退化下轮询错过瞬时弹层）。
- 登录 mock 必须带验证循环（确认 `wx.login` 返回目标 code 再继续），否则 UI 账号与 API 补步数账号不一致会导致弹层缺失的假失败。
