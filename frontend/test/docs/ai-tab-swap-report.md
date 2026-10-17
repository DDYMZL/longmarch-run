# 底部 tab 换防（情报 → AI 问答）· 验收报告

- 日期：2026-10-17
- 范围：`app.json` tabBar 第 3 项由 `pages/quiz/quiz`（情报）替换为 `pages/ai-chat/ai-chat`（AI 问答）；quiz 降级为子页，主入口改为首页「今日长征情报」卡 `navigateTo`；原 4 处 `switchTab` 到 quiz 的调用全部改写；tabBar 新增 ai/ai-active 图标（`test/gen-tabbar-icons.cjs` 生成，灰线/红实心约定）。
- 环境：微信开发者工具 automator（`cli auto --auto-port 9420`），断言脚本 `test/automator/ai-tab-swap.cjs`，截图脚本 `test/automator/tab-swap-shots.cjs`。
- 不依赖后端：登录态经 `evaluate` 注入 `app.globalData`；`wx.request` 全量 stub 为 fail，避免各页 onShow 拉接口 401 后静默重登失败 reLaunch 回启动页搅乱页面栈（与 ai-chat-render.cjs 的 setData 注入同思路，不伪造任何业务数据）。

## 断言结果（node ai-tab-swap.cjs，5/5 PASS）

| 编号 | 用例 | 结果 | 实测 |
| --- | --- | --- | --- |
| V1a | 首页情报卡按钮存在（`.quiz-btn`） | PASS | 按钮渲染 |
| V1 | 首页情报卡真 tap 后 `navigateTo` 进 quiz，且 `navigateBack` 回首页 | PASS | quiz=true back=true |
| V2 | 5 个 tab 依次 `switchTab` 均落对应页（含新 tab ai-chat） | PASS | home → march → ai-chat → rank → mine |
| V3 | ai-chat tab 页数据就绪（常见问题 4 条、消息空） | PASS | msgs=0 common=4 |
| V4 | quiz 已非 tab：`switchTab('/pages/quiz/quiz')` 被拒 | PASS | 桥返回拒绝错误，当前页未变 |

## 视觉证据

| 截图 | 内容 |
| --- | --- |
| `../images/tab-swap-home.png` | 首页 tabBar：首页/长征/AI 问答（灰色气泡线性图标）/排行/我的 |
| `../images/tab-swap-aichat.png` | AI 问答 tab 选中态（红色实心气泡图标）+ 空状态常见问题引导 |

## 回归脚本同步

quiz 降级为子页后，历史 automator 脚本中 11 处 `mini.switchTab('/pages/quiz/quiz')` 统一改为 `mini.reLaunch('/pages/quiz/quiz')`（reLaunch 与旧 switchTab 语义一致：清空页面栈、新建页面实例，且不会像 navigateTo 那样在重复进入时压栈溢出），涉及 s16-review-smoke / s5-shots / s5-pages / shots-tour / ui-test / v2-quiz-modes-shots / v2-quiz-modes / v2-miniprogram；脚本注释与文案中「情报 tab」同步改为「quiz 页」。全部 `node --check` 通过。

## 踩坑记录（已写入 automator 测试协议记忆）

1. `page.callMethod()` 与 `mini.evaluate()` 上下文里调用页面方法/`wx.navigateTo` 不会真正导航（桥屏蔽），必须用 `element.tap()` 走真实事件链。
2. 模拟器 tap 事件送达可延迟数秒（原生层预热、march 页原生 map 层残留尤甚），断言须轮询 `currentPage().path`，不能固定 sleep。
3. `switchTab` 到非 tab 页被拒后 automator 桥状态受损，后续命令抛 `Uncaught [object Object]`，负例必须放在脚本最后。
4. 每次 `cli auto` 武装仅支持一条连接；多状态截图需状态间重新武装（sleep 20-25s）。

## 待验证

- 小程序真机（非模拟器）上 tab 切换与情报卡跳转未单独验收（模拟器断言+截图已覆盖逻辑与视觉）。
- AI 问答真机全链路（真实 Agent 回答）仍受本机 DNS 劫持限制，见 ai-chat 相关报告；后端侧真实 Agent 调用已验证（见 backend/test/docs）。
