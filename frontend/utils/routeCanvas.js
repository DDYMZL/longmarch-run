/**
 * 路线 Canvas 共用绘制工具：星空长征（pages/march canvas 模式）、完成仪式（pages/ceremony）
 * 与实景折线（pages/march real 模式）共用。全部为无副作用纯函数；坐标单位为 CSS px（调用方负责 dpr 缩放）。
 */

/** 缓动函数 easeOutCubic */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** 绘制五角星路径 */
function drawStar(ctx, cx, cy, spikes, outerR, innerR, rot) {
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = rot + (i * Math.PI) / spikes - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** 绘制圆角矩形路径 */
function drawRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 将任意路线经纬度归一化到 Canvas 安全绘制区域。
 */
function getCanvasNodePositions(nodes, width, height) {
  if (!nodes.length) return [];
  const latitudes = nodes.map((node) => node.latitude);
  const longitudes = nodes.map((node) => node.longitude);
  const minLat = Math.min.apply(null, latitudes);
  const maxLat = Math.max.apply(null, latitudes);
  const minLng = Math.min.apply(null, longitudes);
  const maxLng = Math.max.apply(null, longitudes);
  const latRange = maxLat - minLat;
  const lngRange = maxLng - minLng;

  return nodes.map((node) => ({
    x: lngRange ? width * (0.12 + ((node.longitude - minLng) / lngRange) * 0.76) : width * 0.5,
    y: latRange ? height * (0.12 + ((maxLat - node.latitude) / latRange) * 0.72) : height * 0.5
  }));
}

/**
 * Catmull-Rom 平滑路径采样。
 * 返回 { path, dist, len, nodePathIndex }：path 采样点列、dist 累计距离、
 * len 全长、nodePathIndex 各节点在 path 上的采样下标（末节点取 path 最后一点下标，
 * 采样点每段含首点故相邻段重复一个点，末节点无下一段可重复，直接钳到 path.length-1）。
 */
function sampleRoutePath(pts, segs) {
  const path = [];
  const n = pts.length;
  if (n === 1) path.push(pts[0]);
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    for (let j = 0; j <= segs; j++) {
      const t = j / segs;
      const t2 = t * t;
      const t3 = t2 * t;
      path.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
      });
    }
  }

  const dist = [0];
  for (let i = 1; i < path.length; i++) {
    dist.push(dist[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  }

  const nodePathIndex = [];
  const lastIdx = Math.max(0, path.length - 1);
  for (let i = 0; i < n; i++) nodePathIndex.push(Math.min(i * (segs + 1), lastIdx));

  return { path, dist, len: dist[dist.length - 1], nodePathIndex };
}

/**
 * 在「按节点累计阈值」定义的路线轴上定位当前值落在哪一段。
 *
 * 各节点的达标阈值跨度不等（如前段 5000 步、后段 10000 步），因此任何「按全程比例」
 * 直接换算位置的写法都会与节点坐标错位；路线上的位置一律经本函数换算，
 * 保证阈值达到即正好落在该节点上（星空红线与实景已完成折线共用同一口径）。
 * @param {number[]} thresholds 各节点累计阈值，按路线顺序非递减（累计步数或其占比均可，须与 value 同口径）
 * @param {number} value 当前值（同口径）
 * @returns {{seg:number, ratio:number, done:boolean}}
 *   seg 正在行进的路段起点节点下标；未达第一个阈值时为 -1
 *   ratio 该路段内的推进比例 0~1（阈值相同导致跨度为 0 时视为直达）
 *   done 是否已达最后一个阈值
 */
function locateSegment(thresholds, value) {
  const n = thresholds.length;
  if (n === 0) return { seg: -1, ratio: 0, done: false };
  const cur = typeof value === 'number' && Number.isFinite(value) ? value : -1;
  if (cur < thresholds[0]) return { seg: -1, ratio: 0, done: false };
  for (let i = 1; i < n; i++) {
    if (cur < thresholds[i]) {
      const lo = thresholds[i - 1];
      const span = thresholds[i] - lo;
      return { seg: i - 1, ratio: span > 0 ? (cur - lo) / span : 1, done: false };
    }
  }
  return { seg: n - 1, ratio: 1, done: true };
}

/** 距离 -> 路径采样下标（二分） */
function distToIndex(dist, len) {
  let lo = 0;
  let hi = dist.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (dist[mid] <= len) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 径向光晕精灵：预渲染到 64px 离屏画布，绘制时 drawImage 缩放复用，避免每帧创建径向渐变。
 * @param {Array<[number, string]>} stops 渐变色标 [offset, color]
 * @returns {Object|null} 离屏画布；低版本基础库不支持时返回 null（调用方降级）
 */
function createGlowSprite(stops) {
  try {
    const size = 64;
    const off = wx.createOffscreenCanvas({ type: '2d', width: size, height: size });
    const c = off.getContext('2d');
    const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    stops.forEach((s) => g.addColorStop(s[0], s[1]));
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    return off;
  } catch (e) {
    return null;
  }
}

/**
 * 描出已采样路线路径（beginPath + moveTo/lineTo 到 endIdx），不设置样式也不 stroke，
 * 由调用方决定描边/虚线/阴影。抽出来是因为同一段路径在一帧内要描多次（外发光、内核、流光）。
 * @param {Array<{x:number, y:number}>} path 采样点列
 * @param {number} endIdx 终点下标（含）；超出长度自动钳制
 */
function tracePath(ctx, path, endIdx) {
  const end = Math.min(endIdx, path.length - 1);
  ctx.beginPath();
  ctx.moveTo(path[0].x, path[0].y);
  for (let i = 1; i <= end; i++) ctx.lineTo(path[i].x, path[i].y);
}

/**
 * 沿已采样路线描「流动虚线」（能量管道流光）：dash/gap 固定，靠 offset 逐帧前移产生流动感。
 * 样式（strokeStyle/lineWidth/lineCap）由调用方设置；内部 save/restore 保证 lineDash 不外泄。
 * @param {number} offset 传给 setLineDash 的 lineDashOffset，负值表示沿前进方向流动
 */
function drawDashFlow(ctx, path, endIdx, dash, gap, offset) {
  ctx.save();
  ctx.setLineDash([dash, gap]);
  ctx.lineDashOffset = offset;
  tracePath(ctx, path, endIdx);
  ctx.stroke();
  ctx.restore();
}

/**
 * 正六边形环路径（HUD 节点框）：一次 beginPath 内画外圈，给了 innerRatio 再画内圈，
 * 单次 stroke 即得双环。只建路径不描边，样式由调用方决定。
 * @param {number} rot 旋转弧度（0 = 顶点朝右）
 * @param {number} [innerRatio] 内圈半径比例，省略则只有外圈
 */
function drawHexRing(ctx, cx, cy, r, rot, innerRatio) {
  const hex = (radius) => {
    for (let i = 0; i < 6; i++) {
      const a = (rot || 0) + (i * Math.PI) / 3;
      const x = cx + Math.cos(a) * radius;
      const y = cy + Math.sin(a) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };
  ctx.beginPath();
  hex(r);
  if (innerRatio) hex(r * innerRatio);
}

/**
 * 雷达扫描扇形路径（以当前坐标系原点为圆心），调用方先 translate + rotate 再 fill。
 * 圆心固定在原点是刻意的：配合以 (0,0) 为心创建的缓存径向渐变，旋转时渐变随之对齐。
 * @param {number} arc 扇形张角（弧度），关于 +x 轴对称
 */
function drawScanSector(ctx, r, arc) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, r, -arc / 2, arc / 2);
  ctx.closePath();
}

/**
 * 切角 HUD 面板路径（四角斜切的矩形，科技感边框/底衬），只建路径，fill/stroke 由调用方决定。
 * @param {number} cut 切角尺寸，自动钳制到不超过宽高一半
 */
function drawHudPanel(ctx, x, y, w, h, cut) {
  const c = Math.min(cut, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

/**
 * 进度环「值弧」路径（HUD 仪表）：自 12 点方向起顺时针画 ratio 圈。只建路径不落笔，
 * 调用方自行设置线宽/线帽/颜色后 stroke（底环由调用方另画整圆）。
 * @param {number} ratio 0~1，自动钳制
 */
function drawArcGauge(ctx, cx, cy, r, ratio) {
  const clamped = Math.min(1, Math.max(0, ratio || 0));
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + clamped * Math.PI * 2);
}

module.exports = {
  easeOutCubic,
  drawStar,
  drawRoundRect,
  getCanvasNodePositions,
  sampleRoutePath,
  locateSegment,
  distToIndex,
  createGlowSprite,
  tracePath,
  drawDashFlow,
  drawHexRing,
  drawScanSector,
  drawHudPanel,
  drawArcGauge
};
