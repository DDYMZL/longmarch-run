# S22 微信历史步数同步与每日题目轮换测试报告

## 微信接口能力核实

- `wx.getWeRunData` 不接受起止日期参数；客户端只能取得微信返回的加密数据，服务端用 `session_key` 解密后读取 `stepInfoList`（`timestamp`、`step`）。因此实现不能主动查询任意指定日期。
- 微信开发文档入口：https://developers.weixin.qq.com/miniprogram/dev/api/open-api/werun/wx.getWeRunData.html
- 可检索到的近期开发资料说明 `stepInfoList` 通常含最近约 30 天（含当天），但实际返回范围仍以微信本次响应为准。本项目只筛选其中最近 7 个北京时间自然日；未返回日期不造数、不写 0、不覆盖旧值，并返回失败日期供重试。
- 自动化环境无法替代已开通微信运动的真机账号，实际返回天数与跨午夜时间戳归日列为上线前真机验收项。

## 变更与数据库

- `019_sport_backfill_carry.sql`：`daily_sport` 增加 `source / synced_at / sync_status`，并按步数结余新口径重算存量 walk 台账。
- `020_question_rotation.sql`：`questions.active` 软停用字段；停用题不进入新任务，但已生成的当天任务不失效。
- 无清表、无删除历史运动/答题/积分数据。

## 自动化结果

执行：

```bash
cd backend
python test/s22_history_sync_quiz_rotation.py
python test/s18_quiz_submit_feedback.py
python test/s20_v2_regression.py
```

结果：

- S22 新功能验收：13/13 通过。
  - 最近 7 日逐日入库；前端响应只返回今天当前步数。
  - 5800 步得 5 分并结余 800；次日 200 步后再得 1 分。
  - 重复同步幂等；历史修正联动后续结余；缺失日不覆盖旧值。
  - 用户独立轮换、未使用题优先、跨轮补足、同日固定、当天不重复。
  - 软停用不破坏当天任务；题库 3 道时只返回 3 道及明确不足状态。
- S18 限时答题回归：21/21 通过。
- S20 V2 综合回归：25/25 通过。
- 修改的 Python 文件 `py_compile` 通过；修改的前端 JS `node --check` 通过。

## 已知限制与待验收

1. 本机 Docker Desktop daemon 未运行（`dockerDesktopLinuxEngine` pipe 不存在），无法启动 openGauss、执行 019/020 迁移或补做真实库兼容验证；当前数据库验证为 SQLite + openGauss SQL 静态审查。
2. 微信开发者工具/自动化环境不能提供可信的真实微信运动历史数据；必须使用真机验证授权、实际返回日期范围、跨午夜归日和部分日期缺失提示。
3. 微信接口无法按日期补查；某日若不在微信本次 `stepInfoList` 中，只能保留原数据并允许用户后续重新同步。
