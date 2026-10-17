# node-themes.js

## 1. 文件路径

`frontend/data/node-themes.js`（71 行）

## 2. 文件职责

「区域氛围主题」静态配置 + 查询工具：让长征路线 10 个节点按历史地理区域呈现不同视觉氛围（渐变背景 + 环境粒子），并导出把主题转成 WXML 内联样式字符串的两个函数（`frontend/data/node-themes.js:1-7` docstring）。`frontend/data/` 目录下唯一文件；新增节点或调整氛围**只改本文件**（`:6`）。

## 3. 业务需求

- 需求 §12「区域氛围」（docstring `:2` 自引；`frontend/design.md` 「区域氛围（P2-2，需求 §12）」段记载：10 节点 → 5 区域，应用于节点详情 hero、星空长征画布环境粒子、实景模式选中节点卡）。
- 关键约束：需求 §12.3 允许「**不修改业务数据结构**、由前端建立『节点 → 区域主题』映射配置」实现视觉（`:3-4` docstring）——因此本文件是纯前端配置，后端不感知（§6 已核实）。

## 4. 核心功能

### 4.1 `THEMES` 常量（`:8-39`，未导出）

**5 个主题条目**，键即主题标识：`ruijin`（晨光·暖色山地）、`chishui`（水雾·山谷水流）、`luding`（峡谷·云雾铁索）、`snow`（雪山·雾气严寒）、`yanan`（黄昏·星空暖塬）。每条数据形状（`:4-5` docstring + 实体一致）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `theme` | string | 主题标识（与键同值，如 `'ruijin'`，`:10`） |
| `environment` | string | 环境描述中文短语（`:11`） |
| `background` | string[3] | 氛围渐变色三段（6 位 hex，`:12`） |
| `particleConfig` | `{type, count, color}` | 粒子配置；type ∈ `ember`（暖尘）/`mist`（水雾）/`snow`（雪花）/`star`（星光）（`:5`、`:13` 等） |

### 4.2 `NODE_THEME_MAP` 常量（`:42-53`，未导出）

节点 id → 主题键的映射，**覆盖 id 1–10 全部 10 个节点**：1→ruijin；2/3/4→chishui（遵义/四渡赤水/巧渡金沙江）；5/6→luding（强渡大渡河/飞夺泸定桥）；7/8→snow（雪山/草地）；9/10→yanan（吴起镇/会师）。按历史地理位置归并（`:41` 注释）。

### 4.3 `getNodeTheme(nodeId)`（`:55-57`）

查映射返回主题对象；**未映射 id 兜底返回 `THEMES.ruijin`**（`:56` 的 `|| THEMES.ruijin`），保证任意 id 不返回 undefined。

### 4.4 `themeBgStyle(theme)`（`:60-63`）

主题 → 内联样式串：`background: linear-gradient(160deg, bg[0] 0%, bg[1] 55%, bg[2] 100%);`（顶→底氛围渐变，`:59` 注释）。返回字符串供 WXML `style="{{...}}"` 直绑（如 `frontend/pages/node-detail/node-detail.wxml:3`）。

### 4.5 `themeSoftStyle(theme)`（`:66-69`）

主题 → 浅色卡片柔和高光样式串：用 `bg[1] + '2E'`、`bg[2] + '1A'` 拼 8 位 hex 透明度（约 18%/10% alpha），末端过渡到 `#FFFFFF 80%`（`:68`），不影响文字可读性（`:65` 注释）。**隐含前提**：`background` 色值必须是 6 位 hex，否则拼接产生非法颜色（当前 5 主题均满足，`:12`、`:18`、`:24`、`:30`、`:36`）。

## 5. 输入与输出

- `getNodeTheme(nodeId)`：入参为节点 id（number 或可作对象键的值）；返回主题对象（形状见 §4.1），永不返回空。
- `themeBgStyle(theme)` / `themeSoftStyle(theme)`：入参为主题对象；返回内联 CSS 字符串。传入缺 `background` 的对象会 TypeError——调用方须传 `getNodeTheme` 的返回值。
- 无异步、无异常分支、无 Storage/网络访问。

## 6. 依赖关系

- 依赖：无（零 require、零 wx API，纯静态数据）。
- 被依赖（全仓 grep `node-themes|getNodeTheme|themeBgStyle|themeSoftStyle` 核实的**全部**代码调用方，共 2 页 + 1 测试脚本）：
  - `frontend/pages/march/march.js:16`（require）：实景模式选中节点卡柔和高光（`:300`、`:305`、`:517`、`:520` 用 `getNodeTheme`+`themeSoftStyle`），星空画布每节点环境粒子读 `particleConfig`（`:639`）；
  - `frontend/pages/node-detail/node-detail.js:11`（require）：hero 区渐变（`:44`、`:63` `themeBgStyle` → `data.themeBgStyle` → `node-detail.wxml:3` 内联样式）与氛围粒子画布（`:106` `startAtmosphere(getNodeTheme(...))`）；
  - `frontend/test/automator/p2-theme-ceremony.cjs:164`：自动化断言 `themeKey === 'ruijin'`、`themeBgStyle` 含 `linear-gradient`（页面 data 字段口径）。
- **与后端的关系（grep 核实）**：`backend/app/models/models.py` 与 `docker/init/` 全量 grep `theme` **零命中**——`route_nodes` 表没有 theme 列，主题**不对应任何后端字段**，是需求 §12.3 允许的纯前端映射。映射键为节点 id，与后端种子数据 `backend/app/data/seed.py:86-185` 的 route_nodes id 1–10 一一对应（id 1「瑞金」`:86`、id 2「遵义」`:97` … id 10「延安」`:185`）。若后端调整节点 id/增删节点，本映射不会报错但会落入 ruijin 兜底（§7.3）。
- 3 个导出全部有调用方，无死导出（`THEMES` 曾因零外部引用在 `e70b59f` 被移出导出，见 §10）。

## 7. 业务规则

1. **区域归并口径**：按历史地理位置而非行政归属——巧渡金沙江归「水雾」（chishui，`:46` 注释「江河水流」）、过草地归「雪山」（snow，`:50` 注释「高原寒湿」）。
2. **粒子预算**：各主题 `count` 10–22（`:13`、`:19`、`:25`、`:31`、`:37`），配合 march 页的环境粒子上限（`frontend/design.md` 区域氛围段：「每节点 3 粒环境粒子封顶 30」；march 页另有粒子总量上限 `CAP = 64`，`frontend/pages/march/march.js:239`）。
3. **兜底规则**：未知节点 id → ruijin 主题（`:56`），视觉不缺失；这是「新增节点只改本文件」（`:6`）成立的前提。
4. 注释与种子节点名的两处措辞差异：`NODE_THEME_MAP` 注释 id 8 写「跋涉草地」（种子名「过草地」，`seed.py:163`）、id 10 写「会宁会师（陕北）」（种子名「延安」，`seed.py:185`）——映射按 id 生效，功能不受影响，仅注释措辞与后端名称不完全一致（§9 记录）。

## 8. 修改约束

1. **不得把主题字段写回后端或要求后端下发**：需求 §12.3 的实现方式就是前端映射（`:3-4`），后端 `route_nodes` 无 theme 列（§6），加列属破坏性契约变更（`frontend/AGENTS.md` §4 不变量 2「数据以后端为准」针对业务数据，视觉配置不在此列）。
2. `background` 必须保持 **3 个 6 位 hex** 色值：`themeBgStyle` 按 3 段取 `bg[0..2]`（`:62`），`themeSoftStyle` 靠字符串拼 `'2E'/'1A'` 生成透明度（`:68`），改成 rgba()/短 hex 会产生非法样式。
3. `particleConfig.type` 枚举（ember/mist/snow/star）与 march、node-detail 两页的粒子绘制分支绑定（`march.js:639`、`node-detail.js:106` 消费），新增类型须同步两页渲染代码。
4. 主题对象字段名（`theme/environment/background/particleConfig`）被页面 data 与自动化测试断言（`p2-theme-ceremony.cjs:164` 断言 `themeKey`，由页面从 `theme.theme` 转出），改名须同步页面与测试。
5. 保持 `module.exports` 最小面：`THEMES`/`NODE_THEME_MAP` 有意不导出（`e70b59f` 清理，`:71`），外部一律经 `getNodeTheme` 访问。

## 9. 当前实现状态

- **已实现**：5 主题、10 节点全映射、3 个导出函数，march 与 node-detail 两页接入；随 `79004f1`（P2-2）交付并有自动化验收（`frontend/test/automator/p2-theme-ceremony.cjs`）。
- **存在问题 / 已知事项**：
  1. `NODE_THEME_MAP` 的 id 8/10 注释措辞与后端种子节点名不一致（「跋涉草地」vs「过草地」、「会宁会师（陕北）」vs「延安」，§7.4）——不影响功能，是否统一注释**待确认**。
  2. 兜底主题为 ruijin（`:56`）：后端若新增 id 11+ 节点而本文件未同步，新节点将呈现瑞金氛围且**无任何告警**——属设计内行为（`:6` 要求新增节点改本文件），但无编译期/运行期提醒，依赖人工同步。
- **待开发**：无。

## 10. 迭代记录

数据来源：`git log --follow --oneline -- frontend/data/node-themes.js`，共 **2 个提交**。按时间倒序。

### 2026-10-11（`e70b59f`）
- 需求：小程序代码审查修复批次（删除无引用导出）。
- 修改内容（涉本文件，据 `git show e70b59f` diff）：`module.exports` 移除零外部引用的 `THEMES`（`frontend/test/docs/s16-miniprogram-review-fixes-report.md`：「删除…node-themes 导出的 THEMES」），其余不变。
- 测试结果：见 `docs/迭代记录.md` 的 `e70b59f` 条目。

### 2026-10-04（`79004f1`）
- 需求：区域氛围与长征完成仪式（P2-2，需求 §12）。
- 修改内容（涉本文件）：创建本文件——5 个区域主题、10 节点映射、`themeBgStyle`/`themeSoftStyle` 导出（`frontend/test/docs/p2-theme-ceremony-report.md`：「data/node-themes.js（新增，§12.3 允许的前端主题映射配置）：5 个区域主题」）。
- 关联文件：`frontend/pages/node-detail/node-detail.js`、`frontend/pages/march/march.js`、`frontend/utils/routeCanvas.js`（同批新增）、`frontend/pages/ceremony/ceremony.js`。
- 测试结果：见 `docs/迭代记录.md` 的 `79004f1` 条目（automator `p2-theme-ceremony.cjs` 断言主题渲染）。
