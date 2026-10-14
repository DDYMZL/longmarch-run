#!/usr/bin/env node
// 构建产物打包：把 admin/dist 的内容压成 admin/dist.zip（零依赖，跨平台）。
// 说明：
//   - 依赖 npm 生命周期执行，构建后在 admin 目录生成 dist.zip；
//   - Zip 内条目为 dist 的「内容」（index.html、assets/... 位于压缩包根目录），便于直接解压部署；
//   - 不引入 archiver/jszip 等依赖：环境可能没有 zip/7z 可执行文件，用 Node 内置 zlib 手写 Zip 结构最稳；
//   - dist 不存在时直接报错退出（避免打出空包覆盖上一次产物）。
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(ADMIN_DIR, 'dist');
const OUT_ZIP = join(ADMIN_DIR, 'dist.zip');

// Zip 单文件字段为 32 位、条目数上限 65535，越界会静默损坏，故显式拦截。
const MAX_ENTRIES = 0xffff;
const MAX_FILE_SIZE = 0xffffffff;

/** CRC-32（IEEE 802.3）查表实现，Zip 校验必需。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 取 MS-DOS 时间戳（Zip 头用），年份基于 1980。 */
function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** 递归收集目录下所有文件，条目名统一用 / 分隔（Zip 规范）。 */
function collectFiles(dir, base = dir, out = []) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(abs, base, out);
    else if (entry.isFile()) out.push({ abs, name: relative(base, abs).split(sep).join('/') });
  }
  return out;
}

function buildZip(files, outPath) {
  const chunkParts = [];
  const centralParts = [];
  const { time, date } = dosDateTime(new Date());
  let offset = 0;

  for (const { abs, name } of files) {
    const raw = readFileSync(abs);
    if (raw.length > MAX_FILE_SIZE) throw new Error(`文件超过 4GB，无法用基础 Zip 格式打包：${name}`);
    const nameBuf = Buffer.from(name, 'utf8');
    // 压缩后反而更大（小文件/已压缩资源）时按存储方式写，避免无谓膨胀。
    const deflated = deflateRawSync(raw, { level: 9 });
    const stored = deflated.length >= raw.length;
    const data = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 标志位：文件名为 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    chunkParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 创建者版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 外部属性：unix 权限 0644（>>>0 转无符号，避免溢出为负）
    central.writeUInt32LE(offset, 42); // 对应本地文件头偏移
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 中央目录结束记录签名
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // 注释长度

  writeFileSync(outPath, Buffer.concat([...chunkParts, centralDir, end]));
  return offset + centralDir.length + end.length;
}

function main() {
  if (!existsSync(DIST_DIR) || !statSync(DIST_DIR).isDirectory()) {
    console.error(`[zip-dist] 未找到构建产物目录：${DIST_DIR}\n请先执行 npm run build。`);
    process.exit(1);
  }
  const files = collectFiles(DIST_DIR);
  if (files.length === 0) {
    console.error(`[zip-dist] 构建产物目录为空：${DIST_DIR}`);
    process.exit(1);
  }
  if (files.length > MAX_ENTRIES) {
    console.error(`[zip-dist] 文件条目数 ${files.length} 超过 Zip 上限 ${MAX_ENTRIES}，需改用 Zip64。`);
    process.exit(1);
  }
  const size = buildZip(files, OUT_ZIP);
  console.log(`[zip-dist] 已生成 ${relative(process.cwd(), OUT_ZIP)}（${files.length} 个文件，${(size / 1024).toFixed(1)} KB）`);
}

main();
