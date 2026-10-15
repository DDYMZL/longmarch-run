# 节点详情路线位置修复测试报告

日期：2026-10-15 ｜ 结论：通过

## 修复内容

- `/api/march/node/{node_id}` 响应补充 `latitude`、`longitude`。
- `NodeDetailOut` 同步声明路线点位字段。

## 验证结果

- Python 语法编译：通过。
- `march_service.get_node_detail` + `NodeDetailOut` 坐标契约测试：2/2 通过。
- 验证点位：飞夺泸定桥 `29.91, 102.24`。
