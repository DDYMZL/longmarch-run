# V2.0 小程序验收测试报告（长征步迹 · 荣耀征程）

- 日期：2026-10-13
- 范围：活动时间控制（活动状态页/首页横幅/查看拦截）、积分排行榜（领奖台/荣誉榜/分页）、「我的」积分卡与积分明细页、「我的长征」荣誉卡、组织锁定只读、答题 90 秒逐题限时
- 环境：微信开发者工具自动化（ws://127.0.0.1:9420）+ 本地后端 8010（openGauss）；测试用户 `V12验收`（fixture `frontend/test/v12-fixture.json`，已忽略入库）；活动设置经管理端 `PUT /api/admin/activity` 临时切换，用例结束后自动恢复原配置
- 脚本：`frontend/test/automator/v2-miniprogram.cjs`（断言先行，截图与断言分离；`--no-shots` 只跑断言、`--shots-only` / `--shots-from=NN` 补拍、`--skip-timeout` 跳过 90 秒超时用例）

## 结果总览

**14 / 14 通过**（第 3 轮，`node v2-miniprogram.cjs --no-shots`；截图来自第 2 轮的独立截图阶段）

| 编号 | 用例 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| R01 | 排行榜领奖台 / 4-10 名荣誉卡 / 11 名起列表与 `/rank/points` 同口径，「我的名次」一致 | 通过 | podium=2,1,3，elite=7，list=20，me=131，total=131 |
| R02 | 排行榜上拉加载第 2 页（追加不重复） | 通过 | list 20→40，末位 50 名 |
| P01 | 「我的」积分卡与 `/points` 一致；首个入口为「积分明细」；组织行以后端全称回显 | 通过 | total=walk+quiz，rank=131，org=长征集团总部 |
| P02 | 积分明细页汇总 / 规则（取后端 `rules`）/ 按日明细条数 | 通过 | 「步行：每 1000 步 1 分，单日步数按 20000 步封顶，每日最多 20 分」 |
| H01 | 「我的长征」荣誉卡与 `/profile/summary.points` 一致 | 通过 | honorTotal=0，rank=131 |
| Q01 | 开题：服务器倒计时、第 1 题、进度点 | 通过 | remain=87s（含页面加载耗时），dots=answering,pending×4 |
| Q02 | 答对即时反馈 +2；同题重复提交被后端拒绝 | 通过 | dup=400「本题已作答，不能重复提交」 |
| Q03 | 答错反馈 0 分并标出正确答案 | 通过 | right=A wrong=B，进度点 wrong |
| Q04 | 倒计时归零进入超时态；越过 2 秒网络宽限后后端拒绝迟交 | 通过 | dots3=timeout，late=400「本题作答已超时，不能再提交」 |
| Q05 | 结果页：答对数 / 正确率 / 答题积分 / 超时数 / 逐题结果 | 通过 | correct=3，points=6，acc=60，timeout=1，verdicts=right,wrong,timeout,right,right |
| Q06 | 答题积分进入积分台账并与排行榜一致 | 通过 | todayQuiz=6，total=6，rank.me.points=6 |
| O01 | 组织选定后再进入为只读锁定页，二次选择 403 | 通过 | 第 1 轮经 UI 首次选定（ui:长征集团总部）；锁定后 again=403「所属部门已锁定，如需调整请联系管理员」 |
| A01 | 活动已结束且关闭查看：启动后进入活动状态页，查看接口 403 + `X-Activity-Status: ended` | 通过 | 标题「征程圆满 · 荣耀永驻」，`/points`=403/ended |
| A02 | 活动已结束但允许查看：首页「已结束」横幅，参与接口（开题）被拒 | 通过 | banner「征程圆满 · 荣耀永驻 · 成绩可查看，不再计分」，`/quiz/start`=403 |

活动设置恢复核验：用例结束后 `GET /api/admin/activity` 为 `2026-09-01 00:00 ~ 2026-12-31 23:59`、`restrict_enabled=true`、`allow_view_after_end=true`、结束标题/文案与测试前一致，状态 ongoing。

## 执行过程中发现并修复的问题

| 轮次 | 现象 | 根因 | 处理 |
| --- | --- | --- | --- |
| 第 1 轮 | 截图 51：「我的」组织行显示「点击选择组织架构 🔒」（已选组织却无名称） | 组织名称仅为前端缓存字段，重新登录（`/auth/me` 不含组织名称）后缓存为空 | **产品修复**：`pages/mine/mine.js` 以 `/profile/summary.user.orgName`（后端组织全称）经 `auth.updateLocalUser` 回填缓存；P01 增加组织行断言。同时解决 `onboard-org-echo-report.md`「已知限制」中换设备/清缓存后不显示组织的问题 |
| 第 1 轮 | Q05 判失败（数值均正确） | 脚本在正确率滚动动画（1.1s）结束前读取 `displayAccuracy` | 脚本修复：等待后重新读取页面数据 |
| 第 2 轮 | Q04 迟交被受理（200），连带 Q05 | 后端设计上截止后 `QUIZ_ANSWER_GRACE_SECONDS=2` 秒内仍受理（网络延迟宽限），脚本仅等待 1.5s | 脚本修复：本地超时后等待 3.5s 再迟交；前端本地截止 = 收到响应时刻 + `remainingMs`，早于服务器截止，用户侧不会出现超时后可提交 |
| 第 1 轮 | 截图 55 空白、57-59 缺失 | 截图使自动化桥退化；55 以 `callMethod` 起手违反「每个截图状态以主动导航开头」 | 截图阶段改为状态表（每状态以 navigate/switchTab/reLaunch 起手），55 先于 54 拍摄；支持 `--shots-from` 续拍 |

## 截图（`frontend/test/images/`）

| 文件 | 内容 |
| --- | --- |
| `50-v2-rank.png` | 积分排行榜：顶部我的名次/总积分/参与人数，金银铜领奖台（2-1-3），荣誉榜 4-10 名卡片，底部常驻「我的排名」条 |
| `51-v2-mine-points.png` | 「我的」：组织行回显 + 🔒，「我的积分」卡（总积分/今日/步行/答题/排名） |
| `52-v2-points-detail.png` | 积分明细：总积分/排名、今日进度、规则说明、每日明细表 |
| `53-v2-profile-honor.png` | 「我的长征」荣誉卡：积分排名徽章、荣誉总积分、步行/答题拆分 |
| `54-v2-quiz-answering.png` | 答题中：环形倒计时、进度点、选中态 |
| `55-v2-quiz-feedback.png` | 提交反馈：回答正确 +2 积分、解析、今日累计，倒计时环显示「已交」 |
| `56-v2-quiz-result.png` | 结果页：4/5、正确率 80%、答题积分/答错/超时、逐题详情 |
| `57-v2-org-locked.png` | 组织锁定只读页 |
| `58-v2-activity-ended.png` | 活动状态页（已结束且关闭查看）：结束标题/文案/活动时间、仅「刷新状态」 |
| `59-v2-home-ended-banner.png` | 首页「已结束」横幅（允许结束后查看） |

## 复跑方法

```bash
# cwd 必须为 frontend/test/automator；后端 8010 运行，开发者工具 cli auto --auto-port 9420
node v2-miniprogram.cjs --no-shots      # 断言（含约 90 秒超时用例）
node v2-miniprogram.cjs --shots-only    # 断言落盘后独立补拍（可加 --shots-from=57）
```

前置：活动需为进行中；`../v12-fixture.json` 含测试用户 token 与全题库答案；管理员令牌取 `%TEMP%/lm/admin_login.json`（或环境变量 `LM_ADMIN_LOGIN`）。脚本会调用 `/quiz/reset` 重置测试用户当日答题。

## 已知限制

- O01 的「未选组织 → UI 首次选定」路径只在测试用户首次运行时覆盖（第 1 轮已通过）；用户端无法解除锁定，复跑时走「已锁定」分支，仍校验只读页与二次选择 403。
- 步行积分本轮测试用户当日步数为 0；步行积分计算（封顶 20000 步/每日 20 分）与重算由后端 s20 套件覆盖。
