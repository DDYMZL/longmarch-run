# P0-4 长征旅程开场动画 测试报告

日期：2026-10-02 · 范围：march 页首次进入开场动画（1934/瑞金 → 长征开始）、非首次快速过渡、可跳过与缓存（需求 §5，纯前端）

## 改动摘要

- `pages/march/march.js`：data 新增 `showIntro/showVeil`；`onShow` 接入 `maybePlayIntro()`（Storage `lm_march_intro_played` 判定首次/非首次，仅首个 onShow 执行）；`dismissIntro()` 写缓存标记并补播被压后的实景镜头俯冲与抵达事件队列；`playArriveIfNeeded` 与实景镜头俯冲在开场期间暂缓；`onUnload` 清理开场计时器。
- `pages/march/march.wxml/wxss`：开场全屏覆盖层（深红渐变 + 四行文案错峰淡入 + 点击任意处跳过，2.85s 起整体淡出，JS 3.35s 移除）；非首次 500ms 过渡纱幕（`pointer-events:none` 不拦截操作）。纯 CSS 动画，无图片无 rAF，满足 §5.3 轻量/低端机要求。

## 验证结果

| 项 | 方式 | 结果 |
| --- | --- | --- |
| JS 语法 | `node --check pages/march/march.js` | 通过 |
| 页面断言 | `test/automator/p0-opening.cjs`（results-p0o.json） | 5/5 通过 |
| 视觉证据 | `test/images/22-march-intro.png`（开场中段：1934 + 瑞金 · 1934年10月 + 跳过提示） | 人工核对通过 |

automator 断言明细：P0O-01 首次分支 showIntro=true（且页面首次 onShow 已自然播放，naturalFlag=1）；P0O-02 约 3.4s 自然结束且 Storage 写入标记；P0O-03 非首次分支 showVeil=true 且不再播完整开场；P0O-04 纱幕 300~800ms 内自动消失；P0O-05 skipIntro 立即结束并写标记。

## 备注

- 桥延迟可达秒级、超过开场总时长，墙钟轮询会漏判；本测试改为页内 evaluate 确定性重触发（清标记 → 复位实例状态 → `maybePlayIntro` 同步读分支），同时以 naturalFlag=1 佐证真实首进自然播放。此为 automator 瞬时弹层断言的通用范式。
- 开场为纯视觉增强，无后端改动。
