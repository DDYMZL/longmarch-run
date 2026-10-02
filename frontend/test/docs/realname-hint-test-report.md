# 真实姓名提示改造 · 小程序测试报告

日期：2026-10-02 ｜ 环境：微信开发者工具（自动化端口 9420）+ 后端 8010（新代码）｜ 结果：**通过**

## 需求

输入/修改名称时，提示词不放在 input 框内（不占 placeholder），改在输入框外提示「请输入真实姓名」。

## 改动

| 文件 | 改动 |
| --- | --- |
| `pages/org-select/org-select.wxml` | 首次登录采集块：标签「昵称」→「姓名」；输入框去掉 `placeholder="点击填入微信昵称（可跳过）"`；输入框旁侧新增 `nick-hint` 文案「请输入真实姓名」 |
| `pages/org-select/org-select.wxss` | 新增 `.nick-hint`（长征红 #C8102E、24rpx、不收缩） |
| `pages/mine/mine.js` | 修改昵称弹窗：去掉 `placeholderText`；标题改为「请输入真实姓名」；不再使用 `content` |
| `design.md` | org-select / 4.2 / 4.3 三处描述同步 |

## 验证

| 项 | 结果 | 证据 |
| --- | --- | --- |
| `node --check` mine.js / org-select.js / shots 脚本 | ✅ | 语法通过 |
| org-select 首次登录采集块：输入框无 placeholder，红字提示在旁侧，下方保留「未填写将使用默认昵称…」说明 | ✅ | `test/images/realname-org-select.png`（新 mock 用户真实登录流程触发） |
| mine 弹窗：标题「请输入真实姓名」+ 空输入框（无 placeholder），无叠层 | ✅ | `test/images/realname-mine-modal.png`（新 mock 用户选定组织后进 mine 点 ✎ 触发） |
| 选定组织链路回归：新用户 `confirmSelect(1)` → 落库 → switchTab 首页正常 | ✅ | 截图流程必经路径，无报错 |

## 排障记录（对后续测试有价值）

1. **mine 页守卫**：已登录但无 orgId 的用户会被 `mine.js onShow` 弹回 `org-select?from=login`——自动化脚本进 mine 前必须先选定组织（`confirmSelect`），否则 switchTab/reLaunch 均表现为"静默不跳转"。
2. **editable 弹窗 content 叠层**：模拟器中 `wx.showModal({editable:true, content})` 的 content 与输入框同区渲染（单行叠在输入框位置、两行被输入框截断），故提示语只放标题。
3. **`callWxMethod('showModal')` 无响应**：UI 类 API 经自动化桥直接调用会挂起等回调；页面方法内触发（`page.callMethod`）或 `mini.evaluate(() => wx.showModal(...))` 正常。
4. 两次桥退化（能连不通令 / connect 超时）按协议 `cli.bat quit` → 全杀残留 → `cli.bat auto` + sleep 45 恢复。

## 备注

- 弹窗不再重复提示「仅可修改一次」：改名入口仅在未修改时展示（wxml 按 `nicknameChangedAt` 隐藏），重复修改由 `handleEditNickname` toast 与后端 400 双重拦截。
- 自动化脚本 `test/automator/shots-realname-hint.cjs` 可重复执行（`node shots-realname-hint.cjs [a|b]` 分状态独立连接，符合截图与断言分离协议）。
