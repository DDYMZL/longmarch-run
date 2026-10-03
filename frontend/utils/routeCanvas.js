/**
 * 路线 Canvas 共用绘制工具：星空长征（pages/march）与完成仪式（pages/ceremony）共用。
 * 全部为无副作用纯函数；坐标单位为 CSS px（调用方负责 dpr 缩放）。
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
 * len 全长、nodePathIndex 各节点在 path 上的采样下标（i * (segs+1)）。
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
  for (let i = 0; i < n; i++) nodePathIndex.push(i * (segs + 1));

  return { path, dist, len: dist[dist.length - 1], nodePathIndex };
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

module.exports = {
  easeOutCubic,
  drawStar,
  drawRoundRect,
  getCanvasNodePositions,
  sampleRoutePath,
  distToIndex
};
