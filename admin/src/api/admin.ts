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

// ---------------- 每日寄语（需求 §16） ----------------
export interface Quote {
  id: number
  date: string
  content: string
  source: string
  node_id: number | null
  node_name: string
}

export interface QuoteListResult {
  total: number
  items: Quote[]
}

export interface QuoteUpsert {
  date: string
  content: string
  source: string
  node_id: number | null
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

// ---------------- 登录 ----------------
export function login(username: string, password: string) {
  return request.post<LoginResult>('/admin/login', { username, password })
}

// ---------------- 路线节点 ----------------
export function fetchRouteNodes() {
  return request.get<RouteNodeListResult>('/admin/route-nodes')
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
export function fetchQuestions() {
  return request.get<QuestionListResult>('/admin/questions')
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

// ---------------- 每日寄语 ----------------
export function fetchQuotes(page: number, pageSize: number) {
  return request.get<QuoteListResult>('/admin/quotes', { params: { page, page_size: pageSize } })
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

// ---------------- 组织架构 ----------------
export function fetchOrgTree() {
  return request.get<OrgTreeResult>('/admin/orgs')
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
