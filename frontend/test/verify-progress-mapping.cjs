/**
 * 星空/实景行军进度换算口径校验（纯函数，Node 直跑，不依赖开发者工具与后端）。
 *
 * 背景：星空红线终点原按「全程步数比例 × 采样点下标」定位，而采样点是每段等分的、
 * 各节点达标步数跨度不等（前 5 段各 5000 步、后 4 段各 10000 步），导致节点已点亮
 * 但红线仍停在其之前。本脚本锁定修复后的口径：
 *   R-01 步数正好达到某节点阈值时，红线终点落在该节点坐标上（逐节点验证）
 *   R-02 用户报障场景（46000 步 / 已过草地）红线终点在过草地之后，且旧口径在其之前
 *   R-03 进度换算全程单调不减、值域 [0,1]
 *   R-04 步数回落时红线不退回最远已点亮节点之前（点亮永久保留）
 *   R-05 缺 targetSteps 刻度时退化为采样点等分（旧口径），不报错
 *   R-06 实景已完成折线（buildMapData 同款 locateSegment）与星空落在同一段、同比例
 *
 *   node frontend/test/verify-progress-mapping.cjs
 */
const routeCanvas = require('../utils/routeCanvas');
const starMap = require('../utils/starMap');

// 与 backend/app/data/seed.py 一致的节点阈值与经纬度（累计步数达标即点亮）
const NODES = [
  { id: 1, name: '瑞金', targetSteps: 0, latitude: 25.885, longitude: 116.027 },
  { id: 2, name: '遵义', targetSteps: 5000, latitude: 27.72, longitude: 106.93 },
  { id: 3, name: '四渡赤水', targetSteps: 10000, latitude: 28.3, longitude: 106.42 },
  { id: 4, name: '巧渡金沙江', targetSteps: 15000, latitude: 26.28, longitude: 102.47 },
  { id: 5, name: '强渡大渡河', targetSteps: 20000, latitude: 29.25, longitude: 102.3 },
  { id: 6, name: '飞夺泸定桥', targetSteps: 25000, latitude: 29.92, longitude: 102.23 },
  { id: 7, name: '翻越雪山', targetSteps: 35000, latitude: 35.62, longitude: 103.62 },
  { id: 8, name: '过草地', targetSteps: 45000, latitude: 33.58, longitude: 102.96 },
  { id: 9, name: '吴起镇', targetSteps: 55000, latitude: 36.93, longitude: 107.99 },
  { id: 10, name: '延安', targetSteps: 65000, latitude: 36.59, longitude: 109.49 }
];
const TOTAL = NODES[NODES.length - 1].targetSteps;
const CW = 375;
const CH = 600;

const results = [];
function record(id, name, pass, detail) {
  results.push({ id, name, pass: !!pass, detail: String(detail) });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + id + ' ' + name + ' | ' + detail);
}

/** 按后端 _route_state 规则给节点标三态，并构造星空内核实例（只跑几何，不碰画布） */
function makeHud(steps) {
  const nodes = NODES.map((n) =>
    Object.assign({}, n, {
      status: steps >= n.targetSteps ? 'completed' : 'unlocked',
      remain: Math.max(n.targetSteps - steps, 0)
    })
  );
  const hud = starMap.createStarMap({ ctx: {}, cw: CW, ch: CH, dpr: 2 });
  hud.route = { nodes: nodes, currentSteps: steps, totalSteps: TOTAL, routeProgress: steps / TOTAL };
  hud.nodeIndex = {};
  nodes.forEach((n, i) => {
    hud.nodeIndex[n.id] = i;
  });
  hud.buildGeometry();
  return hud;
}

/** 旧口径：步数比例直接乘采样点下标（用于对照取证） */
function legacyEndIdx(hud) {
  return Math.max(1, Math.floor(hud.currentRatio() * (hud.path.length - 1)));
}

/** 现口径红线终点下标：与 drawRoute 完全相同的一步（framePathRatio → endIdxOf） */
function starEndIdx(hud) {
  return hud.endIdxOf(hud.framePathRatio(null));
}

/* ---- R-01 阈值即到达：步数正好等于各节点阈值时，红线终点 == 该节点采样位置 ---- */
{
  const bad = [];
  NODES.forEach((n, i) => {
    if (n.targetSteps === 0) return; // 起点无需推进
    const hud = makeHud(n.targetSteps);
    const endIdx = starEndIdx(hud);
    const p = hud.path[endIdx];
    const node = hud.nodePts[i];
    const dx = Math.abs(p.x - node.x);
    const dy = Math.abs(p.y - node.y);
    if (endIdx !== hud.nodePathIdx[i] || dx > 0.01 || dy > 0.01) {
      bad.push(n.name + ':endIdx=' + endIdx + ' nodeIdx=' + hud.nodePathIdx[i]);
    }
  });
  record('R-01', '步数达阈值时红线终点落在该节点坐标', bad.length === 0, bad.join(', ') || '逐节点(遵义…延安)一致');
}

/* ---- R-02 报障场景：46000 步（过草地已点亮）红线应在过草地之后 ---- */
{
  const hud = makeHud(46000);
  const endIdx = starEndIdx(hud);
  const grassIdx = hud.nodePathIdx[7]; // 过草地
  const oldIdx = legacyEndIdx(hud);
  record(
    'R-02',
    '46000 步时红线已过「过草地」（旧口径在其之前）',
    endIdx >= grassIdx && oldIdx < grassIdx,
    '新 endIdx=' + endIdx + ' ≥ 过草地=' + grassIdx + '；旧 endIdx=' + oldIdx + '（段内比例 ' +
      hud.pathRatio(46000 / TOTAL).toFixed(4) + ' vs 步数比例 ' + (46000 / TOTAL).toFixed(4) + '）'
  );
}

/* ---- R-03 单调不减 + 值域 ---- */
{
  const hud = makeHud(0);
  let prev = -1;
  let bad = '';
  for (let s = 0; s <= TOTAL + 5000; s += 250) {
    const r = hud.pathRatio(Math.min(1, s / TOTAL));
    if (!(r >= 0 && r <= 1)) bad = '越界 steps=' + s + ' r=' + r;
    if (r < prev - 1e-9) bad = bad || '非单调 steps=' + s;
    prev = r;
  }
  record('R-03', '全程换算单调不减且落在 [0,1]', !bad && prev === 1, bad || '终点 r=' + prev + '（步数超程后仍封顶）');
}

/* ---- R-04 步数回落：红线不退回最远已点亮节点之前 ---- */
{
  const hud = makeHud(46000);
  const floor = hud.litFloor;
  // 模拟微信运动回算：步数掉到 20000，但点亮记录仍在（status 仍 completed）
  hud.route.currentSteps = 20000;
  hud.route.routeProgress = 20000 / TOTAL;
  const endIdx = starEndIdx(hud);
  const grassIdx = hud.nodePathIdx[7];
  record(
    'R-04',
    '步数回落到 20000 时红线仍不退到已点亮的过草地之前',
    endIdx >= grassIdx,
    'litFloor=' + floor.toFixed(4) + ' endIdx=' + endIdx + ' 过草地=' + grassIdx
  );
}

/* ---- R-05 缺刻度退化：节点无 targetSteps 时按采样点等分，不抛异常 ---- */
{
  const hud = starMap.createStarMap({ ctx: {}, cw: CW, ch: CH, dpr: 2 });
  const nodes = NODES.map((n) => Object.assign({}, n, { targetSteps: undefined, status: 'unlocked' }));
  hud.route = { nodes: nodes, currentSteps: 32500, totalSteps: TOTAL, routeProgress: 0.5 };
  hud.nodeIndex = {};
  nodes.forEach((n, i) => {
    hud.nodeIndex[n.id] = i;
  });
  hud.buildGeometry();
  const r = hud.pathRatio(hud.currentRatio());
  record(
    'R-05',
    '缺 targetSteps 时退化为采样点等分（旧口径）',
    hud.progressMarks === null && Math.abs(r - 0.5) < 1e-9,
    'progressMarks=' + hud.progressMarks + ' r=' + r
  );
}

/* ---- R-06 实景与星空同口径：同一 (steps) 落在同一段、同段内比例 ---- */
{
  const targets = NODES.map((n) => n.targetSteps);
  const bad = [];
  [3000, 5000, 12000, 27500, 46000, 54999, 65000].forEach((s) => {
    const hud = makeHud(s);
    const loc = routeCanvas.locateSegment(targets, s); // 实景 buildMapData 用的同一函数
    const last = hud.path.length - 1;
    const segEnd = loc.done ? 1 : (hud.nodePathIdx[loc.seg] + (hud.nodePathIdx[loc.seg + 1] - hud.nodePathIdx[loc.seg]) * loc.ratio) / last;
    if (Math.abs(hud.pathRatio(s / TOTAL) - segEnd) > 1e-9) bad.push('steps=' + s);
  });
  record('R-06', '实景折线与星空红线共用 locateSegment，段与段内比例一致', bad.length === 0, bad.join(',') || '7 个采样步数一致');
}

const failed = results.filter((r) => !r.pass);
console.log('\n== 共 ' + results.length + ' 项，失败 ' + failed.length + ' ==');
process.exit(failed.length ? 1 : 0);
