/**
 * 区域氛围主题（需求 §12）：让不同历史区域具有不同视觉氛围。
 * §12.3：不修改业务数据结构实现视觉，前端建立「节点 → 区域主题」映射配置。
 * 每个主题字段（对应 §12.3 建议）：theme 标识 / environment 环境描述 /
 * background 氛围渐变 / particleConfig 粒子配置（type: ember 暖尘 | mist 水雾 | snow 雪花 | star 星光）。
 * 新增节点或调整氛围只改本文件。
 */
const THEMES = {
  ruijin: {
    theme: 'ruijin',
    environment: '晨光·暖色山地',
    background: ['#4A2E17', '#8A5527', '#D9A05B'],
    particleConfig: { type: 'ember', count: 16, color: '#FFD9A0' }
  },
  chishui: {
    theme: 'chishui',
    environment: '水雾·山谷水流',
    background: ['#12333B', '#1E565F', '#4E93A0'],
    particleConfig: { type: 'mist', count: 10, color: '#BFE3EA' }
  },
  luding: {
    theme: 'luding',
    environment: '峡谷·云雾铁索',
    background: ['#1E2633', '#37465C', '#6B7F9C'],
    particleConfig: { type: 'mist', count: 12, color: '#C9D6E8' }
  },
  snow: {
    theme: 'snow',
    environment: '雪山·雾气严寒',
    background: ['#233549', '#47617D', '#9FB8CE'],
    particleConfig: { type: 'snow', count: 22, color: '#FFFFFF' }
  },
  yanan: {
    theme: 'yanan',
    environment: '黄昏·星空暖塬',
    background: ['#2B1F33', '#6B3F4E', '#C98B5F'],
    particleConfig: { type: 'star', count: 18, color: '#FFE9B8' }
  }
};

// 节点 → 区域主题（按历史地理位置归并）
const NODE_THEME_MAP = {
  1: 'ruijin',   // 瑞金
  2: 'chishui',  // 遵义（黔北，近赤水河谷）
  3: 'chishui',  // 四渡赤水
  4: 'chishui',  // 巧渡金沙江（江河水流）
  5: 'luding',   // 强渡大渡河（峡谷）
  6: 'luding',   // 飞夺泸定桥
  7: 'snow',     // 翻越雪山
  8: 'snow',     // 跋涉草地（高原寒湿）
  9: 'yanan',    // 吴起镇（陕北）
  10: 'yanan'    // 会宁会师（陕北）
};

function getNodeTheme(nodeId) {
  return THEMES[NODE_THEME_MAP[nodeId]] || THEMES.ruijin;
}

/** 氛围渐变内联样式（顶→底） */
function themeBgStyle(theme) {
  const bg = theme.background;
  return 'background: linear-gradient(160deg, ' + bg[0] + ' 0%, ' + bg[1] + ' 55%, ' + bg[2] + ' 100%);';
}

/** 柔和主题色（浅色卡片氛围 tint，不影响文字可读性） */
function themeSoftStyle(theme) {
  const bg = theme.background;
  return 'background: linear-gradient(160deg, ' + bg[1] + '2E 0%, ' + bg[2] + '1A 45%, #FFFFFF 80%);';
}

module.exports = { THEMES, getNodeTheme, themeBgStyle, themeSoftStyle };
