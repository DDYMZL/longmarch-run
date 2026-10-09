# S6 组织人员明细 · 后端冒烟报告

日期：2026-10-09 ｜ 脚本：`backend/test/s6_org_user_detail.py`（TestClient，不依赖 8010 残留进程）｜ 结果：**8/8 通过**

## 背景

管理后台「组织架构」页面为「直属人数」「成员总数（含下级）」两列增加人员明细查看：点击后弹窗展示对应口径的人员列表（分页）。

## 改动

- `app/schemas/schemas.py`：新增 `AdminOrgUserOut`（user_id/nickname/avatar/org_name/created_at，字段复用排名洞察人员展示口径）与 `AdminOrgUserListOut`（total + items）。
- `app/services/admin_service.py`：新增 `get_org_users`——`scope=direct` 查询 `org_id == 目标组织`（与 `direct_user_count` 同口径）；`scope=all` 复用 `_collect_subtree_ids` 取子树组织集合后一次 `in` 查询（与 `total_user_count` 同口径，不重不漏）；按 `user_id` 稳定排序 + offset/limit 分页；组织全路径名复用 `org_service.get_full_name_map` 批量计算，无 N+1。
- `app/api/routes/admin.py`：新增 `GET /api/admin/orgs/{org_id}/users?scope=&page=&page_size=`（管理员鉴权；scope 仅 direct/all，非法值 422；组织不存在 404）。
- 文档：`README.md`、`design.md` API 一览同步新接口。

## 用例结果

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| A1 | 无 token 访问人员明细返回 401 | ✅ |
| A0 | 存在含下级组织（总部）与直属验证目标组织 | ✅ |
| A2 | `scope=direct` total/条目与树 `direct_user_count` 一致，条目恰为 org_id==该组织的用户（总部 5==5，不含下级成员） | ✅ |
| A3 | `scope=all` total/条目与树 `total_user_count` 一致，逐条核对 org_id 均落在子树内（总部 7==7） | ✅ |
| A4 | page_size=2 逐页拉全量：7 条不重不漏 | ✅ |
| A5 | 无成员组织（市场部）返回 total=0 且 items 为空 | ✅ |
| A6 | 组织不存在返回 404 | ✅ |
| A7 | 非法 scope 返回 422 | ✅ |

## 备注

- 脚本幂等：运行前按 code 派生的 mock openid 清理测试用户。
- 与组织树统计口径的一致性通过对同一数据源（organizations/users 表）的 DB 直查比对验证，人员归属变化后明细与统计同步反映。
