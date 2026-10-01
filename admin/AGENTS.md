# AGENTS.md · 长征管理后台

本目录是 Vue 3 + TypeScript + Element Plus 的 PC 管理后台。

## 开发约定

- 页面通过 `src/api/admin.ts` 访问 `/api/admin/*`，请求由 `src/api/request.ts` 统一注入管理员 Bearer Token。
- 新页面在 `src/router/index.ts` 注册，并在 `src/layout/AdminLayout.vue` 增加菜单入口。
- 保持现有视觉语言：深色导航、长征红与鎏金作为强调色，数据页需覆盖加载、空状态、筛选和窄屏可用性。
- 导出包含用户文本时必须防止 CSV 公式注入。

## 必做验证

前端功能开发完成后必须自行执行对应工具测试：PC 管理后台使用浏览器完成真实交互与样式验收；微信小程序使用微信开发者工具测试，并重点检查样式问题。管理后台至少执行 `npm run build`，随后启动开发服务器，在浏览器验证登录、目标功能、筛选/弹窗/展开交互、导出和页面布局，不能仅以类型检查或构建成功代替功能验收。
