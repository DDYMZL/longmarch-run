<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { exportRankings, fetchRankings, fetchUserOverview, verifyPoints, type PointsVerifyResult, type RankFilter, type RankItem, type RankResult, type UserOverview } from '../api/admin'
import { useLiveUpdates } from '../utils/liveUpdates'
import { formatDateTime, formatNumber as number } from '../utils/format'
import { saveFile, today } from '../utils/download'


const loading = ref(false)
const exporting = ref(false)
const keyword = ref('')
const appliedKeyword = ref('')
const orgId = ref<number | null>(null)
const onlyChanged = ref(false)
const state = ref<RankResult>({ total: 0, total_steps: 0, total_points: 0, completed_users: 0, avg_progress: 0, match_total: 0, org_options: [], route_nodes: [], podium: [], items: [] })
const averageSteps = computed(() => state.value.total ? Math.round(state.value.total_steps / state.value.total) : 0)
const averagePoints = computed(() => state.value.total ? Math.round(state.value.total_points / state.value.total) : 0)
// 荣誉榜：1~3 名金银铜领奖台，4~10 名荣誉卡（与小程序排行榜同构）
const podiumTop = computed(() => state.value.podium.slice(0, 3))
const eliteCards = computed(() => state.value.podium.slice(3))
const MEDAL = ['gold', 'silver', 'bronze']

// 服务端分页与筛选：人员基数大时只拉取、渲染当前页，指标与领奖台为全员口径
const page = ref(1)
const pageSize = ref(50)
const filter = computed<RankFilter>(() => ({ keyword: appliedKeyword.value.trim(), org_id: orgId.value, only_changed: onlyChanged.value }))

let requestSeq = 0
async function load() {
  const seq = ++requestSeq
  loading.value = true
  try {
    const { data } = await fetchRankings(page.value, pageSize.value, filter.value)
    if (seq !== requestSeq) return
    // 数据变少导致当前页越界时回到最后一页
    const lastPage = Math.max(1, Math.ceil(data.match_total / pageSize.value))
    if (!data.items.length && page.value > lastPage) {
      page.value = lastPage
      return
    }
    state.value = data
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

let keywordTimer: number | null = null
watch(keyword, (value) => {
  if (keywordTimer !== null) window.clearTimeout(keywordTimer)
  keywordTimer = window.setTimeout(() => {
    keywordTimer = null
    appliedKeyword.value = value
  }, 300)
})
watch([appliedKeyword, orgId, onlyChanged], () => { page.value = 1 })
// 筛选变化与页码复位在同一轮刷新内合并，只触发一次请求
watch([page, pageSize, filter], load, { immediate: true })

// ---------------- 实时推送（数据变更防抖重载当前页） ----------------
const { wsStatus } = useLiveUpdates({ onDataChanged: load })

onBeforeUnmount(() => {
  if (keywordTimer !== null) window.clearTimeout(keywordTimer)
})

function progress(item: RankItem) { return item.node_count ? Math.round(item.completed_nodes / item.node_count * 100) : 0 }
function initial(name: string) { return name.trim().slice(0, 1) || '员' }
function time(value: string | null) { return formatDateTime(value, '尚未到达') }
async function exportData() {
  if (!state.value.match_total) return ElMessage.warning('当前没有可导出的排名数据')
  exporting.value = true
  try {
    const count = state.value.match_total
    const { data } = await exportRankings(filter.value)
    saveFile(data, `全员长征排名_${today()}.csv`)
    ElMessage.success(`已导出 ${count} 人的完整数据`)
  } finally {
    exporting.value = false
  }
}

// ---------------- 积分台账核对（先只读核对，确认后再修复） ----------------
const verifyVisible = ref(false)
const verifying = ref(false)
const verifyResult = ref<PointsVerifyResult | null>(null)
const verifyFixed = ref(false)

async function runVerify(fix: boolean) {
  if (verifying.value) return
  if (fix) {
    try {
      await ElMessageBox.confirm(`将按源数据重算并覆盖 ${verifyResult.value?.mismatches ?? 0} 条不一致的积分台账，操作会记录审计日志，确定修复吗？`, '修复积分台账', { type: 'warning', confirmButtonText: '确认修复' })
    } catch {
      return
    }
  }
  verifying.value = true
  try {
    verifyResult.value = (await verifyPoints(fix)).data
    verifyFixed.value = fix
    if (fix) {
      ElMessage.success(`已修复 ${verifyResult.value.fixed} 条积分台账`)
      load()
    }
  } finally {
    verifying.value = false
  }
}

function openVerify() {
  verifyResult.value = null
  verifyFixed.value = false
  verifyVisible.value = true
  runVerify(false)
}

const SOURCE_TEXT: Record<string, string> = { walk: '步行', quiz: '答题', legacy: '旧规则' }

// ---------------- 人员详情抽屉（运动/答题/勋章/长征/积分） ----------------
const overviewVisible = ref(false)
const overviewLoading = ref(false)
const overview = ref<UserOverview | null>(null)
const overviewName = ref('')

async function openOverview(row: RankItem, _column: unknown, event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target && target.closest && target.closest('.el-table__expand-column')) return
  overviewName.value = row.nickname
  overview.value = null
  overviewVisible.value = true
  overviewLoading.value = true
  try {
    overview.value = (await fetchUserOverview(row.user_id)).data
  } catch (error) {
    ElMessage.error('人员详情加载失败')
    overviewVisible.value = false
  } finally {
    overviewLoading.value = false
  }
}
</script>

<template>
  <main class="rank-page" v-loading="loading">
    <section class="hero">
      <div><label><i /> LONG MARCH COMMAND CENTER</label><h1>全员征程排名</h1><p>按总积分（步行 + 答题）实时排名，同分按累计步数，洞察全员征程进度</p></div>
      <div class="actions"><span class="ws-status" :class="wsStatus"><i />{{ wsStatus === 'online' ? '实时同步中' : wsStatus === 'connecting' ? '正在连接实时通道…' : '实时通道已断开，重连中…' }}</span><el-button :icon="'Refresh'" :loading="loading" @click="load">刷新数据</el-button><el-button class="verify" :icon="'Coin'" @click="openVerify">积分核对</el-button><el-button class="export" :icon="'Download'" :loading="exporting" @click="exportData">导出当前数据</el-button></div>
    </section>

    <section class="metrics">
      <article><el-icon class="red"><User /></el-icon><div><span>参与人员</span><strong>{{ number(state.total) }}</strong><small>全部成员</small></div></article>
      <article><el-icon class="gold"><Coin /></el-icon><div><span>累计总积分</span><strong>{{ number(state.total_points) }}</strong><small>人均 {{ number(averagePoints) }} 分</small></div></article>
      <article><el-icon class="red"><Position /></el-icon><div><span>累计总步数</span><strong>{{ number(state.total_steps) }}</strong><small>人均 {{ number(averageSteps) }} 步</small></div></article>
      <article><el-icon class="blue"><TrendCharts /></el-icon><div><span>平均路线进度</span><strong>{{ state.avg_progress }}%</strong><small>共 {{ state.route_nodes.length }} 个节点</small></div></article>
      <article><el-icon class="green"><CircleCheck /></el-icon><div><span>完成全程</span><strong>{{ state.completed_users }}</strong><small>抵达全部节点</small></div></article>
    </section>

    <section v-if="state.podium.length" class="panel honors">
      <header><div><label>TOP 10 HONOR ROLL</label><h2>领跑者荣誉榜</h2></div><em>总积分实时排名 · 不受筛选影响</em></header>
      <div class="podium">
        <article v-for="person in podiumTop" :key="person.user_id" :class="['place', MEDAL[person.rank - 1], { champion: person.rank === 1 }]">
          <span class="crest"><el-icon><Trophy v-if="person.rank === 1" /><Medal v-else /></el-icon>{{ person.rank }}</span>
          <el-avatar :size="person.rank === 1 ? 68 : 56" :src="person.avatar">{{ initial(person.nickname) }}</el-avatar>
          <h3>{{ person.nickname }}</h3><p>{{ person.org_name || '未分配组织' }}</p>
          <strong>{{ number(person.total_points) }} <small>积分</small></strong>
          <div class="split">步行 {{ number(person.walk_points) }} · 答题 {{ number(person.quiz_points) }} · {{ number(person.total_steps) }} 步</div>
        </article>
      </div>
      <div v-if="eliteCards.length" class="elite">
        <article v-for="person in eliteCards" :key="person.user_id">
          <b>{{ String(person.rank).padStart(2, '0') }}</b>
          <el-avatar :size="36" :src="person.avatar">{{ initial(person.nickname) }}</el-avatar>
          <div><strong>{{ person.nickname }}</strong><span>{{ person.org_name || '未分配组织' }}</span></div>
          <em>{{ number(person.total_points) }}<small> 分</small></em>
        </article>
      </div>
    </section>

    <section class="panel">
      <header><div><label>FULL RANKING</label><h2>全员排名明细</h2></div><div class="filters"><el-input v-model="keyword" clearable :prefix-icon="'Search'" placeholder="搜索姓名或人员 ID" /><el-select v-model="orgId" clearable filterable placeholder="全部组织" @clear="orgId = null"><el-option v-for="option in state.org_options" :key="option.id" :label="option.name" :value="option.id" /></el-select><el-checkbox v-model="onlyChanged">只看已改名</el-checkbox></div></header>
      <el-table :data="state.items" row-key="user_id" class="rank-table" empty-text="暂无人员数据" @row-click="openOverview">
        <el-table-column type="expand" width="48"><template #default="{ row }"><div class="journey"><div class="journey-head"><div><strong>{{ row.nickname }}的节点轨迹</strong><span>已抵达 {{ row.completed_nodes }} / {{ row.node_count }} 个节点</span></div><el-progress :percentage="progress(row)" :stroke-width="8" :show-text="false" /></div><div class="track"><div v-for="(node, index) in row.nodes" :key="node.id" class="node" :class="{ reached: node.reached }"><i v-if="index < row.nodes.length - 1" /><b><el-icon v-if="node.reached"><Check /></el-icon><span v-else>{{ node.id }}</span></b><strong>{{ node.name }}</strong><span>{{ number(node.target_steps) }} 步</span><time>{{ time(node.reached_at) }}</time></div></div></div></template></el-table-column>
        <el-table-column label="排名" width="80" align="center"><template #default="{ row }"><b class="rank" :class="MEDAL[row.rank - 1]">{{ String(row.rank).padStart(2, '0') }}</b></template></el-table-column>
        <el-table-column label="人员" min-width="210"><template #default="{ row }"><div class="person"><el-avatar :size="38" :src="row.avatar">{{ initial(row.nickname) }}</el-avatar><div class="person-meta"><div class="person-name"><strong>{{ row.nickname }}</strong><el-tooltip v-if="row.nickname_changed_at" :content="`曾用名：${row.original_nickname || '—'}（${time(row.nickname_changed_at)} 修改）`" placement="top"><el-tag size="small" class="renamed-tag">改名</el-tag></el-tooltip></div><span>ID {{ row.user_id }}</span></div></div></template></el-table-column>
        <el-table-column label="所属组织" min-width="210"><template #default="{ row }">{{ row.org_name || '未分配组织' }}</template></el-table-column>
        <el-table-column label="总积分" width="170" align="right"><template #default="{ row }"><strong class="points">{{ number(row.total_points) }}</strong><small> 分</small><div class="point-split">步行 {{ number(row.walk_points) }} · 答题 {{ number(row.quiz_points) }}</div></template></el-table-column>
        <el-table-column label="累计步数" width="140" align="right"><template #default="{ row }"><strong class="steps">{{ number(row.total_steps) }}</strong><small> 步</small></template></el-table-column>
        <el-table-column label="路线进度" min-width="190"><template #default="{ row }"><div class="progress"><el-progress :percentage="progress(row)" :stroke-width="7" /><span>{{ row.completed_nodes }}/{{ row.node_count }} 节点</span></div></template></el-table-column>
        <el-table-column label="最近抵达" width="180"><template #default="{ row }"><span :class="{ muted: !row.last_reached_at }">{{ time(row.last_reached_at) }}</span></template></el-table-column>
      </el-table>
      <footer><el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="state.match_total" :page-sizes="[20, 50, 100, 200]" layout="total, sizes, prev, pager, next" background /><span class="hint">点击人员行查看完整档案</span></footer>
    </section>

    <el-drawer v-model="overviewVisible" :title="overview ? `${overview.user.nickname}的完整档案` : `${overviewName}的完整档案`" size="560px">
      <div class="overview" v-loading="overviewLoading">
        <template v-if="overview">
          <section class="ov-head">
            <el-avatar :size="56" :src="overview.user.avatar">{{ initial(overview.user.nickname) }}</el-avatar>
            <div><strong>{{ overview.user.nickname }}</strong><span>ID {{ overview.user.user_id }} · {{ overview.user.org_name || '未分配组织' }}</span><span v-if="overview.user.nickname_changed_at" class="ov-renamed">曾用名 {{ overview.user.original_nickname || '—' }} · {{ time(overview.user.nickname_changed_at) }} 修改（每人仅一次）</span></div>
          </section>

          <section class="ov-block">
            <h3>运动记录</h3>
            <div class="ov-kpis"><div><strong>{{ number(overview.sport.today_steps) }}</strong><span>今日步数</span></div><div><strong>{{ number(overview.sport.total_steps) }}</strong><span>累计步数</span></div></div>
            <div v-if="overview.sport.recent.length" class="ov-list"><div v-for="day in overview.sport.recent" :key="day.date" class="ov-row"><span>{{ day.date }}</span><em>{{ number(day.steps) }} 步</em></div></div>
            <p v-else class="ov-empty">暂无运动记录</p>
          </section>

          <section class="ov-block">
            <h3>答题记录</h3>
            <div v-if="overview.quiz_records.length" class="ov-list"><div v-for="rec in overview.quiz_records" :key="rec.date" class="ov-row"><span>{{ rec.date }}</span><em>{{ rec.correct_count }}/{{ rec.total_count }} 答对 · {{ rec.score }} 分 · +{{ rec.points }} 积分</em></div></div>
            <p v-else class="ov-empty">暂无答题记录</p>
          </section>

          <section class="ov-block">
            <h3>勋章墙</h3>
            <div v-if="overview.medals.length" class="ov-medals"><div v-for="medal in overview.medals" :key="medal.id" class="ov-medal"><span class="ov-medal-icon">{{ medal.icon }}</span><div><strong>{{ medal.name }}</strong><span>{{ medal.desc }}</span></div><time>{{ time(medal.granted_at) }}</time></div></div>
            <p v-else class="ov-empty">暂未获得勋章</p>
          </section>

          <section class="ov-block">
            <h3>长征记录</h3>
            <p class="ov-sub">已抵达 {{ overview.march.completed_nodes }} / {{ overview.march.node_count }} 个节点</p>
            <div class="ov-nodes"><div v-for="node in overview.march.nodes" :key="node.id" class="ov-node" :class="{ reached: node.reached }"><b>{{ node.id }}</b><span>{{ node.name }}</span><time>{{ time(node.reached_at) }}</time></div></div>
          </section>

          <section class="ov-block">
            <h3>积分明细</h3>
            <div class="ov-kpis"><div><strong>{{ number(overview.points.total) }}</strong><span>总积分</span></div><div><strong>{{ number(overview.points.walk) }}</strong><span>步行积分</span></div><div><strong>{{ number(overview.points.quiz) }}</strong><span>答题积分</span></div><div><strong>{{ overview.points.rank ? `#${overview.points.rank}` : '—' }}</strong><span>全员排名</span></div></div>
            <div v-if="overview.points.logs.length" class="ov-list"><div v-for="(log, index) in overview.points.logs" :key="index" class="ov-row"><span>{{ log.date }}</span><el-tag size="small" effect="plain" :type="log.source_type === 'quiz' ? 'warning' : log.source_type === 'walk' ? 'danger' : 'info'">{{ SOURCE_TEXT[log.source_type] || log.source_type }}</el-tag><em>{{ log.reason }}</em><b :class="log.delta >= 0 ? 'plus' : 'minus'">{{ log.delta >= 0 ? '+' : '' }}{{ log.delta }}</b></div></div>
            <p v-else class="ov-empty">暂无积分记录</p>
          </section>
        </template>
      </div>
    </el-drawer>

    <el-dialog v-model="verifyVisible" title="积分台账核对" width="560px" :close-on-click-modal="!verifying">
      <p class="verify-tip">按源数据（每日步数、答题明细）重算每人每日应得积分，与台账逐条比对；核对为只读操作，确认后方可修复。</p>
      <div v-loading="verifying" class="verify-body">
        <template v-if="verifyResult">
          <div class="ov-kpis"><div><strong>{{ number(verifyResult.users) }}</strong><span>核对人数</span></div><div><strong>{{ number(verifyResult.checked_days) }}</strong><span>核对人日</span></div><div><strong :class="{ ok: !verifyResult.mismatches }">{{ number(verifyResult.mismatches) }}</strong><span>不一致</span></div><div><strong>{{ number(verifyResult.fixed) }}</strong><span>已修复</span></div></div>
          <el-alert v-if="!verifyResult.mismatches" type="success" :closable="false" show-icon :title="verifyFixed ? '修复完成，积分台账与源数据一致' : '积分台账与源数据完全一致'" />
          <el-table v-else :data="verifyResult.samples" size="small" border max-height="260">
            <el-table-column prop="user_id" label="人员 ID" width="90" align="center" />
            <el-table-column prop="biz_key" label="台账键" min-width="150" />
            <el-table-column prop="expected" label="应得" width="80" align="right" />
            <el-table-column prop="actual" label="台账" width="80" align="right" />
          </el-table>
        </template>
      </div>
      <template #footer>
        <el-button :disabled="verifying" @click="runVerify(false)">重新核对</el-button>
        <el-button type="danger" :loading="verifying" :disabled="!verifyResult || !verifyResult.mismatches || verifyFixed" @click="runVerify(true)">修复不一致</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<style scoped>
.rank-page{min-width:960px;color:#172033}.hero{position:relative;min-height:190px;padding:34px 38px;display:flex;align-items:center;justify-content:space-between;overflow:hidden;border-radius:20px;color:#fff;background:radial-gradient(circle at 75% 20%,rgb(248 212 119/24%),transparent 28%),linear-gradient(120deg,#7d0b20,#b31230 48%,#1d2638 115%);box-shadow:0 22px 55px rgb(125 11 32/20%)}.hero:after{content:"";position:absolute;inset:0;opacity:.12;background-image:linear-gradient(rgb(255 255 255/25%) 1px,transparent 1px),linear-gradient(90deg,rgb(255 255 255/25%) 1px,transparent 1px);background-size:34px 34px}.hero>div{position:relative;z-index:1}.hero label,header label{color:#f8d477;font-size:11px;font-weight:800;letter-spacing:2px}.hero label{display:flex;align-items:center;gap:9px}.hero label i{width:7px;height:7px;border-radius:50%;background:#f8d477;box-shadow:0 0 0 6px rgb(248 212 119/14%)}h1{margin:18px 0 8px;font-size:34px;letter-spacing:3px}.hero p{margin:0;color:rgb(255 255 255/72%)}.actions{flex:none;display:flex;align-items:center;gap:12px}.ws-status{display:flex;white-space:nowrap;align-items:center;gap:7px;margin-right:4px;color:rgb(255 255 255/72%);font-size:12px}.ws-status i{width:8px;height:8px;border-radius:50%;background:#8b94a3;box-shadow:0 0 0 4px rgb(139 148 163/20%)}.ws-status.online i{background:#3ed97a;box-shadow:0 0 0 4px rgb(62 217 122/18%)}.ws-status.connecting i{background:#f8d477;box-shadow:0 0 0 4px rgb(248 212 119/18%)}.ws-status.offline i{background:#ff8a8a;box-shadow:0 0 0 4px rgb(255 138 138/18%)}.actions :deep(.el-button){height:42px;padding:0 20px;border-radius:12px}.actions :deep(.el-button:first-child){color:#fff;border-color:rgb(255 255 255/28%);background:rgb(255 255 255/8%)}.export{color:#5b3900;border:0;background:linear-gradient(135deg,#ffe9a9,#e9b94c)}.actions :deep(.verify){color:#fff;border-color:rgb(248 212 119/45%);background:rgb(248 212 119/14%)}
.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:16px;margin:18px 0}.metrics article{padding:20px;display:flex;align-items:center;gap:16px;border:1px solid #e8ecf2;border-radius:16px;background:#fff;box-shadow:0 8px 24px rgb(15 23 42/5%)}.metrics .el-icon{width:46px;height:46px;flex:none;border-radius:14px;font-size:21px}.red{color:#b31230;background:#fff0f3}.gold{color:#a87512;background:#fff8e5}.blue{color:#2765ad;background:#edf5ff}.green{color:#23835b;background:#eafaf3}.metrics span,.metrics small{display:block;color:#8a93a3;font-size:12px}.metrics strong{display:block;margin:3px 0;font-size:24px}
.panel{padding:24px;border:1px solid #e8ecf2;border-radius:18px;background:#fff;box-shadow:0 10px 35px rgb(15 23 42/5%)}.honors{margin-bottom:18px;background:linear-gradient(145deg,#fff 40%,#fffcf5)}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px}header label{color:#b31230}header h2{margin:4px 0 0;font-size:19px}header em{padding:8px 12px;border-radius:20px;color:#9a6b0c;font-size:12px;font-style:normal;background:#fff7df}.podium{min-height:180px;display:flex;align-items:flex-end;justify-content:center;gap:16px}.podium article{position:relative;width:220px;min-height:150px;padding:20px;text-align:center;border:1px solid #e8ecf2;border-radius:16px}.podium article:first-child{order:2}.podium article:nth-child(2){order:1}.podium article:nth-child(3){order:3}.podium .champion{min-height:174px;padding-top:28px;border-color:#f0cf79;background:linear-gradient(155deg,#fffdf7,#fff4d5);box-shadow:0 16px 36px rgb(184 132 19/14%)}.podium article>b{position:absolute;top:12px;right:14px;color:#b7bfcb;font-size:22px}.podium h3{margin:9px 0 3px}.podium p{margin:0 0 10px;color:#8992a1;font-size:12px}.podium article>strong{color:#a20f2a;font-size:18px}.podium small{font-size:11px}
.filters{display:flex;gap:10px}.filters :deep(.el-input){width:220px}.filters :deep(.el-select){width:180px}.rank-table{--el-table-header-bg-color:#f7f8fb;--el-table-row-hover-bg-color:#fff9ee;border-top:1px solid #edf0f4}.rank-table :deep(th.el-table__cell){height:48px;color:#70798a;font-size:12px}.rank-table :deep(td.el-table__cell){padding:13px 0}.rank{color:#9a6b0c}.person{display:flex;align-items:center;gap:11px}.person-meta{min-width:0}.person-name{display:flex;align-items:center;gap:6px}.person strong,.person span{display:block}.person span{margin-top:3px;color:#a0a7b3;font-size:11px}.person :deep(.el-avatar){color:#8d1026;background:#f9e5e9}.renamed-tag{flex:none;height:20px;padding:0 6px;border-color:#e8cf8e;color:#9a6b0c;background:#fff8e1}.steps{font-size:16px}.rank-table small,.muted{color:#a0a7b3;font-size:12px}.progress{display:flex;align-items:center;gap:10px}.progress :deep(.el-progress){width:110px}.progress :deep(.el-progress-bar__inner){background:linear-gradient(90deg,#b31230,#e0aa35)}.progress span{color:#8c95a4;font-size:11px}
.journey{margin:4px 20px 14px 48px;padding:20px;border:1px solid #ece5d7;border-radius:14px;background:linear-gradient(135deg,#fffdf9,#f8f9fb)}.journey-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.journey-head strong,.journey-head span{display:block}.journey-head span{margin-top:4px;color:#8d96a4;font-size:12px}.journey-head :deep(.el-progress){width:220px}.track{display:grid;grid-template-columns:repeat(10,1fr);gap:8px}.node{position:relative;min-width:0;text-align:center;color:#a1a8b4}.node>b{position:relative;z-index:2;width:28px;height:28px;margin:0 auto 9px;display:grid;place-items:center;border:2px solid #d7dce4;border-radius:50%;font-size:10px;background:#fff}.node.reached>b{color:#fff;border-color:#bd1734;background:#bd1734;box-shadow:0 0 0 5px rgb(189 23 52/9%)}.node>i{position:absolute;top:13px;left:50%;width:calc(100% + 8px);height:2px;background:#dfe3e9}.node.reached>i{background:linear-gradient(90deg,#bd1734,#e5c46b)}.node>strong,.node>span,.node time{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.node>strong{color:#4b5668;font-size:11px}.node>span{margin-top:3px;font-size:10px}.node time{margin-top:6px;font-size:9px}footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:18px;color:#8b94a3;font-size:12px}.hint{flex:none}@media(max-width:1280px){.metrics{grid-template-columns:repeat(6,1fr)}.metrics article{grid-column:span 2}.metrics article:nth-child(n+4){grid-column:span 3}}
.overview{min-height:300px}.ov-head{display:flex;align-items:center;gap:14px;margin-bottom:18px;padding:18px;border-radius:14px;background:linear-gradient(120deg,#fdf2f4,#fff7e6)}.ov-head :deep(.el-avatar){color:#8d1026;background:#fff}.ov-head strong,.ov-head span{display:block}.ov-head strong{font-size:17px}.ov-head span{margin-top:5px;color:#8b94a3;font-size:12px}.ov-renamed{color:#a87512}.ov-block{margin-bottom:20px;padding:16px 18px;border:1px solid #edf0f4;border-radius:14px}.ov-block h3{margin:0 0 12px;padding-left:10px;border-left:3px solid #bd1734;font-size:14px}.ov-kpis{display:flex;gap:12px;margin-bottom:12px}.ov-kpis div{flex:1;padding:12px 14px;border-radius:10px;background:#f7f8fb;text-align:center}.ov-kpis strong,.ov-kpis span{display:block}.ov-kpis strong{color:#a20f2a;font-size:20px}.ov-kpis span{margin-top:3px;color:#8b94a3;font-size:11px}.ov-list{max-height:220px;overflow:auto}.ov-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 2px;border-bottom:1px dashed #eef1f5;font-size:12px}.ov-row:last-child{border-bottom:0}.ov-row span{flex:none;color:#8b94a3}.ov-row em{flex:1;text-align:right;font-style:normal;color:#4b5668;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ov-row b{flex:none;width:52px;text-align:right;font-weight:700}.ov-row .plus{color:#23835b}.ov-row .minus{color:#c0392b}.ov-empty{padding:14px 0;color:#a9b0bc;font-size:12px;text-align:center}.ov-sub{margin:0 0 10px;color:#8b94a3;font-size:12px}.ov-total{color:#a20f2a;font-size:16px}.ov-medals{display:grid;grid-template-columns:1fr 1fr;gap:10px}.ov-medal{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid #f0e3c8;border-radius:10px;background:#fffdf6}.ov-medal-icon{flex:none;width:40px;height:40px;display:grid;place-items:center;border-radius:50%;font-size:20px;background:#fff4d5}.ov-medal div{min-width:0}.ov-medal strong,.ov-medal span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ov-medal strong{font-size:12px}.ov-medal span{margin-top:2px;color:#a0a7b3;font-size:10px}.ov-medal time{flex:none;color:#c2a14d;font-size:10px}.ov-nodes{display:flex;flex-wrap:wrap;gap:8px}.ov-node{display:flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid #e6eaf0;border-radius:20px;font-size:11px;color:#8b94a3}.ov-node b{width:20px;height:20px;display:grid;place-items:center;border-radius:50%;color:#6d7683;background:#eef1f5;font-size:10px}.ov-node time{color:#b4bac4}.ov-node.reached{border-color:#eecfd4;background:#fff8f8;color:#4b5668}.ov-node.reached b{color:#fff;background:#bd1734}
.podium .place{transition:transform .25s ease,box-shadow .25s ease}.podium .place:hover{transform:translateY(-4px)}
.crest{position:absolute;top:12px;right:14px;display:flex;align-items:center;gap:3px;font-size:18px;font-weight:800}
.podium .gold{border-color:#f0cf79;background:linear-gradient(155deg,#fffdf7,#fff1c9);box-shadow:0 16px 36px rgb(184 132 19/16%)}.podium .gold .crest{color:#c99a2e}.podium .gold :deep(.el-avatar){box-shadow:0 0 0 3px #f0cf79}
.podium .silver{border-color:#cfd6e0;background:linear-gradient(155deg,#fff,#eef2f7)}.podium .silver .crest{color:#8a97a8}.podium .silver :deep(.el-avatar){box-shadow:0 0 0 3px #cfd6e0}
.podium .bronze{border-color:#e6c2a3;background:linear-gradient(155deg,#fff,#fbeee3)}.podium .bronze .crest{color:#b0703f}.podium .bronze :deep(.el-avatar){box-shadow:0 0 0 3px #e6c2a3}
.podium .split{margin-top:6px;color:#8b94a3;font-size:11px}
.elite{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;margin-top:20px;padding-top:20px;border-top:1px dashed #efe4cc}
.elite article{display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid #edf0f4;border-radius:12px;background:#fff}
.elite b{width:30px;color:#9a6b0c;font-size:16px}.elite :deep(.el-avatar){flex:none;color:#8d1026;background:#f9e5e9}
.elite div{flex:1;min-width:0}.elite strong,.elite span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.elite strong{font-size:13px}.elite span{margin-top:2px;color:#a0a7b3;font-size:11px}
.elite em{flex:none;color:#a20f2a;font-size:15px;font-style:normal;font-weight:700}.elite small{color:#a0a7b3;font-size:11px;font-weight:400}
.rank.gold{color:#c99a2e}.rank.silver{color:#8a97a8}.rank.bronze{color:#b0703f}
.points{color:#a20f2a;font-size:16px}.point-split{margin-top:3px;color:#a0a7b3;font-size:11px}
.ov-row :deep(.el-tag){flex:none}
.verify-tip{margin:0 0 14px;color:#8b94a3;font-size:12px;line-height:1.6}.verify-body{min-height:120px}.verify-body .ov-kpis strong.ok{color:#23835b}.verify-body :deep(.el-alert){margin-top:4px}
@media (prefers-reduced-motion:reduce){.podium .place{transition:none}.podium .place:hover{transform:none}}
</style>
