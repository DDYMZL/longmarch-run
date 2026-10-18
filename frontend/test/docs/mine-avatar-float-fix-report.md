# 测试报告：我的页头像飘动遮挡修复 + 部门榜本地联调（2026-10-18）

## 背景与问题

1. **部门榜 not found**：小程序排行页「部门榜」请求 `GET /api/rank/orgs` 返回 404。排查确认该接口随 `b0ed585`（十项增强）新增，本地代码路由注册正常、TestClient 冒烟 200；远程 `https://swkjdj.sz-watech.com/api/rank/orgs` 返回 404（同域 `/rank/points` 返回 401 路由存在），坐实**远程后端跑的是旧代码，需重新部署**。本地联调另受 `services/config.js` `DEV_TARGET='remote'` 影响——develop 环境直连远程旧后端，故本地同样 404。
2. **我的页头像遮挡**：`.mine-avatar`（130rpx + 4rpx 边框，content-box 总宽 138rpx）放在宽度固定 130rpx 的 `<button>` 内，`button` 原生默认样式 `overflow:hidden`，静止时裁掉左右边框，`anim-float` 上浮 14rpx 时裁掉顶部；编辑角标绝对定位在圆形容器右下角，被 `border-radius + overflow:hidden` 裁掉大半。

## 改动

| 文件 | 改动 |
| --- | --- |
| `frontend/services/config.js` | `DEV_TARGET` 改 `'local'`（本地联调开关，**不入库**，默认仍为 remote 供 automator 回归） |
| `frontend/pages/mine/mine.wxml` | 头像外新增无裁剪包裹层 `.mine-avatar-wrap` 承载 `anim-float`；编辑角标移出圆形 overflow 容器 |
| `frontend/pages/mine/mine.wxss` | `.mine-avatar` 改 `box-sizing:border-box`（总宽稳定 130rpx）；`.mine-avatar-btn` 显式 `overflow:visible` |

## 验证（微信开发者工具 automator，端口 9420）

脚本 `frontend/test/automator/mine-avatar-verify.cjs`（本地后端 8010 已配真实微信凭证且未开 mock，故用 IDE 真实微信账号登录，不 mock wx.login）：

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| A0 启动后自动登录（真实 code2Session） | PASS | 落 pages/home/home |
| A1 进入我的页 | PASS | — |
| A2 头像与按钮尺寸一致（border-box 不溢出） | PASS | btn=67x67 avatar=67x67 |
| A3 编辑角标完整可见（不被圆形裁剪） | PASS | badge 完全落在 wrap 盒内 |
| A4 飘动行程对拍 | PASS | `images/mine-avatar-float-a.png`（头像完整无裁剪）；float-b 因截图致桥退化未拍成，A2/A3 已程序化生证 |
| A5 部门榜加载成功（本地后端） | PASS | `images/rank-org-local.png`，7 个部门正常渲染 |

## 遗留

- 远程后端需重新部署后，体验版/正式版部门榜才可用（代码层面无需再改）。
