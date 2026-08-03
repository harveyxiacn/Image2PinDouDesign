# 拼豆设计网站（Image2PinDouDesign）优化建议

> 生成日期：2026-08-02
> 适用范围：本文件为**独立自包含**的优化方案，可直接提供给任意模型（如 DeepSeek）或开发者参考实施。
> 项目位置：`E:\Project\Image2PinDouDesign`
> 技术栈：React 18 + TypeScript + Vite 7 + Web Worker + PWA，纯客户端应用（图片不上传、无后端）。
> 当前基线（2026-08-03 更新）：`npm test` **71/71 通过**（`src/test/domain.test.ts`、`src/test/app.test.tsx`、`src/test/design-preview.test.tsx`），`npm run build` 成功（PWA 预缓存 13 项）。 本方案 P0/P1 大部分已由三个并行 sub-agent 实施完成并部署上线，见下方「0.5 实施状态总览」。
> 建议来源：代码审查 + [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) skill 检索（触控、加载反馈、表单、Pixel Art 风格等条目已标注出处）。

---

## 0. 优先级速览

| 优先级 | 主题 | 一句话结论 |
| --- | --- | --- |
| P0 | 转换正确度 | 边缘去污染、自适应去白底、CIEDE2000 色差、焦点裁剪、真实板型分页 |
| P1 | 智能化 | 一键参数推荐、自动抠图、风格预设、库存差缺清单 |
| P1 | UI | 渐进式披露、SVG 图标、面板整合、转换进度 |
| P1 | UX/无障碍 | 触控目标、键盘操作画布、ARIA、撤销重做、草稿管理 |
| P2 | 工程化 | 拆 hooks、Canvas 分层、IndexedDB、ErrorBoundary、PNG 图标 |

建议实施顺序：**P0 转换正确度 → P1 智能化/UI/UX → P2 工程化**。每完成一批跑 `npm test` 与 `npm run build` 回归。

---

---

## 0.5 实施状态总览（2026-08-03，已上线）

> 三个并行 sub-agent（转换正确度 / UI 视觉 / 交互工程化）已于 2026-08-03 实施完成：测试 71/71 通过、构建成功，
> 部署至 `https://pindou.fanni-panda.com`（VPS `136.175.83.102`，nginx 原子切换 `promote-release.sh`，旧版已备份）。
> Git：commit `29cd7bb`（`feat: conversion accuracy, UI/UX polish, and a11y improvements`），已推送 `origin/main`。

### ✅ 已实施

| 章节 | 实施内容 | 主要文件 |
| --- | --- | --- |
| 1.1 半透明边缘去污染 | 颜色匹配前反推前景色，去除半透明边缘的背景污染 | `src/domain/conversion.ts` |
| 1.2 自适应背景去除 | ΔE00 泛洪填充 + 边缘容差，背景色自适应（白底/花底） | `src/domain/background.ts` |
| 1.3 色差算法 | 实际实现本就是全色板暴力 CIEDE2000；README 原“ΔE*76 预筛”描述不实，已更正并用 D15/C9 回归测试固化选色行为 | `README.md`、`src/test/domain.test.ts` |
| 1.5 抖动算法 | 新增 Bayer 抖动选项，可与 Floyd–Steinberg 切换 | `conversion.ts`、`types.ts`、`SettingsPanel.tsx` |
| 1.6 中值滤波 | 色板域中值滤波，减小色块噪声 | `src/domain/simplify.ts`、`src/domain/color.ts` |
| 1.7 板型预设 | 新增 29×29 / 50×50 板预设（`getBoardTilePins`） | `src/domain/boards.ts` |
| 1.8 打印/PDF 按板分页 | 打印分页线按实际针数（`boardLineEvery`） | `src/domain/exporters.ts`、`App.tsx` |
| 1.10 小图约束 | 小图不再强制放大到 8×8 | `src/domain/conversion.ts` |
| 3.1 渐进式披露 | 设置面板分级展示，避免平铺 | `SettingsPanel.tsx` |
| 3.2 SVG 图标 | 18 个 SVG 图标替换全部 emoji 图标（＋✎⚙↓×✂️ 等） | `src/components/icons.tsx` 及全部组件 |
| 3.3 291 色面板整合 | 色板可折叠 + ARIA 语义 | `PalettePanel.tsx` |
| 3.6 转换进度与取消 | worker 进度上报 + 可取消转换 | `conversion.worker.ts`、`App.tsx` |
| 4.1 画布键盘操作 | 方向键逐格移动/放置/取色，测试覆盖 | `DesignPreview.tsx`、`design-preview.test.tsx` |
| 4.2 触控目标 | 触控目标 ≥44px、间距 ≥8px | `styles.css`、各面板 |
| 4.4 prefers-reduced-motion | 动画尊重系统“减弱动态效果” | `styles.css` |
| 4.5 撤销/重做 | Ctrl+Z / Ctrl+Y 快捷键 | `DesignPreview.tsx` |
| 4.7/5.4 错误反馈 | ErrorBoundary 运行时兜底 | `components/ErrorBoundary.tsx`、`main.tsx` |
| 4.8/5.5 分享与品牌 | OG/twitter 绝对 URL、PNG 192/512 + maskable 图标 | `index.html`、`public/`、`vite.config.ts` |

### ⏳ 未实施（建议后续迭代）

- **1.4 焦点控制**：CropDialog 仅做了 UI 层优化，cover/contain 焦点算法未深改
- **1.9 草稿与项目计数**、**4.6 草稿管理 UI**、**5.3 IndexedDB 草稿持久化**（刷新不丢）
- **2.1 一键参数推荐**、**2.2 自动抠图增强**、**2.3 风格预设**、**2.4 库存差缺清单**、**2.5 自动描边**、**2.6 语义颜色保护**
- **3.4 设计标签画廊化**、**3.5 表单控件统一**（部分随 3.1 一并改善）
- **5.1 拆分 App.tsx（hooks）**、**5.2 Canvas 分层渲染**
- **5.6 补充测试**：worker 竞态、草稿持久化往返、CSV 导出转义（键盘操作已有 `design-preview.test.tsx` 覆盖）

## 1. 转换正确度（P0，最影响成品质量）

### 1.1 半透明边缘像素去污染 —— `src/domain/conversion.ts`
- **问题**：`isOpaqueEnough` / `quantize` 对半透明像素直接按 alpha 阈值取舍，边缘像素带着背景色参与颜色匹配，导致成品边缘出现"脏边"（尤其白底/花底图片）。
- **建议**：在颜色匹配前先做边缘去污染（edge decontamination）：对 alpha 介于 0~1 的像素，用 `c' = (c - bg * (1 - a)) / a` 反推前景色，无效则用邻近不透明像素补色；再做预乘 alpha 归一化。
- **验收**：生成含白色/透明 PNG 边缘的测试图，比较旧/新输出的边缘列颜色纯度。

### 1.2 自适应背景去除 —— `src/domain/background.ts`
- **问题**：`dropBorderWhite` 用固定阈值 240 判定白边，遇浅灰、米黄、浅蓝背景会误删或漏删。
- **建议**：改为"自适应背景估计 + ΔE 容差泛洪填充"：取四角像素聚簇估计背景色，以 CIEDE2000 容差做连通域泛洪，只删与背景连通的区域，不删图像内部同色像素。
- **验收**：对浅灰/米黄底图片对比新旧输出；现有 53 个测试保持通过。

### 1.3 色差算法升级 —— `src/domain/color.ts`
- **问题**：`findNearestCodeByLab` 对全 291 色暴力遍历且用 ΔE*76，蓝/紫色系等感知差异被低估，选色肉眼可见偏色。
- **建议**：
  - 活跃调色板 ≤48 色时用 **CIEDE2000**（感知更准，计算量可控）；
  - 全 291 色时先用**色相桶预筛**（Hue 分桶 + 亮/彩度近似），再对候选子集算 CIEDE2000；
  - 将色差函数做成可注入，便于单测。
- **验收**：新增"已知相近色对"单测，断言选色结果符合人工预期。

### 1.4 cover/contain 焦点控制 —— `src/components/CropDialog.tsx` + `src/domain/conversion.ts`
- **问题**：`cover`/`contain` 总是居中裁剪，人物面部、主体被切边。
- **建议**：裁剪对话框增加**焦点选择**（点击图片设定焦点，或按显著度自动检测），裁切时以焦点为锚点而非几何中心。
- **验收**：以人脸偏左的测试图验证裁切后主体完整。

### 1.5 抖动算法 —— `src/domain/conversion.ts`
- **问题**：Floyd-Steinberg 在 RGB 空间误差扩散并 clamp，色彩过渡区域易出现"脏点"；缺少有序抖动（Bayer）选项。
- **建议**：增加可选的**有序抖动（Bayer 4×4/8×8）**用于保留细节，并将误差扩散改为在感知空间（Lab/LCH）或至少对亮度通道做误差扩散，clamp 后回投误差（而非丢弃）。
- **验收**：渐变图对比两种抖动输出；新增像素统计单测。

### 1.6 中值滤波逐通道 —— `src/domain/simplify.ts`
- **问题**：逐通道中值可能产生原始色板不存在的"合成色"（虽然后续量化会纠正，但会引入噪声）。
- **建议**：改为"最近邻色板上的中值"：先量化到色板再取中值，保证中间色永远来自色板；或提供均值模糊选项。
- **验收**：对噪点图验证输出像素全部命中色板。

### 1.7 板型预设 —— `src/domain/boards.ts`
- **问题**：预设只有 52/104/156 针，而真实常见物理板为 29×29、50×50（方形板）、以及 52 针长条板；用户只能手动填，容易选错。
- **建议**：预设增加 29×29、50×50 等真实板型；当图像超过单板时提示"分板数"，按板生成多页。
- **验收**：选择 29×29 后，208×208 图应自动提示 7×7=49 板。

### 1.8 打印/PDF 按板分页 —— `src/domain/exporters.ts`
- **问题**：打印与 PDF 导出按图像整体输出，不按 52 针物理板分页，用户在实物上无法对应位置。
- **建议**：导出时按所选板型**分页**，每页一板，页眉标注"第 x 板 / 共 y 板 / 坐标范围"；PNG 导出可同时输出"整图 + 分板切片"。
- **验收**：52 针板导出 208×208 图得到 4×4=16 页。

### 1.9 草稿与项目计数 —— `src/domain/workbench.ts` / `App.tsx`
- **问题**："本机草稿"与正式项目被合在一起统计，存在双重计数，统计表（StatsTable）口径混乱。
- **建议**：统计范围增加来源过滤（全部/仅项目/仅草稿），并在界面明示口径。
- **验收**：创建 1 个项目 + 1 个草稿后，各口径数字正确。

### 1.10 小图约束 —— `src/domain/conversion.ts`
- **问题**：小于 8×8 的像素画会被强制放大到 8×8，破坏原图比例与像素点阵。
- **建议**：小于 8×8 时保持原尺寸或按最近整数倍放大，并提示"已按最近整数倍放大"。
- **验收**：5×5 输入不再被拉伸为 8×8 非整数倍。

---

## 2. 智能化（P1）

### 2.1 一键参数推荐
- `smooth / dither / maxColors / outline` 已有 `sampling: auto` 雏形，建议扩展为**按图类型自动推荐整套参数**：照片→平滑+多色+扩散抖动；像素画→无平滑+少色+有序抖动；线稿/动漫→自动描边。
- 在结果区显示"推荐参数"一键应用，并解释理由（如"检测到 8-bit 像素画"）。

### 2.2 一键自动抠图
- 上传缩略图上加"自动抠图"按钮：先用 1.2 的自适应背景去除做初步分割，辅以显著度（saliency）中心先验，一键生成透明底。

### 2.3 风格预设
- 提供 candy / dark / desaturated / neon 等预设：基于色相映射（hue shift）+ 饱和度/明度曲线 + 显著度保留（肤色、高光不被映射走样）。

### 2.4 库存差缺清单
- 新增"我的库存"输入（按色号计数），转换完成后自动输出 `需要量 − 库存 = 差缺清单`，并允许一键导出采购清单 CSV。

### 2.5 自动描边建议
- 对动漫/像素画自动检测高对比轮廓并建议 `outline` 参数，减少用户试错。

### 2.6 语义颜色保护
- 识别肤色/高光区域（亮度+色相先验），在调色/压缩色数时优先保留，避免脸部"花屏"。

---

## 3. UI（P1/P2）

### 3.1 高级设置渐进式披露 —— `src/components/SettingsPanel.tsx`
- **问题**：15+ 个控件平铺，认知负担大；多数用户只调"颜色数/尺寸"。
- **建议**（ui-ux-pro-max: 复杂度越高越需要渐进披露）：基础面板只放 3~5 个高频项；其余收进"高级选项"折叠区或分步 tab（尺寸 → 颜色 → 增强 → 导出）。
- 保留"恢复默认"一键重置。

### 3.2 emoji 当图标 → SVG 图标
- **问题**：按钮用 ✂️✎⚙↓＋× 等 emoji 作图标，跨平台渲染不一致、视觉廉价，且 emoji 不是可换色图标（ui-ux-pro-max 也将其列为需要规避的粗糙做法）。
- **建议**：引入统一线性 SVG 图标集（如 lucide-react 或手写 24×24 SVG），统一 stroke=1.5/2、圆角端点。

### 3.3 291 色面板整合 —— `src/components/PalettePanel.tsx`
- **问题**：色板面板在页面底部，与设置区割裂；用户改完色数后要滚动到底部才看到配色。
- **建议**：改为**可折叠抽屉/右侧栏**，贴近设置区；显示"本次使用 N/291 色"进度，未用色置灰。

### 3.4 设计标签画廊化 —— `src/App.tsx` 设计 tab
- **问题**：多设计 tab 只有文字，无法区分、无法重命名/排序。
- **建议**：改为缩略图画廊（每格显示成品缩略 + 参数摘要），支持重命名、拖拽排序、右键菜单（复制/重命名/删除/导出）。

### 3.5 表单控件统一
- **问题**：原生 select/range/checkbox 与整体视觉风格不一致。
- **建议**：统一自定义控件（轨道/滑块/开关样式），保持键盘可达与 `aria-*` 语义，不做纯视觉伪造。

### 3.6 转换进度与取消
- **问题**：大图转换无进度、无取消，worker 跑 10 秒+ 时界面"假死"。
- **建议**（ui-ux-pro-max: 操作 >300ms 必须给反馈）：worker 分块上报进度事件，UI 显示百分比与"取消"按钮（AbortController）；历史任务列表可查看状态并重试。

---

## 4. UX 与无障碍（P1）

### 4.1 画布网格键盘操作 —— `src/components/DesignPreview.tsx`
- 用 `role="grid"` + `aria-rowcount/aria-colcount`，支持方向键移动光标、Enter/空格上色、Delete 擦除、`+`/`-` 缩放画布。
- 当前仅鼠标点击编辑，键盘用户完全无法使用（严重无障碍缺陷）。

### 4.2 触控目标尺寸
- **问题**：`.button.small`、模式切换按钮、缩放按钮等实际点击区 < 44px。
- **建议**（ui-ux-pro-max: Touch Target Size，High）：所有可点元素最小 **44×44px**，相邻目标间距 ≥ **8px**；移动端尤其要放大，视觉上可用 padding/伪元素扩大热区而不破坏视觉密度。

### 4.3 ARIA 语义修正
- 调色板按钮错误使用 `role="listitem"`（应为 `role="option"` 且容器 `role="listbox"`/`grid`，配合 `aria-selected`）。
- Workbench 模式按钮缺 `aria-pressed`（toggle 语义）；tab 需 `role="tab"` + `aria-selected` + 键盘方向键切换。

### 4.4 prefers-reduced-motion
- 全局 CSS：`@media (prefers-reduced-motion: reduce)` 关闭/降级动画与过渡；画布闪烁、加载动画遵守该偏好。

### 4.5 撤销/重做
- 支持 `Ctrl+Z` / `Ctrl+Shift+Z`（或 `Ctrl+Y`），画布编辑与参数变更都进入历史栈；上限 50 步。

### 4.6 草稿管理 UI —— `src/domain/workbench.ts`
- 现状最多 6 个草稿但无管理界面。增加"草稿"面板：重命名、删除、恢复为项目、查看参数快照。

### 4.7 错误反馈
- 错误框自动消失（5s）或提供关闭按钮；失败任务可"重试"；上传失败时在缩略图上标注失败原因而非仅顶部提示。

### 4.8 分享与品牌
- 补 `og:title/og:image/og:description` 与 Twitter Card meta；README 中"hero 截图"TODO 补一张成品演示图（PWA 需要真实截图素材）。

---

## 5. 工程化（P2）

### 5.1 拆分 App.tsx
- `App.tsx` 超 25KB、15+ 个 state/ref。提取 hooks：`useConversionWorker`（worker 生命周期/进度/取消）、`useDesignDrafts`（草稿 CRUD）、`useInventory`（库存与差缺）、`useProjectStats`（统计口径）。
- 目标：每个 hook <200 行，可单测。

### 5.2 Canvas 分层渲染 —— `src/domain/rendering.ts` / `DesignPreview`
- 现状：每编辑一格全量重绘。改为**离屏底图（背景/已完成格）+ 上层叠加层（当前格/预览格）**，编辑时只重绘叠加层；缩放/平移只做 transform。

### 5.3 草稿存储升级
- 现状：6 个草稿 × 208×208 矩阵存 localStorage，接近 5MB 配额风险。
- 建议：矩阵做 **RLE/游程编码**压缩后再存，或迁移 **IndexedDB**；写入防抖 500ms。

### 5.4 ErrorBoundary
- 根组件加 ErrorBoundary，worker 消息解析失败、渲染异常时给出可恢复界面而非白屏。

### 5.5 PWA 图标
- 现在仅 SVG 图标，安装到桌面/手机需要 PNG 192/512。用 sharp 或在线工具从 SVG 导出 PNG 192/512 + maskable。

### 5.6 测试补充
- worker 生成"竞态"测试（快速切换参数时旧结果不得覆盖新结果）；
- 草稿持久化往返（save → reload → restore 等价性）；
- CSV/导出转义测试（色名含逗号/引号）；
- 键盘操作画布（Testing Library + user-event）。

---

## 6. 依据 ui-ux-pro-max skill 的关键条目对照

| 建议 | skill 条目 | 严重度 |
| --- | --- | --- |
| 触控目标 ≥44×44px、间距 ≥8px | ux-guidelines: Touch Target Size / Touch Spacing | High / Medium |
| 操作 >300ms 必须有加载反馈 | ux-guidelines: Loading Feedback（spinner/skeleton） | High |
| 表单输入必须有 label、提交必须有结果反馈 | ux-guidelines: Form Labels / Submit Feedback | High |
| 控件按复杂度渐进披露、减少平铺 | ux-guidelines 复杂度管理 | — |
| Pixel Art 风格：limited palette、`image-rendering: pixelated`、无抗锯齿、像素化字体/边框 | styles: Pixel Art（Canvas 10/10 兼容） | — |
| 动画遵守 prefers-reduced-motion | styles: Kinetic Typography 检查项（Accessibility ❌ Poor 的反例） | — |

> 检索命令示例：`python "C:\Users\Administrator\.codex\skills\ui-ux-pro-max\scripts\search.py" "touch target size accessibility" --domain ux -n 3`

---

## 7. 实施顺序与验证

1. **P0-1 转换正确度**（1.1~1.3 优先，1.4~1.8 次之）：每项补单测，跑 `npm test` + `npm run build`。
2. **P1-1 智能化**（2.1、2.4 收益最高，改动集中在 `domain/`，风险低）。
3. **P1-2 UI/UX**（3.2 SVG 图标、3.1 渐进披露、4.2 触控目标、4.1 键盘画布）。
4. **P2 工程化**（5.1 拆 hooks 是后续所有改动的地基，可提前；5.3 存储升级需在草稿管理 UI 前做）。
5. 发布前：`npm run build` + PWA 预检（PNG 图标、manifest、离线缓存清单）。

---

## 8. 环境与状态记录（2026-08-02）

- **ui-ux-pro-max skill 已全局安装**：`C:\Users\Administrator\.codex\skills\ui-ux-pro-max\`（含 `SKILL.md`、`data/`、`scripts/`），所有 Codex session 均可加载使用（本 session 已验证 `search.py` 可运行）。
- 安装方式说明：仓库 `cli/` 模板按 Codex 规范生成的 `SKILL.md`；全局路径已改写为 `~/.codex/skills/`；未使用 `uipro-cli`（npm 上的 2.2.3 缺少 `--global` 参数，仓库代码为 2.5.0 未发布）。
- **冗余克隆已删除**：原 `C:\Users\Administrator\.codex\skills\ui-ux-pro-max-skill\`（git 克隆、无顶层 SKILL.md，Codex 不会加载）已于今日删除，原因：占用约 5MB 空间、冗余残留。删除前已校验路径在 `skills` 目录内；删除时遇到 git 包文件只读属性，已先清除 `ReadOnly` 再删。
- 当前 `C:\Users\Administrator\.codex\skills\` 下有效条目：`.system`、`chatgpt-apps`、`ui-ux-pro-max`、`unity-mcp-skill`。
- 使用 skill 的注意点：检索脚本为 `python scripts/search.py "<query>" --domain <style|ux|color|typography|charts> -n N`；UI 改动前先检索对应主题，输出设计 token/组件级建议并匹配本项目现有架构（不要引入框架迁移）。

- **发布记录（2026-08-03）**：`npm run build` 产物经 `/usr/local/bin/promote-release.sh` 原子发布至 `/var/www/image2pindou`（备份 `image2pindou.backup-20260803-022716`）；`nginx -t` 通过、`systemctl reload nginx` 成功；线上验证 HTTP/2 200、新版 manifest（192/512 PNG + maskable）、OG 绝对 URL、全部 hash 资源 200。
- **冗余克隆确认**：`ui-ux-pro-max-skill\` 克隆目录已删除（2026-08-02 记录），全盘复查（E:\、C:\Users、D:\ 根）无残留；全局唯一有效安装为 `C:\Users\Administrator\.codex\skills\ui-ux-pro-max\`。

