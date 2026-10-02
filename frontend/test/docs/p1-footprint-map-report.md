# P1-6 我的长征足迹地图（小程序侧）测试报告

日期：2026-10-03 · 范围：档案页「🗺️ 足迹地图」卡片（需求 §7：时间+路线结合，点击节点看抵达详情）

## 改动摘要

- `services/march.js`：新增 `getFootprints()`。
- `pages/profile/profile.js`：`refresh` 第 3 路拉取足迹（失败不阻塞档案主数据）；视图模型预格式化（dayStepsText/cumStepsText，快照为 0 展示 —）；`toggleFootprint` 点击展开/收起（再点同项收起）。
- `pages/profile/profile.wxml`：足迹地图卡（长征进度卡与历史数据卡之间）：竖向节点链（红金渐变连接线 + 节点圆点，选中金色发光），行内展开详情面板（日期大标题 /「我在这一天抵达 {节点}」/ 当日步数 / 累计步数，米金渐变底）；空态引导文案。
- `pages/profile/profile.wxss`：fp-chain/fp-rail/fp-dot[.active]/fp-line/fp-detail-* 样式。

## 验证结果

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P1L-01 | 足迹链：瑞金/遵义按路线顺序、点亮日期=今日、末节点 isLast | 通过 |
| P1L-02 | 点击遵义展开（fpSelected=2），再点收起（fpSelected=0） | 通过 |
| P1L-03 | 详情自洽：当日步数 8,000 / 累计步数 8,000，`.fp-detail` DOM 渲染 | 通过 |

执行：`node test/automator/p1-footprint-map.cjs`（results-p1l.json）—— **3/3 通过**；视觉证据 `test/images/28-profile-footprint.png`（滚动至卡片拍摄、遵义展开态）人工核对通过。

## 备注

- 详情面板采用行内展开而非弹层：足迹链本身是多节点列表，行内展开可同时对照上下节点，且无需处理弹层遮罩与滚动冲突。
- 当日步数与足迹时间轴（user_event）数据同源不同视图：事件轴按时间倒序流水，足迹地图按路线顺序聚合点亮节点，二者互补（§7.1「在已有长征档案基础上增加」）。
