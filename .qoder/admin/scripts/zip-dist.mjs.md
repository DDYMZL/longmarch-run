# zip-dist.mjs

## 1. 文件路径

`admin/scripts/zip-dist.mjs`（144 行）

## 2. 文件职责

管理后台**构建产物打包脚本**：把 `admin/dist/` 的**内容**（`index.html`、`assets/…` 位于压缩包根目录）压成 `admin/dist.zip`，便于直接解压到 nginx web root 部署（头注释 `:2-7`）。**零第三方依赖、跨平台**——不调用系统 `zip`/`7z`/`tar`，用 Node 内置 `zlib.deflateRawSync` 手写 Zip 二进制结构（本地文件头 / 中央目录 / EOCD + CRC-32 查表），注释 `:6` 说明动机：运行环境可能没有 zip/7z 可执行文件（`79cf738` 条目记载本机 git bash 实测无 `zip`/`7z`、GNU tar 不能出 zip）。

## 3. 业务需求

- `79cf738`（2026-10-14）：管理后台发布产物需要标准化为 `dist.zip`（服务器侧「unzip 到 nginx web root」即完成前端发布，`build-prod.bat:168-169` 的指引同此）。此前打包方式**待确认**（该提交前仓库内无 admin 产物打包脚本，`docs/迭代记录.md` 的 `79cf738` 条目只记载「新增」）。
- 要求 build 后自动出包、产物未变时可单独重出包：对应 `package.json` 的 `build` 末尾链式调用与独立 `zip` 脚本（§6.2）。
- 纳入一键发布链路：仓库根 `build-prod.bat`（`f2a8939` 新增）第 [3/6] 步经 `npm run build` 间接触发本脚本，并把 `admin/dist.zip` 列为三件发布产物之一。

## 4. 核心功能

### 4.1 路径与常量（`:13-19`）

- `ADMIN_DIR` 由 `import.meta.url` 反推（`:13`，`dirname(fileURLToPath(...))` 的上一级），**与执行时 cwd 无关**；`DIST_DIR = <admin>/dist`、`OUT_ZIP = <admin>/dist.zip`（`:14-15`）。
- Zip 基础格式硬上限显式拦截（注释 `:17`：字段 32 位、条目数 16 位，越界会**静默损坏**）：`MAX_ENTRIES = 0xffff`、`MAX_FILE_SIZE = 0xffffffff`（`:18-19`）。

### 4.2 CRC-32（`:21-36`）

IEEE 802.3 多项式 `0xedb88320` 建 256 项查表（`:22-30`，IIFE 一次性生成），`crc32(buf)` 对原始字节求校验值（`:32-36`）——Zip 条目必需，`79cf738` 验证时用 Python `zipfile.testzip()` 复核全部通过。

### 4.3 `dosDateTime(d)`（`:38-44`）

本地时间转 MS-DOS 时间/日期字（Zip 头格式，年份基于 1980）。全部条目共用**构建时刻**的同一时间戳（`:60`）。

### 4.4 `collectFiles(dir, base, out)`（`:46-55`）

递归收集目录下全部**普通文件**：`readdirSync(..., { withFileTypes: true })` 并按文件名排序（`:48`，保证条目顺序确定性）；条目名用 `relative(base, abs)` 后把 `\` 统一替换为 `/`（`:52`，Zip 规范分隔符）。**只收 `isFile()`**：符号链接（`isSymbolicLink()`）与非常规文件被静默跳过（现状 vite 产物无符号链接，属潜在边界，§9）；空目录不产生条目。

### 4.5 `buildZip(files, outPath)`（`:57-124`）

逐文件写 Zip 结构：

1. 读原始字节；`raw.length > MAX_FILE_SIZE`（4GB）抛错（`:64-65`）。
2. `deflateRawSync(raw, { level: 9 })` 压缩；**压缩后反而不小于原始体积时改按存储方式写入**（`:67-71`，`stored` → method 0，否则 method 8）——vite 产物多为已压缩的字体/图片，避免无谓膨胀。
3. 本地文件头 30 字节（`:74-86`）：签名 `0x04034b50`、解压版本 20、**标志位 `0x0800`（文件名 UTF-8）**、method、DOS 时间、CRC、压缩/原始尺寸、文件名长度、扩展字段 0。
4. 中央目录条目 46 字节（`:88-106`）：签名 `0x02014b50`，外部属性写 unix 权限 `0644`——`0o100644 << 16` 在 JS 32 位有符号位移下会溢出为负导致 `writeUInt32LE` 抛 `ERR_OUT_OF_RANGE`，故 `(… >>> 0)` 转无符号（`:104` 行内注释；该坑是 `79cf738` 开发期实测踩出并修复的）。
5. EOCD 22 字节（`:111-120`）：签名 `0x06054b50`、条目数（两处 UInt16）、中央目录尺寸与偏移。
6. 一次 `writeFileSync` 落盘（`:122`），返回产物总字节数（`:123`）。

### 4.6 `main()`（`:126-142`，`:144` 顶层调用）

前置校验三连，全部 **stderr + `process.exit(1)`**：`dist` 不存在或不是目录（`:127-130`，提示先执行 `npm run build`；注释 `:7`：避免打出空包**覆盖上一次产物**）；`dist` 为空目录（`:132-135`）；条目数超 `MAX_ENTRIES`（`:136-139`，提示需改用 Zip64）。成功后打印 `[zip-dist] 已生成 <相对 cwd 路径>（N 个文件，X KB）`（`:140-141`）。4GB 超限走 `throw`（`:65`），未捕获异常同样使 Node 以非零码退出。

## 5. 输入与输出

- **输入**：无命令行参数、不读 stdin、不读环境变量；唯一输入是文件系统上的 `admin/dist/` 目录（路径由脚本自身位置推导，`:13-15`）。
- **输出**：`admin/dist.zip`（覆盖写）；stdout 一行成功日志，stderr 错误信息。
- **退出码**：0 成功；1（dist 缺失/为空/条目超限）；非零（单文件 >4GB 的未捕获 throw、读写权限等 I/O 异常）。CI/批处理可感知：`build-prod.bat:81-82` 以 `errorlevel` 判断 `npm run build` 链路成败，`:84-87` 再校验 `dist.zip` 确实产出。
- **打包范围**：`dist/` 下**全部文件，无任何排除规则**——脚本假定 dist 是纯构建产物：`admin/vite.config.ts` 未开启 `build.sourcemap`（vite 默认 false），产物无 `.map`；`.env*` 的 `VITE_` 变量在构建期内联进 JS，环境文件本身不进 dist；`node_modules` 与 dist 无关。（若未来开启 sourcemap 或向 dist 塞额外文件，会被原样打进发布包，需同步评估。）

## 6. 依赖关系

- **运行时依赖**：仅 Node 内置模块——`node:fs`（readdir/read/write/exists/stat）、`node:zlib`（`deflateRawSync`）、`node:path`、`node:url`（`:8-11`）；**无第三方包**（`package.json` devDependencies 中无 archiver/jszip 之类，注释 `:6` 明确不引入），也不依赖系统 zip/7z/tar 命令，故无平台可执行文件依赖风险；ESM（`.mjs` + `import`），要求 `package.json` 的 `"type": "module"` 或 `.mjs` 后缀生效（现状即 `.mjs`）。
- **被谁调用**：
  1. `admin/package.json:9`——`build` 脚本链式末段：`vue-tsc --noEmit … && vite build --mode prod && node scripts/zip-dist.mjs`（类型检查、构建任一失败则不会执行到打包）；
  2. `admin/package.json:10`——独立 `zip` 脚本：`node scripts/zip-dist.mjs`（产物未变时重新出包）；
  3. 仓库根 `build-prod.bat`（发布总控，`f2a8939` 新增，文档由并行任务负责，此处只引源码）：`:67-88` 第 [3/6] 步 `pushd admin && call npm run build`（间接执行本脚本），随后校验 `admin\dist.zip` 存在；`:109-113` 第 [6/6] 步产物清单校验含 `admin\dist.zip`；`:151`、`:168-169` 打印服务器侧「上传并 unzip 到 nginx web root」指引。
- **产物去向**：`admin/dist.zip` 在根 `.gitignore:21` 中，不入库（`.qoder/README.md` §4 构建产物不建档，本脚本是该产物的生成器故必须建档）。

## 7. 业务规则

1. **Zip 根即 dist 内容**：压缩包内不含 `dist/` 顶层目录，`index.html`、`assets/…` 直接位于根（注释 `:5`），服务器解压到 web root 即部署完成——改变条目层级会破坏 `build-prod.bat:168-169` 的部署指引。
2. **失败不覆盖旧产物**：dist 缺失/为空时先报错退出、不写 `dist.zip`（注释 `:7`），保证上次成功产物仍可发布。
3. **Zip 基础格式硬上限必须显式拦截**（条目 ≤65535、单文件 ≤4GB），越界静默损坏比报错更危险（注释 `:17`）；Zip64 未实现（当前产物 36 个文件/约 520KB，远未触及）。
4. 条目名统一 `/` 分隔 + UTF-8 标志位（`:52`、`:77`），保证 Windows/Linux 解压工具与中文文件名兼容；文件权限统一 0644（`:104`）。
5. 已压缩资源自动退化为存储方式（method 0，`:67-71`），体积优先于压缩率的形式主义。

## 8. 修改约束

1. **保持零依赖**：不得引入 archiver/jszip 等第三方包或改为调用系统 zip/7z（注释 `:6` 的环境假设仍成立）；如需 Zip64/加密等能力再评估。
2. Zip 二进制布局的字段偏移（本地头 30B、中央目录 46B、EOCD 22B）与签名常量是 ZIP 规范硬约定，改 `buildZip` 必须逐字段核对，并用 Python `zipfile`（`testzip()` + 逐文件哈希比对）复核产物——`79cf738` 的验证方法可直接复用。
3. `0o100644 << 16` 必须保留 `>>> 0`（`:104`）；同类 32 位写入凡涉及高位比特都要防 JS 有符号位移溢出。
4. 退出码语义不得弱化：`build-prod.bat` 与 npm script 链依赖非零退出感知失败；新增校验分支应沿用 `console.error + process.exit(1)`。
5. 若修改产物路径/文件名（`OUT_ZIP`），需同步 `build-prod.bat`（`:8`、`:84-88`、`:111`、`:151`、`:168`）、根 `.gitignore:21` 与 `admin/design.md` §6 构建与打包说明。
6. 本脚本只读 `dist/`、只写 `dist.zip`，**不得**扩展为顺带清理/改动源码或环境文件（发布链路职责单一）。

## 9. 当前实现状态

- **已实现且经独立复核**：`79cf738` 交付时 `node --check`、`npm run zip`、`npm run build` 全链路通过；产物用 Python `zipfile` 复核——CRC 全部通过、36 个条目与 `dist/` 逐文件 SHA256 一致、压缩方式均为 deflate(8)、条目路径正确（见 `docs/迭代记录.md` 的 `79cf738` 条目）。`f2a8939` 又实跑两轮 `build-prod.bat` 全链路（`dist.zip` 538153 B）。
- **已知边界（非缺陷，登记备查）**：
  1. `collectFiles` 静默跳过符号链接与非常规文件（`:51-52` 只收 `isDirectory()`/`isFile()`）——vite 产物现状无符号链接；若未来产物含链接将不入包且无警告。
  2. 无排除规则（§5）：dist 内任何文件都会进包，防敏感文件入包完全依赖 vite 构建行为。
  3. 不支持 Zip64（显式报错拦截，`:65`、`:136-139`）；不支持目录条目（空目录不表示，dist 场景无影响）。
  4. 所有条目时间戳为构建时刻的本地时间（`:60`、`:38-44`），非文件 mtime；仅影响解压后的文件时间显示。
- **待确认**：`79cf738` 之前管理后台产物如何打包交付（手工压缩与否），仓库内无记录。

## 10. 迭代记录

数据来源：`git log --follow --format='%h | %ad | %s' --date=format:'%Y-%m-%d %H:%M' -- admin/scripts/zip-dist.mjs`，共 **1 个提交**（创建后未再修改），在 `docs/迭代记录.md` 有对应条目。按时间倒序。

### 2026-10-14（`79cf738`，15:09）
- 需求：管理后台 build 后自动生成标准化发布产物 `dist.zip`（零依赖、跨平台）。
- 修改内容：**创建本文件**（CRC-32 查表 + deflateRaw + 手写 Zip 结构 + 三重前置校验）；`admin/package.json` 的 `build` 末尾追加 `node scripts/zip-dist.mjs` 并新增独立 `zip` 脚本；根 `.gitignore` 新增 `admin/dist.zip`；`admin/design.md` 新增「§6 构建与打包」。开发期修复 `0o100644 << 16` 有符号位移溢出（改 `>>> 0`，`:104`）。
- 关联文件：`admin/package.json`、`.gitignore`、`admin/design.md`；后续 `build-prod.bat`（`f2a8939`，2026-10-17）将其纳入一键发布链路第 [3/6] 步。
- 测试结果：见 `docs/迭代记录.md` 的 `79cf738` 条目（Python zipfile 独立复核 CRC/SHA256/条目路径全部通过；边界分支——dist 缺失/为空/超限——报错退出验证）。
