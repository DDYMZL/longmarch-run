// 管理后台 API 封装：类型定义与后端 app/schemas/schemas.py 的 Admin* 模型一一对应
import request from './request'

// ---------------- 类型 ----------------
export interface LoginResult {
  token: string
  username: string
}

export interface QuestionOption {
  label: string
  text: string
}

export interface Question {
  id: number
  type: 'single' | 'judge'
  question: string
  options: QuestionOption[]
  answer: string[]
  analysis: string
  score: number
  category: string
}

export interface QuestionListResult {
  total: number
  items: Question[]
}

export interface QuestionUpsert {
  type: string
  question: string
  options: QuestionOption[]
  answer: string[]
  analysis: string
  score: number
  category: string
}

export interface OrgNode {
  id: number
  name: string
  parent_id: number | null
  level: number
  sort_order: number
  direct_user_count: number
  total_user_count: number
  children: OrgNode[]
}

export interface OrgTreeResult {
  total: number
  nodes: OrgNode[]
}

export interface OrgUpsert {
  name: string
  parent_id: number | null
  sort_order: number
}

export interface OrgSyncResult {
  source: string
  created: number
  updated: number
  deleted: number
  kept: number
  skipped: number[]
}

export interface OrgUserItem {
  user_id: number
  nickname: string
  avatar: string
  org_name: string
  created_at: string | null
}

export interface OrgUserListResult {
  total: number
  items: OrgUserItem[]
}

export interface RouteNode {
  id: number
  name: string
  icon: string
  target_steps: number
  historical_time: string
  description: string
  latitude: number
  longitude: number
  sort_order: number
  is_enabled: boolean
  brief: string
  significance: string
  figures: string
  location: string
  images: string[]
  audio: string
  keywords: string
}

export type RouteNodeUpsert = Omit<RouteNode, 'id'>

export interface RouteNodeListResult {
  total: number
  items: RouteNode[]
}

// ---------------- 每日寄语（需求 §16、V1.1 按天循环） ----------------
export interface QuoteUpsert {
  content: string
  source: string
  sort_order: number
  is_enabled: boolean
  node_id: number | null
}

export interface Quote extends QuoteUpsert {
  id: number
  node_name: string
}

export interface QuoteListResult {
  total: number
  items: Quote[]
}

// today_position：今日寄语在启用列表中的序号（从 1 起，无启用寄语为 0）
export interface QuoteCycle {
  start_date: string
  enabled_count: number
  today_quote_id: number | null
  today_position: number
}

export interface MessageResult {
  message: string
}

// ---------------- 驾驶舱 / 数据大屏 ----------------
export interface DashboardMetrics {
  total_users: number
  today_users: number
  total_steps: number
  avg_steps: number
  completion_rate: number
  quiz_users: number
  medals_granted: number
}

export interface RouteOverviewItem {
  node_id: number
  name: string
  target_steps: number
  lit_count: number
  completion_rate: number
}

export interface DashboardResult {
  metrics: DashboardMetrics
  route_overview: RouteOverviewItem[]
}

export interface TrendPoint {
  date: string
  total_steps: number
  active_users: number
  new_users: number
  new_lit: number
}

export interface TrendResult {
  days: number
  points: TrendPoint[]
}

export interface ActivityItem {
  id: number
  event_type: string
  event_time: string
  user_id: number
  nickname: string
  text: string
  data: Record<string, unknown>
}

export interface ActivityListResult {
  items: ActivityItem[]
}

export interface ScreenResult {
  metrics: DashboardMetrics
  route_overview: RouteOverviewItem[]
  trend: TrendPoint[]
  activities: ActivityItem[]
}

// ---------------- 人员详情聚合 ----------------
export interface OverviewUser {
  user_id: number
  nickname: string
  avatar: string
  org_name: string
  original_nickname: string
  nickname_changed_at: string | null
  created_at: string | null
}

export interface OverviewRecentSport {
  date: string
  steps: number
  text: string
}

export interface OverviewSport {
  today_steps: number
  total_steps: number
  recent: OverviewRecentSport[]
}

export interface OverviewQuizRecord {
  date: string
  total_count: number
  correct_count: number
  score: number
  points: number
  answer_at: number
}

export interface OverviewMedal {
  id: string
  name: string
  icon: string
  desc: string
  granted_at: string | null
}

export interface OverviewNode {
  id: number
  name: string
  target_steps: number
  reached: boolean
  reached_at: string | null
}

export interface OverviewMarch {
  completed_nodes: number
  node_count: number
  nodes: OverviewNode[]
}

export interface OverviewPoint {
  date: string
  reason: string
  delta: number
}

export interface OverviewPoints {
  total: number
  logs: OverviewPoint[]
}

export interface UserOverview {
  user: OverviewUser
  sport: OverviewSport
  quiz_records: OverviewQuizRecord[]
  medals: OverviewMedal[]
  march: OverviewMarch
  points: OverviewPoints
}

export function fetchUserOverview(userId: number) {
  return request.get<UserOverview>(`/admin/users/${userId}/overview`)
}

// ---------------- 排名洞察（服务端分页/筛选/流式导出） ----------------
export interface RankNode { id: number; name: string; target_steps: number; reached: boolean; reached_at: string | null }
export interface RankItem { rank: number; user_id: number; nickname: string; avatar: string; org_name: string; original_nickname: string; nickname_changed_at: string | null; total_steps: number; completed_nodes: number; node_count: number; last_reached_at: string | null; nodes: RankNode[] }
export interface RankResult { total: number; total_steps: number; completed_users: number; avg_progress: number; match_total: number; org_options: { id: number; name: string }[]; route_nodes: RankNode[]; podium: RankItem[]; items: RankItem[] }
export interface RankFilter { keyword?: string; org_id?: number | null; only_changed?: boolean }

function rankParams(filter: RankFilter) {
  return { keyword: filter.keyword || undefined, org_id: filter.org_id ?? undefined, only_changed: filter.only_changed || undefined }
}

export function fetchRankings(page: number, pageSize: number, filter: RankFilter) {
  return request.get<RankResult>('/admin/rankings', { params: { page, page_size: pageSize, ...rankParams(filter) } })
}

export function exportRankings(filter: RankFilter) {
  return request.get<Blob>('/admin/rankings/export', { params: rankParams(filter), responseType: 'blob', timeout: 0 })
}

// ---------------- 登录 ----------------
export function login(username: string, password: string) {
  return request.post<LoginResult>('/admin/login', { username, password })
}

// ---------------- 微信扫码登录 ----------------
export interface QrCreateResult {
  qr_id: string
  image: string | null
  scene: string | null
  mock: boolean
  expires_in: number
}

export interface MenuItem {
  code: string
  name: string
}

export interface QrStatusResult {
  status: string
  fail_reason: string | null
  expires_in: number | null
  token: string | null
  username: string | null
  is_super: boolean | null
  menus: MenuItem[]
}

export function createWechatQr() {
  return request.post<QrCreateResult>('/admin/wechat/qr')
}

export function pollWechatQr(qrId: string) {
  return request.get<QrStatusResult>(`/admin/wechat/qr/${qrId}/status`, { silent: true })
}

export interface OnboardingQrResult {
  image: string | null
  page: string
  scene: string
  env_version: string
  mock: boolean
}

export function fetchOnboardingQr() {
  return request.get<OnboardingQrResult>('/admin/onboarding-qrcode')
}

export interface MeResult {
  username: string
  is_super: boolean
  menus: MenuItem[]
  roles: string[]
}

export function fetchMe() {
  return request.get<MeResult>('/admin/me')
}

// ---------------- 人员授权 / 角色管理 / 审计日志 ----------------
export interface UserRoleItem {
  id: number
  code: string
  name: string
  enabled: boolean
}

export interface AdminUserItem {
  id: number
  nickname: string
  avatar: string | null
  org_id: number | null
  org_name: string | null
  has_access: boolean
  roles: UserRoleItem[]
}

export interface AdminUserListResult {
  total: number
  items: AdminUserItem[]
}

export interface AdminUserQuery {
  page: number
  page_size: number
  keyword?: string
  org_id?: number | null
  has_access?: boolean | null
}

export function fetchAdminUsers(params: AdminUserQuery) {
  return request.get<AdminUserListResult>('/admin/users', { params })
}

export interface RoleItem {
  id: number
  code: string
  name: string
  is_builtin: boolean
  menus: string[]
  user_count: number
}

export interface RoleListResult {
  items: RoleItem[]
}

export function fetchRoles() {
  return request.get<RoleListResult>('/admin/roles')
}

export interface RoleUpsert {
  name: string
  menus: string[]
}

export function createRole(data: RoleUpsert) {
  return request.post<RoleItem>('/admin/roles', data)
}

export function updateRole(id: number, data: RoleUpsert) {
  return request.put<RoleItem>(`/admin/roles/${id}`, data)
}

export function deleteRole(id: number) {
  return request.delete<MessageResult>(`/admin/roles/${id}`)
}

export function grantUserRoles(userId: number, roleIds: number[]) {
  return request.post<MessageResult>(`/admin/users/${userId}/roles`, { role_ids: roleIds })
}

export function setUserRoleEnabled(userId: number, roleId: number, isEnabled: boolean) {
  return request.patch<MessageResult>(`/admin/users/${userId}/roles/${roleId}/enabled`, {
    is_enabled: isEnabled
  })
}

export interface AuditLogItem {
  id: number
  actor_type: string
  actor_user_id: number | null
  actor_name: string | null
  action: string
  target_user_id: number | null
  target_name: string | null
  detail: string | null
  created_at: string
}

export interface AuditLogListResult {
  total: number
  items: AuditLogItem[]
}

export interface AuditQuery {
  page: number
  page_size: number
  action?: string
  actor_type?: string
  date?: string
}

export function fetchAuditLogs(params: AuditQuery) {
  return request.get<AuditLogListResult>('/admin/audit-logs', { params })
}

// ---------------- 路线节点 ----------------
export function fetchRouteNodes(silent = false) {
  return request.get<RouteNodeListResult>('/admin/route-nodes', { silent })
}

export function createRouteNode(data: RouteNodeUpsert) {
  return request.post<RouteNode>('/admin/route-nodes', data)
}

export function updateRouteNode(id: number, data: RouteNodeUpsert) {
  return request.put<RouteNode>(`/admin/route-nodes/${id}`, data)
}

export function setRouteNodeEnabled(id: number, isEnabled: boolean) {
  return request.patch<RouteNode>(`/admin/route-nodes/${id}/enabled`, {
    is_enabled: isEnabled
  })
}

// ---------------- 题库 ----------------
export interface QuestionQuery {
  page: number
  page_size: number
  keyword?: string
  qtype?: string
  category?: string
}

export interface ImportErrorRow {
  row: number
  field: string
  reason: string
}

export interface ImportPreviewResult {
  preview_token: string
  total: number
  valid_count: number
  invalid_count: number
  errors: ImportErrorRow[]
}

export function fetchQuestions(query: QuestionQuery) {
  return request.get<QuestionListResult>('/admin/questions', { params: query })
}

export function createQuestion(data: QuestionUpsert) {
  return request.post<Question>('/admin/questions', data)
}

export function updateQuestion(id: number, data: QuestionUpsert) {
  return request.put<Question>(`/admin/questions/${id}`, data)
}

export function deleteQuestion(id: number) {
  return request.delete<MessageResult>(`/admin/questions/${id}`)
}

function downloadImportTemplate(url: string) {
  return request.get<Blob>(url, { responseType: 'blob' })
}

function previewImport(url: string, file: File) {
  const form = new FormData()
  form.append('file', file)
  return request.post<ImportPreviewResult>(url, form)
}

function confirmImport(url: string, previewToken: string) {
  return request.post<{ imported: number }>(url, { preview_token: previewToken })
}

export const questionImportApi = {
  downloadTemplate: () => downloadImportTemplate('/admin/questions/import-template'),
  preview: (file: File) => previewImport('/admin/questions/import-preview', file),
  confirm: (token: string) => confirmImport('/admin/questions/import-confirm', token)
}

// ---------------- 每日寄语 ----------------
export function fetchQuotes(page: number, pageSize: number, keyword = '') {
  return request.get<QuoteListResult>('/admin/quotes', {
    params: { page, page_size: pageSize, keyword: keyword || undefined }
  })
}

export function createQuote(data: QuoteUpsert) {
  return request.post<Quote>('/admin/quotes', data)
}

export function updateQuote(id: number, data: QuoteUpsert) {
  return request.put<Quote>(`/admin/quotes/${id}`, data)
}

export function deleteQuote(id: number) {
  return request.delete<MessageResult>(`/admin/quotes/${id}`)
}

export function fetchQuoteCycle() {
  return request.get<QuoteCycle>('/admin/quotes/cycle')
}

export function updateQuoteCycle(startDate: string) {
  return request.put<QuoteCycle>('/admin/quotes/cycle', { start_date: startDate })
}

export const quoteImportApi = {
  downloadTemplate: () => downloadImportTemplate('/admin/quotes/import-template'),
  preview: (file: File) => previewImport('/admin/quotes/import-preview', file),
  confirm: (token: string) => confirmImport('/admin/quotes/import-confirm', token)
}

// ---------------- 组织架构 ----------------
export function fetchOrgTree(silent = false) {
  return request.get<OrgTreeResult>('/admin/orgs', { silent })
}

export function createOrg(data: OrgUpsert) {
  return request.post<OrgNode>('/admin/orgs', data)
}

export function updateOrg(id: number, data: OrgUpsert) {
  return request.put<OrgNode>(`/admin/orgs/${id}`, data)
}

export function deleteOrg(id: number) {
  return request.delete<MessageResult>(`/admin/orgs/${id}`)
}

export function syncOrgs() {
  return request.post<OrgSyncResult>('/admin/orgs/sync')
}

export function fetchOrgUsers(orgId: number, scope: 'direct' | 'all', page: number, pageSize: number) {
  return request.get<OrgUserListResult>(`/admin/orgs/${orgId}/users`, {
    params: { scope, page, page_size: pageSize }
  })
}

// ---------------- 驾驶舱 / 数据大屏 ----------------
export function fetchDashboard() {
  return request.get<DashboardResult>('/admin/dashboard')
}

export function fetchDashboardTrend(days: number) {
  return request.get<TrendResult>('/admin/dashboard/trend', { params: { days } })
}

export function fetchActivities(limit: number) {
  return request.get<ActivityListResult>('/admin/activities', { params: { limit } })
}

export function fetchScreen() {
  return request.get<ScreenResult>('/admin/screen')
}
