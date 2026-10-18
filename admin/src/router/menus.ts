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
  { code: 'audit', path: '/audit', title: '审计日志', icon: 'Document' },
  { code: 'activity', path: '/activity', title: '活动设置', icon: 'Flag' },
  { code: 'persons', path: '/persons', title: '人物志', icon: 'User' },
  { code: 'medals', path: '/medals', title: '勋章管理', icon: 'Medal' },
  { code: 'chapters', path: '/chapters', title: '章节配置', icon: 'Notebook' },
  { code: 'operation_config', path: '/operation-config', title: '运营参数', icon: 'SetUp' },
  { code: 'analytics', path: '/analytics', title: '数据分析', icon: 'TrendCharts' }
] as const

export type MenuCode = (typeof MENUS)[number]['code']

// 侧边栏一级分组（按功能划分）：children 为 MENUS 的 code，仅影响侧边栏展示形态，
// 权限码、路由守卫、角色勾选仍基于 MENUS 平铺列表不变；
// 未列入任何分组的菜单自动作为一级菜单平铺展示（新增菜单不会从侧边栏丢失）
export interface MenuGroupDef {
  code: string
  title: string
  icon: string
  children: MenuCode[]
}

export const MENU_GROUPS: MenuGroupDef[] = [
  { code: 'grp_overview', title: '数据总览', icon: 'DataLine', children: ['screen', 'rankings', 'analytics'] },
  { code: 'grp_content', title: '内容管理', icon: 'Files', children: ['route_nodes', 'chapters', 'questions', 'quotes', 'persons', 'medals'] },
  { code: 'grp_org', title: '组织与人员', icon: 'OfficeBuilding', children: ['orgs', 'access', 'invites'] },
  { code: 'grp_operation', title: '运营配置', icon: 'SetUp', children: ['activity', 'operation_config'] },
  { code: 'grp_system', title: '系统管理', icon: 'Setting', children: ['audit'] }
]
