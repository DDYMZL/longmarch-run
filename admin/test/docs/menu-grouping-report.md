# 测试报告：侧边菜单按功能分组 + 折叠（2026-10-18）

## 背景

16 个菜单项平铺在左侧栏，无层次。本次按功能划分为一级分组 + 二级菜单项，并支持两层折叠（分组折叠、整栏折叠）。

## 改动

| 文件 | 改动 |
| --- | --- |
| `admin/src/router/menus.ts` | `MENUS` 平铺列表不变（权限码/路由守卫/角色勾选仍以其为准）；新增 `MENU_GROUPS` 分组定义：数据总览（数据大屏/排名洞察/数据分析）、内容管理（路线点位/章节配置/题库维护/每日寄语/人物志/勋章管理）、组织与人员（组织架构/人员授权/入驻邀请码）、运营配置（活动设置/运营参数）、系统管理（审计日志）；未分组菜单（当前仅驾驶舱）自动平铺为一级项，新增菜单不入分组也不会从侧边栏丢失 |
| `admin/src/layout/AdminLayout.vue` | `el-sub-menu` 渲染分组（`unique-opened` 同时只展开一组）；`default-openeds` 自动展开当前路由所在分组（刷新后高亮可见）；底部新增整栏折叠开关（220px ↔ 64px 图标栏，折叠后分组变悬停浮层） |
| `admin/src/main.ts` | 补注册图标：DataLine/Files/Fold/Expand（新分组与折叠开关），顺带修复 `Notebook`/`SetUp` 已引用但从未注册导致的章节配置/运营参数菜单图标缺失 |

## 验证（vite dev + 浏览器真实交互）

- `npm run build`（vue-tsc + vite build --mode prod）EXIT 0。
- 浏览器登录（admin/本地 8010）→ 驾驶舱：
  - 侧边栏呈现 1 个一级项（驾驶舱）+ 5 个可展开分组；截图 `images/menu-groups-content-medals.png`。
  - 展开「内容管理」显示 6 个子项，点击「勋章管理」正常跳转，子项高亮红金渐变、父组金色高亮；`unique-opened` 生效（同时仅一组展开）。
  - 整页刷新 `/rankings`：「数据总览」分组自动展开且「排名洞察」高亮；截图 `images/menu-groups-expanded-rankings.png`。
  - 底部开关整栏折叠为 64px 图标栏，悬停分组图标弹出深色浮层列出子项且当前项高亮；截图 `images/menu-collapsed-iconbar.png`。
  - 控制台无组件解析告警（图标缺失问题已随注册修复）。
- 权限过滤逻辑不变：`hasMenu(code)` 仍按平铺 code 判定，分组内子项按权限过滤、空组整体隐藏。

## 遗留

- `docker/init/022_ai_admin_menus.sql` 已种入 5 个 AI 菜单码（ai_overview 等），前端页面未建；落地时将其归入合适分组（或新增「AI 智能中心」分组）即可，分组结构已支持。
