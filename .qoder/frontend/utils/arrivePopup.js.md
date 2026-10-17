# arrivePopup.js

## 1. 文件路径

`frontend/utils/arrivePopup.js`（50 行）

## 2. 文件职责

「抵达事件队列播放器」：把 light-up 接口返回的新点亮节点与新完成章节合并成一个卡片队列，按「节点抵达卡 → 章节完成仪式卡」顺序在页面上逐个弹出（`frontend/utils/arrivePopup.js:1-5` 模块 docstring）。home 与 march 两页共用，消除重复实现（`frontend/test/docs/p0-chapters-report.md` 对 `6a2fae3` 批次的记录）。

模块自身**无状态**：弹窗数据写在页面 `data.litPopup`、定时器句柄写在页面实例属性 `popupTimer` 上（`:37`、`:41`、`:43-44`），模块内只有两个停留时长常量。

## 3. 业务需求

- 需求来源：长征章节系统（P0-3，提交 `6a2fae3`，2026-10-02）——章节完成仪式卡与节点抵达卡共用一个队列播放器（`frontend/design.md` 中「长征章节（006 P0-3）」段的描述与模块 docstring `:2-3` 一致）。
- 停留时长的业务理由：章节卡含历史介绍，停留比节点卡久（`:8` 注释「章节卡含历史介绍，停留稍久」）。

## 4. 核心功能

### 4.1 常量（`:7-8`）

- `NODE_CARD_MS = 2400`：节点抵达卡停留 2400ms。
- `CHAPTER_CARD_MS = 3400`：章节完成仪式卡停留 3400ms。

### 4.2 `buildQueue(newlyLit, newChapters)`（内部函数，`:10-23`，未导出）

把两类输入归一为统一卡片结构后串联：

- 节点卡（`:12-19`）：`{ kind: 'node', name, icon（缺省 '★'）, historicalTime（缺省 ''）, nextName / nextRemain（取自 n.nextNode，缺省 ''/0） }`；
- 章节卡（`:21`）：`{ kind: 'chapter', title, intro（缺省 ''） }`，`concat` 在节点卡之后——顺序固定为「先节点后章节」（`:20-22`）。
- 入参容错：`newlyLit || []`、`newChapters || []`（`:11`、`:21`）。

### 4.3 `playArriveQueue(page, newlyLit, newChapters)`（唯一导出，`:31-48`、`:50`）

- 用闭包变量 `i` 与递归 `setTimeout`（`showNext`）逐卡播放：每步 `page.setData({ litPopup: card })`（`:41`），队列播完后置 `litPopup: null` 收尾（`:36-39`）。
- 每次排定下一张卡前先 `clearTimeout(page.popupTimer)`（`:43`），句柄回写 `page.popupTimer`（`:44`）——同一页面重复调用（连续两次 light-up）不会双链并发，后一次会顶掉前一次的定时器（但前一次队列的闭包 `i` 随旧链一起被丢弃）。
- **返回值**：队列总播放时长 ms（`:47`，`reduce` 累加各卡 `cardMs`），供页面安排后续跳转——march 页存入 `this._popupMs`（`frontend/pages/march/march.js:229`），在弹窗播完后才延时触发完成仪式页跳转（`march.js:189-190`）。

## 5. 输入与输出

- 输入：`page`（页面实例，须具备 `setData`；`popupTimer` 属性由本模块读写）；`newlyLit`（light-up 返回的新点亮节点数组，元素须含 `name`，可含 `icon`/`historicalTime`/`nextNode{name, remain}`）；`newChapters`（新完成章节数组，元素须含 `title`，可含 `intro`）。
- 输出：总播放时长（number，ms）；副作用为对 `page.data.litPopup` 的若干次 `setData` 与 `page.popupTimer` 的读写。
- 异常：无显式抛错分支；`newlyLit`/`newChapters` 为 null/undefined 时按空数组处理，队列长度为 0 时立即 `setData({ litPopup: null })` 并返回 0。
- 卡片数据由页面 WXML 的 `litPopup` 弹层消费（home/march 页各自渲染，本模块不含视图）。

## 6. 依赖关系

- 依赖：无（不 require 任何模块，不用 wx API，纯 JS）。
- 被依赖（全仓 grep `arrivePopup|playArriveQueue` 核实的**全部**调用方，共 2 处）：
  - `frontend/pages/home/home.js:18`（require）、`:325`（light-up 成功后 `playArriveQueue(this, res.newlyLit, res.newlyCompletedChapters)`，返回值未使用）；
  - `frontend/pages/march/march.js:14`（require）、`:229`（`this._popupMs = playArriveQueue(this, lit, chapters)`）。
- 上游数据契约：卡片字段来自后端 `POST /march/light-up` 响应的 `newlyLit`（含 `nextNode`）与 `newlyCompletedChapters`（含 `title`/`intro`），经 `frontend/services/march.js` 透传（调用方传参见上；后端字段口径见 `.qoder/backend/app/api/routes/march.py.md`）。
- 定时器清理契约（`:4` docstring 明确「页面需在 onHide/onUnload 自行 clearTimeout」）：home 页 `onHide`/`onUnload` 均清 `popupTimer`（`frontend/pages/home/home.js:127-137`）；march 页同样在 `onHide`（`march.js:131`）与 `onUnload`（`march.js:140`）清理。**两处调用方均已履行该契约**（`e70b59f` 代码审查批次的「计时器清理」项）。

## 7. 业务规则

1. **播放顺序固定**：节点卡在前、章节卡在后（`:20-22` 的 `concat` 顺序），与需求「节点抵达 → 章节完成仪式」的叙事顺序一致（`:2-3` docstring）。
2. **串行不并行**：任一时刻页面上至多一张 `litPopup` 卡；重复触发时旧定时器被清除（`:43`）。
3. **总时长可预算**：返回值让 march 页能把「仪式页跳转」排在弹窗队列播完之后（`march.js:189-190`），避免弹窗未播完就跳页。
4. 缺省兜底：`icon` 缺省 `'★'`、`historicalTime`/`intro` 缺省空串、`nextNode` 缺失时 `nextName`/`nextRemain` 为 `''`/`0`（`:15-18`、`:21`）——渲染层不必判空。

## 8. 修改约束

1. **卡片结构是页面 WXML 的硬契约**：`kind/name/icon/historicalTime/nextName/nextRemain/title/intro` 任一字段增删改名，须同步 home 与 march 两页的弹层 WXML（`frontend/AGENTS.md` §5.2 WXML 不支持原生方法调用，展示字段须在 js 侧备好——本模块正是这一约定的落点）。
2. `page.popupTimer` / `data.litPopup` 的属性名不得改：两个调用页的 `onHide`/`onUnload` 按此名清理定时器（`home.js:129`、`:135`；`march.js:131`、`:140`），改名会造成定时器泄漏。
3. 保持无状态与无 wx API 依赖：模块可被任意页面复用；若引入模块级状态会破坏「重复调用后链顶掉前链」的语义（§7.2）。
4. 停留时长常量改动会同时影响两页与 march 的仪式跳转延时（`_popupMs` 由返回值推导，自动跟随）。
5. 按 `frontend/AGENTS.md` §5.1，此类共用纯逻辑必须留在 utils，不得回抄进页面。

## 9. 当前实现状态

- **已实现**：队列播放、统一卡片结构、总时长返回，home/march 双页接入；随 `6a2fae3` 交付，`e70b59f`、`44eb77b` 两次演进（见 §10）。
- **存在问题 / 已知事项**：
  1. 重复触发时旧队列被静默丢弃（新链 `clearTimeout` 旧链，`:43`），旧队列剩余卡片不再播放——现状行为，是否需要合并队列**待确认**（light-up 通常由单次步数同步触发，实际并发概率低）。
  2. home 页未使用返回值（`home.js:325` 不接收），仅 march 页依赖 `_popupMs`——非缺陷，属两页跳转需求差异。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/utils/arrivePopup.js`，共 **3 个提交**；对应条目均见 `docs/迭代记录.md`。按时间倒序。

### 2026-10-13（`44eb77b`）
- 需求：V2.0 小程序批次（答题限时/积分排行榜等）。
- 修改内容（涉本文件，据 `git show 44eb77b` diff）：节点卡删除 `gainedPoints` 字段并同步 JSDoc——卡片不再携带积分数。
- 关联文件：`frontend/pages/quiz/quiz.js`、`frontend/utils/util.js`（同批新增 `quizDots`）等 V2.0 范围文件。
- 测试结果：见 `docs/迭代记录.md` 的 `44eb77b` 条目。

### 2026-10-11（`e70b59f`）
- 需求：小程序代码审查修复批次（计时器清理、精简 setData 等）。
- 修改内容（涉本文件，据 `git show e70b59f` diff）：① 新增返回值「队列总时长 ms」（`:47`），抽出 `cardMs` 辅助函数；② 删除每张卡的 `card.key = Date.now()`（精简 setData 负载）；③ JSDoc 补 `@returns`。
- 关联文件：`frontend/pages/march/march.js`（开始消费 `_popupMs`）、`frontend/utils/routeCanvas.js`、`frontend/data/node-themes.js` 等同批审查文件。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目。

### 2026-10-02（`6a2fae3`）
- 需求：长征章节系统（P0-3）——5 章配置化划分、章节完成仪式与 CHAPTER_COMPLETE 事件。
- 修改内容（涉本文件）：创建本文件，home/march 共用的抵达队列播放器（节点卡 2400ms → 章节卡 3400ms），消除两页重复实现（`frontend/test/docs/p0-chapters-report.md`）。
- 关联文件：`backend/app/services/march_service.py`、`frontend/pages/home/home.js`、`frontend/pages/march/march.js`。
- 测试结果：`node --check` 通过（`frontend/test/docs/p0-chapters-report.md`）；其余见 `docs/迭代记录.md` 的 `6a2fae3` 条目。
