# P1-2 同组织同行者（小程序侧）测试报告

日期：2026-10-03 · 范围：首页「🚩组织同行」卡片（需求 §9：我的组织/同行人数/今日共同前进/同行者）

## 改动摘要

- `services/org.js`：新增 `getCompanions(limit)`。
- `pages/home/home.js`：`refreshAll` 第 7 路拉取组织同行（失败不阻塞主数据）；视图模型预格式化（`stepsText` 千分位、`rowKey` 合成键）。
- `pages/home/home.wxml`：组织同行卡（标题 + 组织名标签 + 全路径 + 双统计区 + 同行者列表，本人行高亮「我」徽标，无组织时不渲染）。
- `pages/home/home.wxss`：org-tag/org-stats/companion-* 样式。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P1G-01 | 卡片组织信息：orgName=前端组，orgFullName 含「技术部 / 前端组」 | 通过 |
| P1G-02 | 同行者本人行：isSelf 置顶（20000 步全组织今日最高）、昵称与千分位步数正确 | 通过 |
| P1G-03 | 统计区：memberCount ≥1、todayTotal ≥20000 | 通过 |

执行：`node test/automator/p1-companions.cjs`（results-p1g.json）—— **3/3 通过**；视觉证据 `test/images/24-home-companions.png`（滚动至卡片拍摄）人工核对通过。

## 备注

- 同行者列表因隐私设计不含用户 id，`wx:key` 使用 JS 合成 `rowKey`（序号+昵称），避免使用保留字 `index`（参见既有踩坑记忆）。
- 断言用「本人 20000 步置顶」规避组织 12 内历史测试用户今日步数的干扰。
