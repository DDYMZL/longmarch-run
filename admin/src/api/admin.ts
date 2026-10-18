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
  source_type: string
}

// 与小程序同源：total = walk + quiz，rank 为总积分榜名次
export interface OverviewPoints {
  total: number
  walk: number
  quiz: number
  rank: number | null
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

// ---------------- 排名洞察（服务端分页/筛选/流式导出；名次按总积分，与小程序同口径） ----------------
export interface RankNode { id: number; name: string; target_steps: number; reached: boolean; reached_at: string | null }
export interface RankItem { rank: number; user_id: number; nickname: string; avatar: string; org_name: string; original_nickname: string; nickname_changed_at: string | null; total_steps: number; total_points: number; walk_points: number; quiz_points: number; completed_nodes: number; node_count: number; last_reached_at: string | null; nodes: RankNode[] }
// podium：全员前 10 名（1~3 领奖台、4~10 荣誉卡），不受筛选影响
export interface RankResult { total: number; total_steps: number; total_points: number; completed_users: number; avg_progress: number; match_total: number; org_options: { id: number; name: string }[]; route_nodes: RankNode[]; podium: RankItem[]; items: RankItem[] }
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

// ---------------- 积分台账核对 / 修复 ----------------
export interface PointsDiff { user_id: number; biz_key: string; expected: number; actual: number }
export interface PointsVerifyResult { users: number; checked_days: number; mismatches: number; fixed: number; samples: PointsDiff[] }

export function verifyPoints(fix: boolean) {
  return request.post<PointsVerifyResult>('/admin/points/verify', { fix }, { timeout: 0 })
}

// ---------------- 活动设置 ----------------
export type ActivityStatus = 'unpublished' | 'not_started' | 'ongoing' | 'ended'

// start_at / end_at：读取为带 +08:00 的 ISO 时间，保存时传北京时间 YYYY-MM-DDTHH:mm
export interface ActivityForm {
  name: string
  start_at: string
  end_at: string
  restrict_enabled: boolean
  allow_view_after_end: boolean
  end_title: string
  end_message: string
}

export interface ActivitySetting extends Omit<ActivityForm, 'start_at' | 'end_at'> {
  start_at: string | null
  end_at: string | null
  status: ActivityStatus
  status_text: string
  allow_participate: boolean
  allow_view: boolean
  message: string
  server_time: string
  is_published: boolean
  updated_at: string | null
  updated_by: string | null
  configured: boolean
}

export function fetchActivity() {
  return request.get<ActivitySetting>('/admin/activity')
}

export function saveActivity(data: ActivityForm) {
  return request.put<ActivitySetting>('/admin/activity', data)
}

export function publishActivity(published: boolean) {
  return request.post<ActivitySetting>('/admin/activity/publish', { published })
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

// ---------------- 入驻邀请码 ----------------
export type InviteStatus = 'active' | 'disabled' | 'expired' | 'exhausted'

export interface InviteItem {
  id: number
  code: string
  name: string
  remark: string | null
  org_id: number | null
  org_name: string | null
  max_uses: number | null
  used_count: number
  expires_at: string | null
  is_enabled: boolean
  status: InviteStatus
  created_by: string | null
  created_at: string
}

export interface InviteListResult {
  total: number
  items: InviteItem[]
}

// org_id / max_uses / expires_at 传 null 表示不限；expires_at 为带时区的 ISO 字符串
export interface InviteUpsert {
  name: string
  remark: string | null
  org_id: number | null
  max_uses: number | null
  expires_at: string | null
}

export interface InviteQrResult {
  image: string | null
  page: string
  scene: string
  env_version: string
  mock: boolean
}

export function fetchInvites(page: number, pageSize: number, keyword = '') {
  return request.get<InviteListResult>('/admin/invites', { params: { page, page_size: pageSize, keyword: keyword || undefined } })
}

export function createInvite(data: InviteUpsert) {
  return request.post<InviteItem>('/admin/invites', data)
}

export function updateInvite(id: number, data: Partial<InviteUpsert> & { is_enabled?: boolean }) {
  return request.patch<InviteItem>(`/admin/invites/${id}`, data)
}

export function fetchInviteQr(id: number) {
  return request.get<InviteQrResult>(`/admin/invites/${id}/qrcode`)
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
  status: UserStatus
  invite_code_id: number | null
  invite_name: string | null
  onboarded_at: string | null
}

export type UserStatus = 'active' | 'disabled'

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
  status?: UserStatus | ''
}

export function fetchAdminUsers(params: AdminUserQuery) {
  return request.get<AdminUserListResult>('/admin/users', { params })
}

export function setUserStatus(userId: number, status: UserStatus) {
  return request.patch<MessageResult>(`/admin/users/${userId}/status`, { status })
}

// 用户侧所属组织首次确定后锁定，仅管理员可调整（写审计 user.org_change）
export function setUserOrg(userId: number, orgId: number) {
  return request.put<MessageResult>(`/admin/users/${userId}/org`, { org_id: orgId })
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

// ---------------- AI 智能出题 ----------------
export interface AiGeneratePayload {
  topic: string
  count: number
  question_type: string
  difficulty: string
  category?: string
  extra_requirements?: string
}

export interface AiQuestionDraft {
  index: number
  data: QuestionUpsert
  errors: string[]
}

export interface AiGenerateResult {
  requested: number
  generated: number
  valid_count: number
  invalid_count: number
  items: AiQuestionDraft[]
  batch_errors: string[]
}

export interface AiSaveFailure {
  index: number
  reason: string
}

export interface AiBatchSaveResult {
  saved: number
  failed: number
  failures: AiSaveFailure[]
}

// 生成需等待后端分批调用 Agent，耗时可达分钟级：不设前端超时（timeout: 0），
// 由用户通过 signal 主动取消；silent 让错误在弹窗内联展示而非全局 toast。
export function generateAiQuestions(data: AiGeneratePayload, signal?: AbortSignal) {
  return request.post<AiGenerateResult>('/admin/ai/generate-questions', data, {
    timeout: 0,
    signal,
    silent: true
  })
}

export function batchSaveAiQuestions(questions: QuestionUpsert[]) {
  return request.post<AiBatchSaveResult>(
    '/admin/ai/questions/batch-save',
    { questions },
    { silent: true }
  )
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

// ---------------- 人物志 ----------------
export interface PersonItem {
  id: number
  name: string
  avatar: string
  brief: string
  node_ids: number[]
}

export interface PersonUpsert {
  name: string
  avatar: string
  brief: string
  node_ids: number[]
}

export interface PersonListResult {
  total: number
  items: PersonItem[]
}

export function fetchPersons(page: number, pageSize: number, keyword = '') {
  return request.get<PersonListResult>('/admin/persons', {
    params: { page, page_size: pageSize, keyword: keyword || undefined }
  })
}

export function createPerson(data: PersonUpsert) {
  return request.post<PersonItem>('/admin/persons', data)
}

export function updatePerson(id: number, data: PersonUpsert) {
  return request.put<PersonItem>(`/admin/persons/${id}`, data)
}

export function deletePerson(id: number) {
  return request.delete<MessageResult>(`/admin/persons/${id}`)
}

export function uploadPersonAvatar(file: File) {
  const fd = new FormData()
  fd.append('file', file)
  return request.post<{ url: string }>('/admin/persons/avatar', fd)
}

export const personImportApi = {
  downloadTemplate: () => downloadImportTemplate('/admin/persons/import-template'),
  preview: (file: File) => previewImport('/admin/persons/import-preview', file),
  confirm: (token: string) => confirmImport('/admin/persons/import-confirm', token)
}

// ---------------- 勋章 ----------------
export interface MedalItem {
  id: string
  name: string
  icon: string
  desc: string
  category: string
  hidden: boolean
  sort_order: number
}

export interface MedalUpsert {
  id?: string
  name: string
  icon: string
  desc: string
  category: string
  hidden: boolean
  sort_order: number
}

export interface MedalListResult {
  total: number
  items: MedalItem[]
}

export function fetchMedals(page: number, pageSize: number, keyword = '') {
  return request.get<MedalListResult>('/admin/medals', {
    params: { page, page_size: pageSize, keyword: keyword || undefined }
  })
}

export function createMedal(data: MedalUpsert) {
  return request.post<MedalItem>('/admin/medals', data)
}

export function updateMedal(id: string, data: MedalUpsert) {
  return request.put<MedalItem>(`/admin/medals/${id}`, data)
}

export function deleteMedal(id: string) {
  return request.delete<MessageResult>(`/admin/medals/${id}`)
}

// ---------------- 章节 ----------------
export interface ChapterItem {
  id: number
  name: string
  title: string
  intro: string
  node_ids: number[]
  sort_order: number
}

export interface ChapterUpsert {
  name: string
  title: string
  intro: string
  node_ids: number[]
  sort_order: number
}

export interface ChapterListResult {
  total: number
  items: ChapterItem[]
}

export function fetchChapters(page: number, pageSize: number, keyword = '') {
  return request.get<ChapterListResult>('/admin/chapters', {
    params: { page, page_size: pageSize, keyword: keyword || undefined }
  })
}

export function createChapter(data: ChapterUpsert) {
  return request.post<ChapterItem>('/admin/chapters', data)
}

export function updateChapter(id: number, data: ChapterUpsert) {
  return request.put<ChapterItem>(`/admin/chapters/${id}`, data)
}

export function deleteChapter(id: number) {
  return request.delete<MessageResult>(`/admin/chapters/${id}`)
}

export function reorderChapters(ids: number[]) {
  return request.post<ChapterListResult>('/admin/chapters/reorder', { ordered_ids: ids })
}

// ---------------- 运营参数 ----------------
export interface OperationConfigRange {
  min: number
  max: number
  step?: number
}

export interface OperationConfigView {
  values: Record<string, number | boolean | string>
  defaults: Record<string, number | boolean | string>
  ranges: Record<string, OperationConfigRange>
  overridden: string[]
}

export function fetchOperationConfig() {
  return request.get<OperationConfigView>('/admin/operation-config')
}

export function saveOperationConfig(values: Record<string, number | boolean | string>) {
  return request.put<OperationConfigView>('/admin/operation-config', { values })
}

// ---------------- 数据运营分析 ----------------
export interface OrgCompareItem {
  org_id: number
  org_name: string
  member_count: number
  total_steps: number
  avg_steps: number
  active_users: number
  lit_nodes: number
  avg_points: number
}

export interface InviteFunnelItem {
  invite_id: number
  invite_name: string
  invite_code: string
  scans: number
  onboarded: number
  first_logins: number
  synced: number
}

export interface SyncFailureItem {
  user_id: number
  nickname: string
  org_name: string
  date: string
  fail_reason: string
}

export interface SyncFailureResult {
  total: number
  items: SyncFailureItem[]
}

export interface PointsHealthResult {
  mismatches: number
  users: number
  checked_days: number
}

export function fetchAnalyticsOrgs() {
  return request.get<{ items: OrgCompareItem[] }>('/admin/analytics/orgs')
}

export function fetchInviteFunnel() {
  return request.get<{ items: InviteFunnelItem[] }>('/admin/analytics/invite-funnel')
}

export function fetchSyncFailures(days = 7) {
  return request.get<SyncFailureResult>('/admin/analytics/sync-failures', { params: { days } })
}

export function fetchPointsHealth() {
  return request.get<PointsHealthResult>('/admin/analytics/points-health', { silent: true })
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
