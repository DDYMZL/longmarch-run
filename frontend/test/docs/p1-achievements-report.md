# P1-7 我的成就总览 + 数据画像（小程序侧）测试报告

日期：2026-10-03 · 范围：档案页新增成就总览六格卡（需求 §18）与数据画像雷达卡（需求 §17）

## 改动摘要

- `pages/profile/profile.js`
  - 新增 `achievements` 视图模型（六格：行军/路线/情报/连续/勋章/积分，值取自 summary 预格式化）。
  - 新增 `goAchievement(e)`：行军→行军日历、路线→长征 tab（switchTab）、情报→答题记录、连续→运动记录、勋章→勋章页；积分无独立详情页不跳转。
  - 新增 `drawPortrait()`：`type="2d"` canvas 绘制五维雷达——三层五边形网格 + 轴线 + 数值多边形（红色半透明填充）+ 金色顶点 + 轴标签与分值；setData 回调中触发，dpr 适配与 march.js 同口径。
- `pages/profile/profile.wxml`：核心数据卡之后插入「🏆 我的长征成就」（六格 3×2）与「📊 我的长征数据画像」（雷达 canvas）两张卡。
- `pages/profile/profile.wxss`：ach-grid/ach-cell/ach-icon/ach-value/ach-label 与 portrait-canvas 样式。

## 设计约束落实

- §17.4：画像仅呈现数值（五维 0~100 分），页面无任何「优秀/较差/能力弱」类评价文案。
- §18.2/§18.3：六格内容与文档示例一致（步数/路线比/次数/连续天/勋章比/积分），点击进入对应详情。
- 分层：五维评分由后端计算（`profile.portrait`），前端只做展示与绘制；成就总览复用既有 summary 字段，无新接口。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P1P-01 | 成就总览六格渲染：key 序 march,route,quiz,streak,medal,points；各格数值与 summary 数据逐格自洽（8,000 步 / 2 / 10 / 0 次 / 1 天 / 1 / 12 / 21） | 通过 |
| P1P-02 | 点击跳转：行军格 → 行军日历、情报格 → 答题记录（往返导航正常） | 通过 |
| P1P-03 | 数据画像：五维齐全且 ∈[0,100]（10/3/0/20/6）、雷达 canvas 存在、drawPortrait 重放不抛错、点亮后行军/路线 > 0 | 通过 |

执行：`node test/automator/p1-achievements.cjs` —— **3/3 通过**；截图 `test/images/29-profile-achievements.png`。

回归：`node test/automator/p1-footprint-map.cjs` 3/3（档案页足迹地图卡未受影响）。

## 备注

- 雷达图轴序自顶部顺时针：行军 → 坚持 → 知识 → 路线 → 成就（与后端 ProfilePortrait 字段一一对应）。
- 全新用户画像各维偏低属预期（数据驱动的真实呈现）；路线维度初始为 10（瑞金目标 0 步天然完成，详见后端报告）。
