# 行军日历详情弹层「点亮节点」换行修复验证报告

- 日期：2026-10-15 13:20
- 范围：`frontend/pages/calendar/calendar.wxml`、`calendar.wxss`
- 脚本：`frontend/test/automator/calendar-detail-layout.cjs`
- 结果：**2/2 通过**（`results-calendar-layout.json`）

## 问题

当日详情弹层中，点亮节点展示 ⭐ 长文本时，右侧 `detail-value text-gold` 盒子整体掉到下一行，与 `detail-label`（点亮节点）不在同一行；短文本（如「无」「已完成，得分 X」）表现正常。

## 原因

`<text>` 是行内组件，长内容场景下在 flex 行内表现为原子行内盒：剩余行宽放不下时整个盒子被挤到下一行，而不是在盒内换行。此外模板中 ⭐ 表达式独占多行，文本首尾混入空白。

## 修复

- `.detail-value` 显式 `display: block`（块级化后作为标准 flex 项参与布局）+ `word-break: break-all`，保留 `max-width: 400rpx` 右对齐；
- `.detail-label` 加 `flex-shrink: 0`，长值挤压时标签不缩水；
- WXML 中 ⭐ 表达式收为单行。

## 验证（微信开发者工具 automator，ws://127.0.0.1:9420）

直接 `setData` 注入 `selected`（6 个节点名长文本 / 无点亮两种），`createSelectorQuery` 取「点亮节点」行 label 与 value 的 `boundingClientRect`：

| 用例 | 断言 | 实测 |
| --- | --- | --- |
| C1 长文本 | 同行（top 差 ≤ 3px）且 value 在 label 右侧 | label.top=398.6 / value.top=398.6（差 0），value.h=62.4px（盒内 3 行换行） |
| C2 无点亮 | 同上 | label.top=419.4 / value.top=419.4（差 0），单行 20.8px |

- 截图证据：`frontend/test/images/calendar-detail-stars.png`（长文本在右侧盒内换行、首行与标签同行）
- `node --check calendar-detail-layout.cjs` 通过

## 备注

- 长连接自动化桥易退化，脚本按测试协议 3b/3d 每个用例独立建连并以主动 reLaunch 唤醒；截图放在最后一步执行。
- 未做真机预览（不同机型字体渲染可能略有差异）。
