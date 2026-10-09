# S8 微信身份关联与扫码登录 冒烟报告

- 时间：2026-10-09
- 脚本：`backend/test/s8_identity_admin.py`（TestClient 直连 openGauss，mock 微信凭证模式）
- 结果：**23/23 通过**（可重复执行：脚本首尾自清理冒烟数据）

## 覆盖范围

| 分组 | 断言 | 结果 |
| --- | --- | --- |
| A1 | mock 登录不产生身份行；`/auth/identities` 为空 | PASS |
| A2 | 创建扫码会话：mock 模式返回 scene 明文、image=None、expires_in=300 | PASS |
| A3 | 轮询 pending 状态不含 token | PASS |
| A4 | `/auth/qr/info` 无 token 401；合法场景返回 type=login 并置 scanned；非法场景 400 | PASS |
| A5 | 无后台角色确认登录 → 403；会话 failed 带原因、轮询无 token | PASS |
| A6 | 授权 operator 角色后确认 → 轮询返回 token+menus（含 questions、不含 access） | PASS |
| A7 | 令牌单次签发（二次轮询无 token）；关联管理员 `/admin/me`（is_super=False、roles 含 operator） | PASS |
| A8 | 用户取消登录 → 会话 cancelled | PASS |
| A9 | 过期会话：info 404、轮询置 expired | PASS |
| A10 | 绑定确认成功（identities 新增 wx_web 行）；凭证重复使用 400 | PASS |
| A11 | 同用户同渠道重复绑定 400；openid 已绑他人 400；unionid 已属他人 400（禁止合并） | PASS |
| A12 | 解绑：非本人 400；wx_mini 主身份 400；wx_web 解绑成功且留审计 | PASS |

## 说明

- 测试夹具显式构造角色授权数据（直接写 `admin_user_roles`），**未将普通用户自动升级为管理员**；
- mock 模式（未配置 WX_APPID/WX_SECRET）下扫码接口返回 scene 明文供开发调试；真实小程序码链路待配置微信凭证后在真机验收（批次5）；
- 限流（429）未纳入本脚本，避免 TestClient 同 IP 触发限流干扰其他用例。
