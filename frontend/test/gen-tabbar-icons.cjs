/**
 * 底部 tabBar 图标生成器（零依赖：超采样光栅化 + zlib 编码 PNG）。
 * 普通态 = 灰色线框，选中态 = 主题红实心（细节镂空透明）。
 * 用法：node frontend/test/gen-tabbar-icons.cjs  → 输出到 frontend/images/tabbar/
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 81; // 微信推荐 81×81px
const SS = 4; // 每像素 4×4 超采样抗锯齿
const W = 5.5; // 线框描边宽度
const COLOR_NORMAL = [0x99, 0x99, 0x99];
const COLOR_SELECTED = [0xc8, 0x10, 0x2e];
const OUT_DIR = path.join(__dirname, '..', 'images', 'tabbar');

/* ---------- 几何图元：返回 (x,y)=>boolean ---------- */

const inPoly = (pts) => (x, y) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const segDist = (x, y, [x1, y1], [x2, y2]) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
};

const stroke = (pts, w, closed) => (x, y) => {
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    if (segDist(x, y, pts[i], pts[(i + 1) % pts.length]) <= w / 2) return true;
  }
  return false;
};

const disk = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const ring = (cx, cy, r, w) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) <= w / 2;

/** 弧线采样点（角度为度，0°=右，顺时针为正） */
const arc = (cx, cy, rx, ry, a0, a1, n = 24) => {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
};

/** 五角星顶点 */
const starPts = (cx, cy, R, r) => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 ? r : R;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return pts;
};

/* ---------- 图标定义：每个返回 [op, test][]，按顺序叠加（add 置入 / sub 镂空） ---------- */

const HOUSE = [[40.5, 12], [71, 38], [62, 38], [62, 69], [19, 69], [19, 38], [10, 38]];
const FLAG = [[24, 15], [66, 15], [55, 28.5], [66, 42], [24, 42]];
const ENVELOPE = [[11, 20], [70, 20], [70, 62], [11, 62]];
const ENVELOPE_FLAP = [[13, 23], [40.5, 44], [68, 23]];
const CUP = [[22, 14], [59, 14], ...arc(40.5, 32, 18.5, 20, 0, 180)];
const HANDLE_L = arc(22, 26, 10, 9, 90, 270, 16);
const HANDLE_R = arc(59, 26, 10, 9, -90, 90, 16);
const BODY = [...arc(40.5, 70, 25, 22, 180, 360), [65.5, 70]];

const ICONS = {
  home: {
    normal: [
      ['add', stroke([[12, 38], [40.5, 14], [69, 38]], W)],
      ['add', stroke([[20, 34], [20, 67], [61, 67], [61, 34]], W)],
      ['add', inPoly(starPts(40.5, 48, 10, 4.2))]
    ],
    selected: [
      ['add', inPoly(HOUSE)],
      ['sub', inPoly(starPts(40.5, 49, 11, 4.6))]
    ]
  },
  march: {
    normal: [
      ['add', stroke([[18, 11], [18, 72]], W)],
      ['add', stroke(FLAG, W, true)],
      ['add', inPoly(starPts(36, 28.5, 6.5, 2.7))]
    ],
    selected: [
      ['add', stroke([[18, 11], [18, 72]], W)],
      ['add', inPoly([[18, 12.5], ...FLAG.slice(1), [18, 44.5]])],
      ['sub', inPoly(starPts(36, 28.5, 7, 2.9))]
    ]
  },
  quiz: {
    normal: [
      ['add', stroke(ENVELOPE, W, true)],
      ['add', stroke(ENVELOPE_FLAP, W)]
    ],
    selected: [
      ['add', inPoly([[11, 22], [13, 18], [68, 18], [70, 22], [70, 62], [68, 64], [13, 64], [11, 62]])],
      ['sub', stroke(ENVELOPE_FLAP, W)]
    ]
  },
  rank: {
    normal: [
      ['add', stroke(CUP, W, true)],
      ['add', stroke(HANDLE_L, W)],
      ['add', stroke(HANDLE_R, W)],
      ['add', stroke([[40.5, 52], [40.5, 60]], W)],
      ['add', stroke([[27, 66], [54, 66]], W)]
    ],
    selected: [
      ['add', stroke(HANDLE_L, W)],
      ['add', stroke(HANDLE_R, W)],
      ['add', inPoly(CUP)],
      ['sub', inPoly(starPts(40.5, 29, 9, 3.8))],
      ['add', stroke([[40.5, 50], [40.5, 60]], W + 1)],
      ['add', stroke([[26, 66], [55, 66]], W + 1.5)]
    ]
  },
  mine: {
    normal: [
      ['add', ring(40.5, 26, 12, W)],
      ['add', stroke(BODY, W, true)]
    ],
    selected: [
      ['add', disk(40.5, 26, 14.75)],
      ['add', inPoly(BODY)],
      ['add', stroke([[15.5, 70], [65.5, 70]], W)]
    ]
  }
};

/* ---------- 光栅化 + PNG 编码 ---------- */

function render(layers, rgb) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let py = 0; py < SIZE; py++) {
    const row = py * (SIZE * 4 + 1);
    raw[row] = 0; // filter: none
    for (let px = 0; px < SIZE; px++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          let inside = false;
          for (const [op, test] of layers) {
            if (test(x, y)) inside = op === 'add';
          }
          if (inside) hit++;
        }
      }
      const o = row + 1 + px * 4;
      raw[o] = rgb[0];
      raw[o + 1] = rgb[1];
      raw[o + 2] = rgb[2];
      raw[o + 3] = Math.round((hit / (SS * SS)) * 255);
    }
  }
  return raw;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function encodePng(raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, icon] of Object.entries(ICONS)) {
  for (const [state, rgb, suffix] of [['normal', COLOR_NORMAL, ''], ['selected', COLOR_SELECTED, '-active']]) {
    const file = path.join(OUT_DIR, name + suffix + '.png');
    const png = encodePng(render(icon[state], rgb));
    fs.writeFileSync(file, png);
    console.log(path.relative(process.cwd(), file), png.length + 'B');
  }
}
