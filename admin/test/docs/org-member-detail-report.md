# 组织架构 · 人员明细查看功能验收报告

日期：2026-10-09 ｜ 范围：admin（Vue3 前端）+ backend（FastAPI）｜ 结果：**全部通过**

## 背景

管理后台「组织架构」页面的「直属人数」「成员总数（含下级）」两列增加人员明细查看：点击数字弹出对应口径的人员列表（分页 + 空状态），关闭后页面状态保持。

## 改动

- **backend**
  - `app/schemas/schemas.py`：新增 `AdminOrgUserOut` / `AdminOrgUserListOut`（字段复用排名洞察人员展示口径）。
  - `app/services/admin_service.py`：新增 `get_org_users`——`scope=direct` 与 `direct_user_count` 同口径（`org_id == 目标组织`）；`scope=all` 复用 `_collect_subtree_ids` 一次 `in` 查询，与 `total_user_count` 同口径不重不漏；分页 + 组织全路径批量映射（无 N+1）。
  - `app/api/routes/admin.py`：新增 `GET /api/admin/orgs/{org_id}/users?scope=&page=&page_size=`（管理员鉴权；非法 scope 422；组织不存在 404）。
  - 文档：README.md、design.md API 一览同步。
  - 冒烟：`backend/test/s6_org_user_detail.py` **8/8 通过**（鉴权/两口径与树统计一致/分页不重不漏/空组织/404/422）。
- **admin**
  - `src/api/admin.ts`：新增类型与 `fetchOrgUsers`。
  - `src/views/OrgsView.vue`：两列人数改为可点击 el-tag（`@click.stop` 防止触发行展开/折叠，hover 有视觉反馈）；新增人员明细弹窗（标题含组织名与统计类型、人员表格、分页、空状态、关闭按钮）。

## 验收用例（浏览器实测，dev server 5173 + 后端 8010）

| # | 验收标准 | 实测结果 |
| --- | --- | --- |
| 1 | 点击直属人数只展示直属成员 | ✅ 总部直属 5 → 弹窗 5 条，所属组织全部为「长征集团总部」，无下级成员 |
| 2 | 点击成员总数展示含全部层级下级成员 | ✅ 总部 7 条（含华东/技术部/前端组/后端组成员，显示组织全路径）；华东 2 条均为其下级组成员 |
| 3 | 明细数量与列统计一致 | ✅ 5==5、7==7、2==2、0==0（华东直属空） |
| 4 | 空组织/无下级组织/多层级组织正确展示 | ✅ 华东直属 0 → 「该统计口径下暂无人员」空状态 + 共 0 条 |
| 5 | 点击不触发节点展开/折叠 | ✅ 先折叠华东，再点其总数：弹窗打开且子行保持 display:none |
| 6 | 关闭弹窗后页面状态保持 | ✅ 关闭后华东仍为折叠态，其余节点展开态不变 |
| 7 | 不影响现有新增/编辑/删除/同步 | ✅ 构建通过、页面正常渲染；组织 CRUD 代码路径未改动 |

## 视觉证据

- `admin/test/images/org-members-direct-dialog.png`（直属人员明细弹窗）
- `admin/test/images/org-members-all-dialog.png`（全部成员明细弹窗，含下级全路径）
- `admin/test/images/org-members-empty-dialog.png`（空状态弹窗）

## 备注

- 控制台仅有的报错为测试数据中无效头像 URL（`http://store/...`），头像回退文字首字，与本次改动无关。
- 后端冒烟与浏览器验收数据来自同一 openGauss 库，两口径数量互相对得上。
