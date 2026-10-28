# 同步微信步数提示去掉「近7天」

- 日期：2026-10-28
- 改动：`pages/home/home.js`、`pages/march/march.js` 的同步成功提示统一为「同步成功」；部分日期失败仍提示失败，不改成成功。
- 验证：`node --check` 两份页面通过。微信开发者工具自动化端口 9420 运行 `frontend/test/automator/sync-toast-copy.cjs`，首页与长征页点击同步后捕获的 toast 标题均为「同步成功」，不含「近7天」。首页截图 `frontend/test/images/sync-toast-success.png`。
