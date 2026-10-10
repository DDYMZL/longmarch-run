# S11 步数同步真实数据链路 测试报告（backend）

日期：2026-10-10 ｜ 范围：backend ｜ 脚本：`backend/test/s11_sport_sync_werun.py`

## 背景

用户反馈：实际未走 9000 步，点击「同步微信步数」后当天却写入约 9000 步。
根因：前端 `POST /api/sport/sync` 从不携带数据，后端 `sport_service.sync_today`
对无参请求一律用 `seeded_steps(date, user_id)` 按「日期+用户」伪随机生成 4000~12999
的假步数落库。

## 修复方案

- 前端 `syncToday()`：`wx.authorize(scope.werun)` → `wx.login` 取 code →
  `wx.getWeRunData` 取加密数据，`POST /sport/sync {code, encryptedData, iv}`；
  任一失败即报错给用户，不发请求。
- 后端新增 `app/core/wx.py`：`code2session`（返回 session_key）+
  `decrypt_werun`（AES-128-CBC 解密 + watermark.appid 校验）。
- `sync_today` 步数来源：已配置凭证且带加密数据 → 解密取当日步数（失败抛 ValueError → 400）；
  仅 mock 登录用户或未配置凭证时回退 seeded 模拟；真实用户缺数据 400，绝不写编造步数。
- `auth_service._code2session` 收敛为复用 `core.wx.code2session`（行为不变）。
- 新增依赖 `pycryptodome`（AES）。

## 测试结果（8/8 通过，连跑两次可重复）

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| W01 | mock 用户无 payload 同步走开发模拟（4000~12999） | PASS |
| W02 | 同日重复同步 synced=False 且步数不变 | PASS |
| W03 | 已配置凭证：真实用户无 payload → 400 且 DB 无记录 | PASS |
| W04 | 真实用户伪造加密数据 → 400（会话换取失败）且 DB 无记录 | PASS |
| W05 | decrypt_werun 加解密往返一致（当日步数 6543） | PASS |
| W06 | watermark.appid 不匹配 → ValueError | PASS |
| W07 | 解密数据缺当日步数 → ValueError | PASS |
| W08 | _resolve_steps 完整解析取当日步数 | PASS |

证据：`backend/test/s11-werun-sync-results.json`。

## 回归

- `backend/test/e2e_full_flow.py` 全链路 178/178 通过（mock 用户模拟路径行为不变，
  证据 `backend/e2e-full-results.json`）。
- 注意：e2e 在已配置 `WX_APPID/WX_SECRET` 的本机运行，S03/S04 等用例走 mock 登录用户
  （伪造 code → mock openid），不受「真实用户无 payload 400」影响。

## 数据修复

经用户确认，删除 2026-10-10 当天全部 5 条 daily_sport 模拟记录
（真实用户 uid 345/347 及 3 个 mock 测试用户），已发的运动积分不回溯。
