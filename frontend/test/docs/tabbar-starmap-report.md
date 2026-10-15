# tabBar 图标 + 星空地图闪烁 测试报告

- 日期：2026-10-15
- 范围：frontend（`app.json` tabBar、`images/tabbar/`、`pages/march/march.js` 星空画布）
- 环境：微信开发者工具（自动化端口 9420，模拟器默认机型）、远程后端 `https://swkjdj.sz-watech.com/api`、已有登录态
- 脚本：`test/automator/tabbar-starmap.cjs`（断言）+ `tabbar-starmap-shots.cjs`（截图，独立运行）

## 1. 自动化断言（8/8 PASS）

| 编号 | 用例 | 结果 | 关键数据 |
| --- | --- | --- | --- |
| TS-01 | tabBar 5 项名称/顺序/路径不变；10 个图标为 81×81 PNG（≤40KB） | PASS | 首页/长征/情报/排行/我的；单个图标 0.45~0.7KB |
| TS-02 | 5 个 tab 依次 `switchTab` 均落到对应页面 | PASS | home → march → quiz → rank → mine |
| TS-03 | 星空分层与参数多样性 | PASS | 远景 110 颗已烘焙进离屏层；中近景 64 颗，64 个不同周期、3 种色调、30 颗呼吸曲线、9 颗十字亮星；最低亮度 0.09~0.45；落在节点 16px 内的星点 0 颗 |
| TS-04 | 绘制耗时（120 帧均值） | PASS | 整帧 1.40ms，其中星空 0.62ms |
| TS-05 | 切走 tab 暂停、切回恢复且帧推进 | PASS | 切走后 `running=false`、`animId=null`；切回 animId 216→241 持续推进 |
| TS-06 | 实景↔星空往返 | PASS | 实景时画布释放（ctx=null、循环停止），切回星空重建并运行 |
| TS-07 | 星空模式点击节点进入详情 | PASS | 点击瑞金 → `node-detail` |
| TS-08 | 全程无新增运行时异常 | PASS | 无 exception / console.error |

## 2. 视觉证据（`test/images/`）

| 文件 | 内容 |
| --- | --- |
| `tabbar-01-home.png` | 首页选中：红色实心房屋（星形镂空），其余灰色线框 |
| `tabbar-02-quiz.png` | 情报选中：红色实心信封 |
| `tabbar-03-rank.png` | 排行选中：红色实心奖杯（星形镂空） |
| `tabbar-04-mine.png` | 我的选中：红色实心人像 |
| `starmap-01-twinkle-a.png` / `starmap-02-twinkle-b.png` | 长征选中（红旗）+ 星空长征：远景微星、错峰亮度不同的中近景星、银河带分布；已点亮瑞金金星与当前节点红色柔光清晰可辨，路线/地名不被遮挡 |

图标与文字居中对齐，选中态颜色（#C8102E）与 `tabBar.selectedColor` 一致。

## 3. 未验证项

- **真机**：未在真机上预览，因此未实测低端 Android 的帧率、发热和耗电。星空单帧开销在模拟器上约 0.6ms，动态星数由 82 降为 64，远景星为零帧开销，理论上不高于改动前。
- **多机型宽度**：本次只截了模拟器默认机型。原生 tabBar 的布局由微信负责，画布按容器尺寸自适应，不涉及自定义布局。
- **App 进入后台**：该场景依赖页面 `onHide` 停止循环，与切 tab 同一路径；本次只用切 tab 覆盖。
