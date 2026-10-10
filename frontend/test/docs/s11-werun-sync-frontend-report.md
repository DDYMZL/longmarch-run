# S11 步数同步真实数据链路 小程序侧验收报告（frontend）

日期：2026-10-10 ｜ 范围：frontend ｜ 脚本：`frontend/test/automator/s11-werun-sync.cjs`

## 验收环境

- 微信开发者工具自动化端口 9420，真实登录（未 mock wx.login，用户 uid=345 真实 openid）；
- 后端 `http://127.0.0.1:8010/api` 已加载新代码（openapi 显示 SportSyncRequest）。

## 测试结果（4/4 通过）

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| T1 | 首页「演示 +2000步」按钮已移除、同步按钮保留 | PASS |
| T2 | 取数失败时友好报错且零写入（无假数据） | PASS |
| T3 | 未产生任何模拟步数（本环境无写入） | PASS |
| T4 | 后端 /sport/today 与页面一致（均 0） | PASS |

证据：`frontend/test/automator/s11-werun-sync-results.json`，截图 `frontend/test/images/s11-01-home-werun-sync.png`。

## 环境说明与真机待验

- 开发者工具模拟器中 `wx.getWeRunData` 返回微信侧错误「开发者未开通微信运动」，
  属账号环境限制（该微信号未开通微信运动），非代码问题；
  页面正确展示友好提示「请先在微信中开通「微信运动」后再同步」，且当天 0 写入
  （修复前此处会静默写入约 9000 假步数）。
- 后端解密链路已由 `backend/test/s11_sport_sync_werun.py` W05~W08 完整覆盖
  （加解密往返、watermark 校验、缺当日步数、取当日步数）。
- 真机验证（已开通微信运动的设备）：点击「同步微信步数」应写入当日真实步数，
  需用户在实际设备上回归确认。
