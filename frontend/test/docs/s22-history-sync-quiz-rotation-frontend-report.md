# S22 历史步数同步与题目轮换前端测试报告

## 变更

- 首页同步结果区分：近 7 日成功、已是最新、部分日期待重试。
- 当前步数区域仍只读取后端 `steps`（今天），不展示历史逐日步数。
- 积分页展示 `walkCarry`，说明结余步数会计入下一次换算。
- 答题页按后端 `totalCount` 展示实际题量；题库不足 5 道时展示 `shortageMessage`，不阻止现有题目作答。

## 验证

- `node --check services/sport.js pages/home/home.js pages/points/points.js pages/quiz/quiz.js`：通过。
- 微信开发者工具 CLI `open --project D:/project/longmarch-run`：项目成功打开并触发编译，无 CLI 报错。
- 后端接口/页面数据契约由 `backend/test/s22_history_sync_quiz_rotation.py` 覆盖，13/13 通过。
- 2026-10-15 回归：模拟旧后端仅返回 `date/steps/totalSteps/synced`，service 会补齐近 7 日数组与积分字段，首页显示通用同步提示，不再因读取 `failedDates.length` 报错；模拟新版响应时保留原数组和近 7 日提示。

## 未完成的环境验收

本机 Docker Desktop daemon 未运行，后端 openGauss 无法启动，因此本轮不能在小程序中完成登录后的真实接口交互、真实微信运动授权与真机历史步数同步。上线前仍需在已开通微信运动的真机账号验收：完整 7 日/部分返回提示、首页仅显示今天、积分结余展示、题库不足提示。
