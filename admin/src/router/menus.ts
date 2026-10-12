// 菜单目录唯一来源（与 docker/init/010_admin_identity.sql 种子一致）：
// 侧边栏渲染、无权限回退顺序、角色菜单勾选与菜单名展示共用
export const MENUS = [
  { code: 'dashboard', path: '/dashboard', title: '驾驶舱', icon: 'Odometer' },
  { code: 'screen', path: '/screen', title: '数据大屏', icon: 'Monitor' },
  { code: 'rankings', path: '/rankings', title: '排名洞察', icon: 'DataAnalysis' },
  { code: 'route_nodes', path: '/route-nodes', title: '路线点位', icon: 'Location' },
  { code: 'questions', path: '/questions', title: '题库维护', icon: 'EditPen' },
  { code: 'quotes', path: '/quotes', title: '每日寄语', icon: 'ChatLineSquare' },
  { code: 'orgs', path: '/orgs', title: '组织架构', icon: 'OfficeBuilding' },
  { code: 'access', path: '/access', title: '人员授权', icon: 'Setting' },
  { code: 'invites', path: '/invites', title: '入驻邀请码', icon: 'Promotion' },
  { code: 'audit', path: '/audit', title: '审计日志', icon: 'Document' }
] as const
