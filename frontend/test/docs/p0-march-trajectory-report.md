# P0-1 行军轨迹（小程序侧）测试报告

日期：2026-10-02 · 范围：march 页轨迹进度接后端字段、增量推进动画、当前行军点呼吸光点/粒子

## 改动摘要

- `pages/march/march.js`
  - 新增 `calcRouteProgress(route)`（后端 `routeProgress` 优先，旧接口降级步数比例）与 `currentRatio()`（增量推进插值，800ms easeOutCubic），`drawRoute`/`drawProgressFlag` 统一改用；
  - `renderRoute`：仅首次渲染重建静态层并播放入场描画；步数刷新只设 `progressAnim` 播放新增段，不再重播完整动画；实景镜头俯冲仅首次（`_viewPlayed`）；
  - `drawProgressFlag`：基座光晕改呼吸缩放（0.45~0.85 alpha），新增 3 颗循环上升光尘粒子（需求 §3.3 光点/呼吸/轻微粒子）。

## 验证结果

| 项 | 方式 | 结果 |
| --- | --- | --- |
| JS 语法 | `node --check pages/march/march.js` | 通过 |
| 后端字段 | `backend/test/p0_route_progress.py` 10 用例 | 10/10 通过 |
| 页面断言 | `test/automator/p0-march.cjs`（results-p0m.json） | 6/6 通过 |
| 视觉证据 | `test/images/17-march-real-p0.png`、`18-march-canvas-p0.png`（累计 30000 步、点亮 6/10 的中段状态） | 人工核对通过 |

automator 断言明细：P0M-01 实景 markers/polylines/进度旗齐备；P0M-02 routeProgress 字段优先（0.7）；P0M-03 旧接口降级（0.5）；P0M-04 currentRatio∈[0,1]；P0M-05 插画模式画布初始化正常；P0M-06 模式往返切换正常。

## 备注

- 截图与断言分离执行（p0-shots.cjs，每状态独立连接 + 失败整状态重试），遵循 automator 协议第 3/3d 条。
- 动画为逐帧效果，静态截图无法呈现呼吸/粒子，需真机或模拟器动态核对；链路正确性由 P0M-04/05 保证。
