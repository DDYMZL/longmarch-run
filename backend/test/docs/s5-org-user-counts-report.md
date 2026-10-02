# S5 组织人数统计 · 后端冒烟报告

日期：2026-10-02 ｜ 脚本：`backend/test/s5_org_user_counts.py`（TestClient，不依赖 8010 残留进程）｜ 结果：**7/7 通过**

## 背景

PC 端组织维度统计需求重新纳入（仅人数统计，不含排名/积分）：用户登录并选定组织后，管理端组织树按节点展示「直属人数 + 含下级累计人数」。

## 改动

- `app/schemas/schemas.py`：`AdminOrgNodeOut` 新增 `direct_user_count` / `total_user_count`（默认 0）。
- `app/services/admin_service.py`：`get_org_tree` 按 `org_id GROUP BY` 统计直属人数，新增 `_accumulate_user_count` 后序累加含下级总人数。
- 文档：`README.md`、`design.md` 的 `/api/admin/orgs` 条目同步契约说明。

## 用例结果

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| O1 | `GET /api/admin/orgs` 返回 200 | ✅ |
| O2 | 13 个节点均含 `direct_user_count`/`total_user_count` | ✅ |
| O3 | 全树不变量 `total == direct + Σ(下级 total)` | ✅ |
| O4 | 新用户（mock openid）登录并选定组织（市场部 id=5）成功 | ✅ |
| O5 | 目标组织 direct 0→1 | ✅ |
| O6 | 父组织（华东分公司）total 5→6（祖先链累计生效） | ✅ |
| O7 | Σ direct == 库内已选组织用户数（17 == 17） | ✅ |

## 备注

- 脚本幂等：运行前按 code 派生的 mock openid 清理测试用户。
- 旧 8010 进程为改动前代码（热重载未生效），已终止并用 `python run.py` 重启；重启后接口实测返回新字段（总部 direct=6 / total=17）。
