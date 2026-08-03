# 后续迭代详细文档（ITERATIONS）

> 本文档是 `deepseek-version-optimize.md` 中「未实施」项的**可落地规格**：每项给出现状、目标、实现方案（文件触点）、
> 验收标准与风险，供任意后续 session / 开发者直接按章节实施。状态以实施后更新为准。
>
> 当前基线：`npm test` **162/162**（11 文件）、`npm run build` 成功；Round 3 commit `f10ffe6` 已发布至 `https://pindou.fanni-panda.com`。2026-08-03 亚古兽去背/推荐修复已通过本地真实浏览器回归，尚待提交与发布（见 `docs/DEVLOG.md`）。

---

## 0. 迭代工作流（每次迭代必须遵守）

1. **开工前**：先 `git pull`，读 `docs/DEVLOG.md` 与本文档相关章节。
2. **改动范围**：遵守「最小写集」，优先抽 `src/domain/` 纯函数并配单测；UI 改动沿用现有 design token 与 SVG 图标体系。
3. **测试**：新逻辑必须补 Vitest 用例（`src/test/*.test.ts`）；跑 `npm test` 全量回归。
4. **构建**：`npm run build`（含 `tsc -b` 类型检查）必须成功。
5. **浏览器冒烟**：`npm run preview` 后 Playwright 验证关键路径（见 DEVLOG §0），要求**零 console/page error**。
6. **提交推送**：`git commit` + `git push origin main`（分支默认 `main`，若需实验分支用 `codex/` 前缀）。
7. **发布**：按 DEVLOG §0 流程 `promote-release.sh` 部署并做线上验证。
8. **文档**：更新本文档状态、`deepseek-version-optimize.md` 状态表、`docs/DEVLOG.md` 新增条目。

**全局验收闸门**（任何迭代合入前）：`npm test` 全绿 + `npm run build` 成功 + 冒烟零报错 + 线上 hash 资源全部 200。

---

## 1. 转换正确度（P0 遗留）

### 1.4 cover/contain 焦点控制（P1，✅ 2026-08-03 已发布）

- **现状**：`src/components/CropDialog.tsx` 的 cover/contain 总是几何居中裁剪，主体（人脸/主体物）偏一侧时会被切边；仅做了 UI 层优化，焦点算法未深改。
- **目标**：裁剪以「焦点」为锚点而非几何中心。
- **方案**：
  1. 焦点来源 A（手动）：在裁剪预览图上点击设定焦点（十字标记）。
  2. 焦点来源 B（自动）：显著度先验 —— 对降采样图计算边缘密度/饱和度加权热区，或复用 `@imgly/background-removal` 的 alpha 掩码取前景质心；无显著前景时回退几何中心。
  3. 在 `src/domain/conversion.ts` 或新 `src/domain/focus.ts` 实现纯函数 `computeCropRect(source, focus, mode, targetAspect)`：给定焦点像素坐标与 cover/contain 模式，返回裁剪窗口，保证焦点落在窗口内的黄金分割位置附近，且窗口不越界。
  4. CropDialog 展示焦点与最终窗口预览。
- **验收**：人脸偏左 25% 的测试图，cover 模式裁剪后主体完整（人脸中心在窗口内）；`focus.ts` 单测覆盖越界/极角/等比缩放情形。
- **风险**：显著度自动检测可能误判；手动焦点优先级最高，自动仅为默认值。
- **实施结果**：新增 `src/domain/focus.ts`；cover 采样与 CropDialog 共用自动/手动焦点及裁剪窗口。对话框支持点击、方向键、恢复自动焦点和最终窗口预览，手动框选保持最高优先级。
- **验证**：`focus.test.ts` 7 例覆盖 contain、等比例、黄金分割、极角钳制、平坦图回退、偏侧显著主体和 cover 重采样；`crop-dialog.test.tsx` 覆盖指针与键盘交互。

### 1.9 草稿与项目计数口径（P1，✅ 2026-08-03 已发布）

- **现状**：统计表（`src/components/StatsTable.tsx`、`App.tsx` 项目总用豆）把「本机草稿」与正式项目合在一起统计，口径不透明。
- **目标**：统计来源可过滤（全部 / 仅项目 / 仅草稿），界面明示口径。
- **方案**：
  1. `App.tsx` 中 `projectTotals` 计算处增加 `sourceFilter` state（`"all" | "projects" | "drafts"`）。
  2. 草稿与项目的判别已存在于 `localDraftIdsRef`，据此过滤后再聚合。
  3. StatsTable 表头旁加口径切换（segmented control），aria-label 注明当前口径与计数含义。
- **验收**：创建 1 个项目 + 1 个草稿后，三种口径数字分别正确；单测覆盖 `aggregateCounts(filter)` 纯函数。
- **风险**：低。注意与 2.4 库存差缺联动（差缺应只对当前口径的 needed 计算）。
- **实施结果**：新增 `src/domain/projectStats.ts`；项目总用豆增加“全部 / 项目 / 草稿”口径切换，首页计数、库存差缺和采购 CSV 均使用筛选后的聚合结果。
- **验证**：`project-stats.test.ts` 4 例覆盖来源判别、三种聚合口径、计数和无效数量；真实浏览器验证 1 个项目在“项目”为 1、“草稿”为 0，切回“全部”为 1。

---

## 2. 智能化（P1 遗留）

### 2.2 自动抠图增强（P2，🟡 纯色底正确度部分完成）

- **现状**：复杂背景自动走 `@imgly/background-removal`（WASM，24MB 懒加载），简单纯色背景走 `src/domain/backgroundRemoval.ts` 自适应泛洪；裁剪入口已提供智能去背景，但上传缩略图仍无独立「一键抠图」入口，复杂掩码也无显著度中心先验。
- **目标**：上传入口提供「自动抠图」按钮；分割结果更稳。
- **方案**：
  1. `UploadPanel.tsx` 每张缩略图加「自动抠图」操作（复用现有转换管线里的 `removeBackground`）。
  2. 增强：边缘引导 + 显著度中心先验 —— 对 WASM alpha 掩码做形态学开运算去孤立噪点，再以图像中心先验修正离群前景（离中心极远的连通域若面积占比小则剔除）。
  3. 抽纯函数 `src/domain/mask.ts`：`refineMask(mask, {centerPrior, minAreaRatio})` 并单测。
- **验收**：带杂点的抠图测试图，修正后前景掩码连通、无孤立噪点；`mask.ts` 单测覆盖噪点剔除/中心先验。
- **风险**：WASM 首次加载慢（24MB）——保留懒加载与进度提示；不要在首屏预取。
- **2026-08-03 部分实施**：纯色路径新增高饱和封闭背景孔洞识别，解决动漫黑色轮廓围住蓝/绿背景后残留的问题；用面积阈值保留微小主体同色细节，并禁用于白色等中性底。透明像素关闭保留时统一先合成白底，避免隐藏 RGB 产生黑底。剩余工作仍是独立上传入口和复杂 WASM 掩码的中心先验/形态学细化。
- **验证**：新增合成色键孔洞、中性白底主体细节和透明量化回归；真实 `亚古兽.jpg` 去背后封闭蓝底消失，智能推荐后保持透明且无黑底。

### 2.5 自动描边建议（P2，✅ 2026-08-03 已发布）

- **现状**：`outline` 参数需手动开启；动漫/像素画开启后效果好，但用户不知道何时该开。
- **目标**：自动检测高对比轮廓并「建议」开启 outline（不强制，展示在智能推荐差异列表）。
- **方案**：
  1. `src/domain/recommend.ts` 的 `analyzeSource` 增加轮廓占比指标：降采样后对亮度梯度做阈值统计（复用 `edgeSharpness` 思路，另算「强对比轮廓占比」）。
  2. `recommendSettings` 增加 `outline` 推荐分支：强轮廓且非照片 → `outline: true`；推荐框将自动出现「描边 关 → 开」差异项。
  3. 若用户手动已开，则不提示。
- **验收**：高对比动漫线稿测试图推荐 `outline:true`；纯照片不推荐；新增单测断言两类输入。
- **风险**：低；阈值需调参避免误报（可用回归测试图固化）。
- **实施结果**：`analyzeSource` 新增强对比轮廓占比；`recommendSettings` 仅对高轮廓、非照片素材建议开启描边，照片和低轮廓素材保持关闭，差异沿用智能推荐面板展示。
- **验证**：`domain-recommend.test.ts` 新增高对比线稿与照片两类回归断言。

### 2.6 语义颜色保护（P2，未开始）

- **现状**：压缩色数时（`maxColors`）肤色/高光等小面积但重要的区域可能被大区域同化，导致脸部「花屏」或高光丢失。
- **目标**：识别肤色/高光区域并优先保留其主色。
- **方案**：
  1. `src/domain/simplify.ts` 或新 `src/domain/saliency.ts`：亮度+色相先验标记「保护区域」像素（肤色：Lab a/b 范围；高光：L 高且饱和度低）。
  2. 调色板构建时，对保护区域颜色赋予加权票（现有显著度感知已对「高对比稀有色」留预算，扩展为含肤色/高光）。
  3. 纯函数 + 单测：构造含肤色的合成图，断言压缩后肤色桶保留。
- **验收**：合成「大背景 + 小面积肤色块」图，`maxColors=8` 时肤色主色仍在最终色板；单测覆盖。
- **风险**：肤色先验在卡通/滤镜下可能失效；只做「优先保留」，不强制，可被用户手动覆盖。

---

## 3. UI/UX（P1 遗留）

### 3.4 设计标签画廊化（P2，未开始）

- **现状**：`App.tsx` 的设计标签（`.design-tabs`）为紧凑列表 + 移除按钮，多图时信息密度低。
- **目标**：多设计以缩略图画廊呈现，状态（转换中/完成/草稿）一目了然。
- **方案**：
  1. 用现有 `design.previewUrl`/生成图 dataURL 做缩略图；网格布局，标签显示文件名 + 状态 badge（转换中进度环、草稿徽标、错误态）。
  2. 保持键盘可达（方向键切换标签）+ ARIA tablist 语义；触控目标 ≥44px。
  3. `prefers-reduced-motion` 下禁用动画。
- **验收**：5 张图上传后画廊可滚动切换；键盘操作可用；现有 `app.test.tsx` 不回归。
- **风险**：中。改动面集中在标签渲染层，避免动转换/草稿逻辑。

### 3.5 表单控件统一（P2，部分完成）

- **现状**：随 3.1 渐进披露已统一大部分，但仍有零散原生控件样式不一致（如裁剪对话框、高级选项内滑块）。
- **目标**：全部输入控件对齐 design token（focus-visible 轮廓、禁用态、数值输入 spinners 隐藏或统一样式）。
- **验收**：全站表单控件样式一致；触控目标、对比度满足既有规范。

---

## 4. 工程化（P2 遗留）

### 5.1 App.tsx hooks 化（P2，domain 层已拆，hooks 未做）

- **现状**：`src/domain/drafts.ts`、`src/domain/conversionCoordinator.ts` 已把纯逻辑抽出（Round 2），但 `App.tsx`（约 755 行）仍集中大量 state/ref/effect。
- **目标**：拆出可单测 hooks：
  - `useConversionWorker`（worker 生命周期/进度/取消，内部用 `conversionCoordinator` 状态机）；
  - `useDesignDrafts`（草稿 CRUD + 持久化）；
  - `useInventory`（库存 + 差缺，内部用 `shortfall.ts`）；
  - `useProjectStats`（统计口径，配合 1.9）。
- **验收**：每个 hook <200 行；App.tsx 净减 150+ 行；`npm test` 全绿（hooks 用 Testing Library `renderHook` 覆盖关键路径）。
- **风险**：中。必须保持行为逐字节等价——先纯重构（不动 JSX），再跑冒烟对比截图/交互。

### 5.2 Canvas 分层渲染（P2，未开始）

- **现状**：`src/components/DesignPreview.tsx` 每编辑一格全量重绘。
- **目标**：离屏底图（背景/已完成格）+ 上层叠加层（当前格/预览格），编辑只重绘叠加层；缩放/平移仅 transform。
- **验收**：200×200 图逐格编辑无明显卡顿；像素级截图对比新旧渲染一致（可用合成图回归）。
- **风险**：中。注意 worker 生成大图时的内存占用；保持 `image-rendering: pixelated`。

### 5.3 IndexedDB 草稿持久化 + RLE（P2，未开始）

- **现状**：最多 6 份草稿 × 208×208 矩阵以 JSON 存 localStorage，接近 5MB 配额风险。
- **目标**：存储升级到 IndexedDB，写入防抖 500ms；矩阵 RLE 压缩。
- **方案**：
  1. 新 `src/domain/draftStorage.ts`：IndexedDB 封装（版本化 schema、`get/set/delete/clear`、Promise API），`drafts.ts` 的 `loadDesignDrafts/persistDesignDrafts` 改为异步并接 IndexedDB，localStorage 仅作兼容回退。
  2. `serializeDraft` 改为 RLE（色号连续段编码），新增 `deserializeDraft` 对称解压；保持导出 `serializeDraft/deserializeDraft` 签名向后兼容。
  3. App 内持久化 effect 防抖 500ms。
- **验收**：创建 6 份大草稿后刷新不丢、localStorage 不再超限；往返测试（save → reload → restore 等价）用 208×208 随机矩阵验证；`draftStorage.test.ts` 覆盖 RLE 编解码（含全同色/全异色边界）。
- **风险**：IndexedDB 异步化会触碰 App 启动路径，先做兼容层再切；注意 PWA 无痕模式配额。

---

## 5. 排期建议

| 批次 | 项 | 预估 |
|---|---|---|
| ✅ 已完成 A（Round 3，已发布） | 1.4 焦点控制、1.9 计数口径、2.5 自动描边 | 156/156 + build + 线上浏览器冒烟通过 |
| 下一轮 B | 5.1 hooks 化 + 5.3 IndexedDB/RLE（先 A 后 B，避免并发触碰 App.tsx） | 1 个 sub-agent（工程化域） |
| 下一轮 C | 3.4 画廊化、3.5 表单统一 | 1 个 sub-agent（UI 域） |
| 后续 | 2.2 抠图增强剩余项、2.6 语义颜色保护、5.2 Canvas 分层 | 按需排期 |

> 并行约束：**同一批次内写集不重叠**。A 动 `domain/conversion|recommend` 与 `CropDialog`；B 动 `App.tsx` 与 `domain/draftStorage`；
> C 动组件渲染层。三者可并行，但 B 完成后需全量回归 + 浏览器冒烟（App.tsx 重构风险最高）。
