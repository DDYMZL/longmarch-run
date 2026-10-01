<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import request from '../api/request'

interface RankNode { id: number; name: string; target_steps: number; reached: boolean; reached_at: string | null }
interface RankItem { rank: number; user_id: number; nickname: string; avatar: string; org_name: string; total_steps: number; completed_nodes: number; node_count: number; last_reached_at: string | null; nodes: RankNode[] }
interface RankResult { total: number; total_steps: number; completed_users: number; route_nodes: RankNode[]; items: RankItem[] }

const loading = ref(false)
const keyword = ref('')
const org = ref('')
const state = ref<RankResult>({ total: 0, total_steps: 0, completed_users: 0, route_nodes: [], items: [] })
const organizations = computed(() => [...new Set(state.value.items.map((item) => item.org_name).filter(Boolean))].sort())
const items = computed(() => {
  const word = keyword.value.trim().toLowerCase()
  return state.value.items.filter((item) => (!word || item.nickname.toLowerCase().includes(word) || String(item.user_id).includes(word)) && (!org.value || item.org_name === org.value))
})
const podium = computed(() => state.value.items.slice(0, 3))
const averageSteps = computed(() => state.value.total ? Math.round(state.value.total_steps / state.value.total) : 0)
const averageProgress = computed(() => state.value.items.length ? Math.round(state.value.items.reduce((sum, item) => sum + progress(item), 0) / state.value.items.length) : 0)

async function load() {
  loading.value = true
  try { state.value = (await request.get<RankResult>('/admin/rankings')).data } finally { loading.value = false }
}
function number(value: number) { return new Intl.NumberFormat('zh-CN').format(value) }
function progress(item: RankItem) { return item.node_count ? Math.round(item.completed_nodes / item.node_count * 100) : 0 }
function initial(name: string) { return name.trim().slice(0, 1) || '员' }
function time(value: string | null) {
  if (!value) return '尚未到达'
  const source = /Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(source))
}
function csvCell(value: unknown) {
  let text = value == null ? '' : String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}
function exportData() {
  if (!items.value.length) return ElMessage.warning('当前没有可导出的排名数据')
  const header = ['排名', '人员ID', '姓名', '所属组织', '累计步数', '到达节点数', ...state.value.route_nodes.map((node) => `${node.name}到达时间`)]
  const rows = items.value.map((item) => [item.rank, item.user_id, item.nickname, item.org_name || '未分配组织', item.total_steps, item.completed_nodes, ...item.nodes.map((node) => time(node.reached_at))])
  const content = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\ufeff${content}`], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `全员长征排名_${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
  ElMessage.success(`已导出 ${items.value.length} 人的完整数据`)
}
onMounted(load)
</script>

<template>
  <main class="rank-page" v-loading="loading">
    <section class="hero">
      <div><label><i /> LONG MARCH COMMAND CENTER</label><h1>全员征程排名</h1><p>实时洞察全体人员累计步数与路线节点抵达进度</p></div>
      <div class="actions"><el-button :icon="'Refresh'" :loading="loading" @click="load">刷新数据</el-button><el-button class="export" :icon="'Download'" @click="exportData">导出当前数据</el-button></div>
    </section>

    <section class="metrics">
      <article><el-icon class="red"><User /></el-icon><div><span>参与人员</span><strong>{{ number(state.total) }}</strong><small>全部成员</small></div></article>
      <article><el-icon class="gold"><Position /></el-icon><div><span>累计总步数</span><strong>{{ number(state.total_steps) }}</strong><small>人均 {{ number(averageSteps) }} 步</small></div></article>
      <article><el-icon class="blue"><TrendCharts /></el-icon><div><span>平均路线进度</span><strong>{{ averageProgress }}%</strong><small>共 {{ state.route_nodes.length }} 个节点</small></div></article>
      <article><el-icon class="green"><CircleCheck /></el-icon><div><span>完成全程</span><strong>{{ state.completed_users }}</strong><small>抵达全部节点</small></div></article>
    </section>

    <section v-if="podium.length" class="panel honors">
      <header><div><label>TOP PERFORMERS</label><h2>领跑者荣誉榜</h2></div><em>累计步数实时排名</em></header>
      <div class="podium">
        <article v-for="person in podium" :key="person.user_id" :class="{ champion: person.rank === 1 }">
          <b>{{ String(person.rank).padStart(2, '0') }}</b><el-avatar :size="person.rank === 1 ? 66 : 54" :src="person.avatar">{{ initial(person.nickname) }}</el-avatar>
          <h3>{{ person.nickname }}</h3><p>{{ person.org_name || '未分配组织' }}</p><strong>{{ number(person.total_steps) }} <small>步</small></strong>
        </article>
      </div>
    </section>

    <section class="panel">
      <header><div><label>FULL RANKING</label><h2>全员排名明细</h2></div><div class="filters"><el-input v-model="keyword" clearable :prefix-icon="'Search'" placeholder="搜索姓名或人员 ID" /><el-select v-model="org" clearable placeholder="全部组织"><el-option v-for="name in organizations" :key="name" :label="name" :value="name" /></el-select></div></header>
      <el-table :data="items" row-key="user_id" class="rank-table" empty-text="暂无人员数据">
        <el-table-column type="expand" width="48"><template #default="{ row }"><div class="journey"><div class="journey-head"><div><strong>{{ row.nickname }}的节点轨迹</strong><span>已抵达 {{ row.completed_nodes }} / {{ row.node_count }} 个节点</span></div><el-progress :percentage="progress(row)" :stroke-width="8" :show-text="false" /></div><div class="track"><div v-for="(node, index) in row.nodes" :key="node.id" class="node" :class="{ reached: node.reached }"><i v-if="index < row.nodes.length - 1" /><b><el-icon v-if="node.reached"><Check /></el-icon><span v-else>{{ node.id }}</span></b><strong>{{ node.name }}</strong><span>{{ number(node.target_steps) }} 步</span><time>{{ time(node.reached_at) }}</time></div></div></div></template></el-table-column>
        <el-table-column label="排名" width="80" align="center"><template #default="{ row }"><b class="rank">{{ String(row.rank).padStart(2, '0') }}</b></template></el-table-column>
        <el-table-column label="人员" min-width="190"><template #default="{ row }"><div class="person"><el-avatar :size="38" :src="row.avatar">{{ initial(row.nickname) }}</el-avatar><div><strong>{{ row.nickname }}</strong><span>ID {{ row.user_id }}</span></div></div></template></el-table-column>
        <el-table-column label="所属组织" min-width="210"><template #default="{ row }">{{ row.org_name || '未分配组织' }}</template></el-table-column>
        <el-table-column label="累计步数" width="150" align="right"><template #default="{ row }"><strong class="steps">{{ number(row.total_steps) }}</strong><small> 步</small></template></el-table-column>
        <el-table-column label="路线进度" min-width="190"><template #default="{ row }"><div class="progress"><el-progress :percentage="progress(row)" :stroke-width="7" /><span>{{ row.completed_nodes }}/{{ row.node_count }} 节点</span></div></template></el-table-column>
        <el-table-column label="最近抵达" width="180"><template #default="{ row }"><span :class="{ muted: !row.last_reached_at }">{{ time(row.last_reached_at) }}</span></template></el-table-column>
      </el-table>
      <footer>当前展示 {{ items.length }} / {{ state.total }} 人</footer>
    </section>
  </main>
</template>

<style scoped>
.rank-page{min-width:960px;color:#172033}.hero{position:relative;min-height:190px;padding:34px 38px;display:flex;align-items:center;justify-content:space-between;overflow:hidden;border-radius:20px;color:#fff;background:radial-gradient(circle at 75% 20%,rgb(248 212 119/24%),transparent 28%),linear-gradient(120deg,#7d0b20,#b31230 48%,#1d2638 115%);box-shadow:0 22px 55px rgb(125 11 32/20%)}.hero:after{content:"";position:absolute;inset:0;opacity:.12;background-image:linear-gradient(rgb(255 255 255/25%) 1px,transparent 1px),linear-gradient(90deg,rgb(255 255 255/25%) 1px,transparent 1px);background-size:34px 34px}.hero>div{position:relative;z-index:1}.hero label,header label{color:#f8d477;font-size:11px;font-weight:800;letter-spacing:2px}.hero label{display:flex;align-items:center;gap:9px}.hero label i{width:7px;height:7px;border-radius:50%;background:#f8d477;box-shadow:0 0 0 6px rgb(248 212 119/14%)}h1{margin:18px 0 8px;font-size:34px;letter-spacing:3px}.hero p{margin:0;color:rgb(255 255 255/72%)}.actions{display:flex;gap:12px}.actions :deep(.el-button){height:42px;padding:0 20px;border-radius:12px}.actions :deep(.el-button:first-child){color:#fff;border-color:rgb(255 255 255/28%);background:rgb(255 255 255/8%)}.export{color:#5b3900;border:0;background:linear-gradient(135deg,#ffe9a9,#e9b94c)}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:18px 0}.metrics article{padding:20px;display:flex;align-items:center;gap:16px;border:1px solid #e8ecf2;border-radius:16px;background:#fff;box-shadow:0 8px 24px rgb(15 23 42/5%)}.metrics .el-icon{width:46px;height:46px;flex:none;border-radius:14px;font-size:21px}.red{color:#b31230;background:#fff0f3}.gold{color:#a87512;background:#fff8e5}.blue{color:#2765ad;background:#edf5ff}.green{color:#23835b;background:#eafaf3}.metrics span,.metrics small{display:block;color:#8a93a3;font-size:12px}.metrics strong{display:block;margin:3px 0;font-size:24px}
.panel{padding:24px;border:1px solid #e8ecf2;border-radius:18px;background:#fff;box-shadow:0 10px 35px rgb(15 23 42/5%)}.honors{margin-bottom:18px;background:linear-gradient(145deg,#fff 40%,#fffcf5)}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px}header label{color:#b31230}header h2{margin:4px 0 0;font-size:19px}header em{padding:8px 12px;border-radius:20px;color:#9a6b0c;font-size:12px;font-style:normal;background:#fff7df}.podium{min-height:180px;display:flex;align-items:flex-end;justify-content:center;gap:16px}.podium article{position:relative;width:220px;min-height:150px;padding:20px;text-align:center;border:1px solid #e8ecf2;border-radius:16px}.podium article:first-child{order:2}.podium article:nth-child(2){order:1}.podium article:nth-child(3){order:3}.podium .champion{min-height:174px;padding-top:28px;border-color:#f0cf79;background:linear-gradient(155deg,#fffdf7,#fff4d5);box-shadow:0 16px 36px rgb(184 132 19/14%)}.podium article>b{position:absolute;top:12px;right:14px;color:#b7bfcb;font-size:22px}.podium h3{margin:9px 0 3px}.podium p{margin:0 0 10px;color:#8992a1;font-size:12px}.podium article>strong{color:#a20f2a;font-size:18px}.podium small{font-size:11px}
.filters{display:flex;gap:10px}.filters :deep(.el-input){width:220px}.filters :deep(.el-select){width:180px}.rank-table{--el-table-header-bg-color:#f7f8fb;--el-table-row-hover-bg-color:#fff9ee;border-top:1px solid #edf0f4}.rank-table :deep(th.el-table__cell){height:48px;color:#70798a;font-size:12px}.rank-table :deep(td.el-table__cell){padding:13px 0}.rank{color:#9a6b0c}.person{display:flex;align-items:center;gap:11px}.person strong,.person span{display:block}.person span{margin-top:3px;color:#a0a7b3;font-size:11px}.person :deep(.el-avatar){color:#8d1026;background:#f9e5e9}.steps{font-size:16px}.rank-table small,.muted{color:#a0a7b3;font-size:12px}.progress{display:flex;align-items:center;gap:10px}.progress :deep(.el-progress){width:110px}.progress :deep(.el-progress-bar__inner){background:linear-gradient(90deg,#b31230,#e0aa35)}.progress span{color:#8c95a4;font-size:11px}
.journey{margin:4px 20px 14px 48px;padding:20px;border:1px solid #ece5d7;border-radius:14px;background:linear-gradient(135deg,#fffdf9,#f8f9fb)}.journey-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.journey-head strong,.journey-head span{display:block}.journey-head span{margin-top:4px;color:#8d96a4;font-size:12px}.journey-head :deep(.el-progress){width:220px}.track{display:grid;grid-template-columns:repeat(10,1fr);gap:8px}.node{position:relative;min-width:0;text-align:center;color:#a1a8b4}.node>b{position:relative;z-index:2;width:28px;height:28px;margin:0 auto 9px;display:grid;place-items:center;border:2px solid #d7dce4;border-radius:50%;font-size:10px;background:#fff}.node.reached>b{color:#fff;border-color:#bd1734;background:#bd1734;box-shadow:0 0 0 5px rgb(189 23 52/9%)}.node>i{position:absolute;top:13px;left:50%;width:calc(100% + 8px);height:2px;background:#dfe3e9}.node.reached>i{background:linear-gradient(90deg,#bd1734,#e5c46b)}.node>strong,.node>span,.node time{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.node>strong{color:#4b5668;font-size:11px}.node>span{margin-top:3px;font-size:10px}.node time{margin-top:6px;font-size:9px}footer{padding-top:18px;color:#8b94a3;font-size:12px}@media(max-width:1280px){.metrics{grid-template-columns:repeat(2,1fr)}}
</style>
