# P2-2 区域氛围 + 长征完成仪式（小程序侧）测试报告

日期：2026-10-04 · 范围：节点区域氛围主题（需求 §12）、长征完成仪式动画（需求 §20）

## 改动摘要

- `data/node-themes.js`（新增，§12.3 允许的前端主题映射配置）：5 个区域主题
  （瑞金·晨光暖色山地/赤水·水雾山谷/泸定·峡谷云雾铁索/雪山·雾气严寒/延安·黄昏星空暖塬），
  每主题含 `theme/environment/background[3]/particleConfig{type:ember|mist|snow|star}`；
  `NODE_THEME_MAP` 把 10 个节点映射到区域；导出 `themeBgStyle`（160° 渐变）与 `themeSoftStyle`（浅色卡片柔和高光）。
- `utils/routeCanvas.js`（新增）：从 march.js 抽取的共享画布纯函数
  （easeOutCubic/drawStar/drawRoundRect/getCanvasNodePositions/sampleRoutePath  Catmull-Rom 采样/distToIndex 二分），
  供星空长征与仪式页复用，march.js 本地副本已删除。
- `pages/node-detail/node-detail.{js,wxml,wxss}`：hero 区按节点主题渐变 + `#atmoCanvas` 氛围粒子
  （≤24 粒，rAF 循环，onHide/onUnload 停止）；标题区显示「区域氛围 · {environment}」。
- `pages/march/march.{js,wxml,wxss}`：
  - 星空长征画布按节点区域主题生成环境粒子（每节点 3 粒、封顶 30，snow 飘落/ember 上升/mist 漂移/star 闪烁）；
  - 真实地图选中节点卡片套用主题柔和高光 + 区域氛围标签；
  - 完成仪式触发：`route.ceremonyPending` 时等到达弹窗队列播完（`_popupMs`）再 `navigateTo` 仪式页，
    开场过渡期间暂缓、onHide/onUnload 清定时器；完成横幅改为「🎉 恭喜完成长征路线！查看完成仪式 ›」永久入口。
- `pages/ceremony/ceremony.{js,wxml,wxss,json}`（新增页面，app.json 注册）：长征完成仪式。
  - 时间轴（约 8.1s）：逐段点亮路线 → 末节点辉光爆发 → 金线扫过全程 → 全亮脉冲 → 星空展开 →
    「我的长征 / 完成了」→ 完成数据卡（累计行军/运动天数/答题/路线/勋章/累计积分，取自 /march/route + /profile/summary）；
  - 支持「跳过 ›」；首次确认后 `POST /march/ceremony` 标记，再进入为静态回顾态（「已完成长征」+ 数据卡）；
  - 收尾把最终帧 `wx.canvasToTempFilePath` 快照为静态图并 `wx:if` 移除画布，DOM 数据卡浮于快照之上。
- `services/march.js`：新增 `markCeremony()`。

## 验证结果（automator）

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| P2D-01 | 瑞金详情主题渐变 + 氛围粒子画布（theme=ruijin，env=晨光·暖色山地） | 通过 |
| P2D-02 | 雪山节点主题为 snow（与瑞金不同，env=雪山·雾气严寒） | 通过 |
| P2D-03 | 星空长征：每节点按区域主题生成环境粒子（30 粒，ember/mist/snow/star 四类齐全） | 通过 |
| P2D-04 | 首次完成自动进仪式页，跳过后最终文字与完成数据齐备（路线 10/10、勋章 5/12、70,000 步） | 通过 |
| P2D-05 | 确认后 `ceremonyPending` 消失，再进仪式页为「已完成长征」静态回顾态 | 通过 |

执行：`cd frontend/test/automator && node p2-theme-ceremony.cjs` —— **5/5 通过**（`results-p2d.json` / `p2d.log`）。

截图证据（`frontend/test/images/`）：`35-node-theme.png`（雪山节点主题渐变 + 氛围粒子 + 区域标签）、
`36-ceremony.png`（静态回顾态：金色全程路线快照 + 完成数据卡）。

WXML 自检：`frontend/test/wxml-balance-check.cjs` 扩展至 5 个模板（ticket/node-detail/home/ceremony/march），全部 depth=0 通过。

## 已踩坑记录

- **原生 canvas 盖住 DOM 浮层**：`canvas type="2d"` 在开发者工具中是不透明原生层、位于所有 DOM 之上，
  且 `visibility:hidden` 对其不生效——仪式页数据卡一度「存在于 DOM、尺寸位置正确但不可见」。
  解法：动画收尾先快照最终帧为 `<image>`，再 `wx:if` 移除画布，DOM 数据卡浮于快照上（真机同层渲染亦兼容）；
  快照失败时保留画布降级。
- **快照时机**：`skipAnim` 直接置终态后必须主动停帧、补绘 `drawFrame(99)` 再快照，
  否则快照到的是动画中间帧（且 `coverCanvas` 永不置真导致等待超时）。
- **面板半透残影**：数据卡背景 0.92 透明度会透出画布上的「我的长征/完成了」大字，改为不透明 `#0D1B30`。
- **CSS 优先级**：`.hero-themed{background:transparent}` 写在 `.hero{background:渐变}` 之前会被后者覆盖，
  需用 `.hero.hero-themed` 提升优先级（35 号截图曾因此整片红色）。
- **自动化桥退化**：本次 36 号截图两度因桥退化失败，按协议 kill 全部「微信开发者工具.exe」重启
  cli.bat 后用独立小脚本（连接 → reLaunch → `mini.screenshot`，`page.data()` 为方法、截图在 mini 上）补拍成功。

## 备注

- 管理端无需改动（§12.3 前端映射配置、§20 无后台配置面）。
- 仪式数据卡复用 `/profile/summary`（P1-7 已有聚合），未新增后端接口。
