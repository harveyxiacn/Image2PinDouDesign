# 拼豆图纸工坊 · 开发日志（DEVLOG）

> 本文档按时间线记录本项目的功能迭代、测试/构建基线、发布与回滚备份，并附「环境与命令速查」。
> 配套文档：
> - `deepseek-version-optimize.md` —— 优化方案全文与实施状态（含 ui-ux-pro-max skill 依据）
> - `docs/ITERATIONS.md` —— 后续迭代的详细规格与验收标准
> - `design.md` / `docs/superpowers/` —— 原始设计文档与早期实现计划

---

## 0. 环境与命令速查

| 项目 | 值 |
|---|---|
| 仓库 | `https://github.com/harveyxiacn/Image2PinDouDesign.git`（分支 `main`） |
| 本地工作目录 | `E:\Project\Image2PinDouDesign` |
| 生产域名 | `https://pindou.fanni-panda.com` |
| 生产服务器 | VPS `203.0.113.20`（hostname `web-host`） |
| SSH 登录 | `ssh -i C:\Users\<user>\.ssh\deploy_ed25519 root@203.0.113.20` |
| 站点目录 | `/var/www/image2pindou`（nginx 静态托管） |
| 发布脚本 | 服务器 `/usr/local/bin/promote-release.sh`（镜像见本仓库 `deploy/promote-release.sh`） |

**常用命令：**

```bash
npm test                 # Vitest 全量回归（当前本地 14 个文件 / 181 用例）
npm run build            # tsc -b + vite build → dist/（PWA 预缓存）
npm run dev              # 本地开发 http://localhost:5173
npm run preview          # 本地预览构建产物（默认 4173 端口）
```

**标准发布流程（已在 Round 1 / Round 2 / Round 3 验证）：**

```powershell
# 1) 本地构建并校验
npm test; npm run build
# 2) 打发布包（勿用 Remove-Item；用唯一时间戳目录避免清理）
$rel = "image2pindou-release-r2-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -Recurse dist $rel
scp -i C:\Users\<user>\.ssh\deploy_ed25519 -r $rel root@203.0.113.20:/tmp/
# 3) 服务器原子切换（自动备份 + nginx -t + reload，失败自动回滚）
ssh -i C:\Users\<user>\.ssh\deploy_ed25519 root@203.0.113.20 \
  "/usr/local/bin/promote-release.sh /tmp/$rel /var/www/image2pindou"
# 4) 线上验证：首页 200、HTML 内 hash 资源全部 200、manifest/图标 200
```

**线上验证要点**（Round 2 使用的脚本骨架，直接在服务器执行）：

```bash
base=https://pindou.fanni-panda.com
curl -sI -o /dev/null -w "%{http_code} %{content_type}\n" $base/
html=$(curl -s $base/)
echo "$html" | grep -oE '/assets/[A-Za-z0-9._-]+\.(js|css)' | sort -u
# 逐个 curl 校验 200；再校验 /manifest.webmanifest /pindou-512.png /registerSW.js /sw.js
```

**回滚**：`promote-release.sh` 每次发布都会把旧站点改名备份为
`/var/www/image2pindou.backup-<UTC时间戳>`；如需回滚，把备份 `mv` 回 `image2pindou`
并 `systemctl reload nginx` 即可（脚本自带 ERR trap 自动回滚失败的发布）。

---

## 1. 2026-05-29 · 项目启动与核心转换器

- **Commits**：`04dbb60`（scaffold Vite+React+TS+PWA）、`ef14ff4`（核心转换器）、`d697f2c`（部署配置）、`662d5b3`（设计文档）
- **内容**：
  - 图片 → 拼豆图纸全链路：**CIEDE2000 感知色差**、291 色 MARD 色卡、Web Worker 离主线程转换、裁剪/AI 抠图、降噪、去白底、打印按板分页。
  - 纯客户端架构（图片不上传），PWA 可离线安装。
- **产出文档**：`design.md`、`docs/superpowers/plans/2026-05-27-pindou-designer.md`、`docs/superpowers/specs/2026-05-27-pindou-designer-design.md`。

## 2. 2026-07-15 ~ 07-16 · 功能迭代期

- **Commits**：`839ca53`（抠图/描边/部署改进）、`76baee7`（移动端查看与导出）、`ec095af`（智能像素画转换）、`9fb9a46`（交互式图纸工作台）、`5709e49`（编辑入口易发现修复）
- **内容**：像素画网格恢复（放大图还原逻辑格）、显著度感知调色板、亮度/对比度/饱和度调节、Floyd-Steinberg/Bayer 抖动、工作台重绘/擦除/取色/撤销重做/镜像、键盘逐格导航、移动端「完成一格少一颗」辅助、本地草稿（最多 6 份）、项目级豆量汇总、CSV/PNG/打印导出。

## 3. 2026-08-02 · 第一轮全面优化（Round 1）

- **Commits**：`29cd7bb`（feat）+ `2af02a0`（docs）
- **方式**：三个并行 sub-agent —— 转换正确度 / UI 视觉 / 交互工程化。
- **内容**：
  - 转换正确度：半透明边缘去污染、自适应背景去除（ΔE 泛洪）、CIEDE2000 回归固化、Bayer 抖动选项、色板域中值滤波、29×29/50×50 板型预设、打印按板分页、小图约束。
  - UI：SVG 图标体系（18 个）、设置面板渐进披露、291 色面板折叠整合、转换进度+取消、触控目标 ≥44px、`prefers-reduced-motion`。
  - UX/无障碍：画布键盘操作、撤销/重做快捷键、ErrorBoundary、OG/品牌 meta、PNG 192/512 + maskable PWA 图标。
- **质量门**：`npm test` **71/71 通过**、`npm run build` 成功。
- **skill 安装**：`ui-ux-pro-max` 全局安装至 `C:\Users\<user>\.codex\skills\ui-ux-pro-max\`（所有 session 可加载）；冗余克隆 `ui-ux-pro-max-skill\` 已删除。
- **部署 #1**：备份 `/var/www/image2pindou.backup-20260803-022716`，nginx -t + reload 通过，线上验证 HTTP/2 200、manifest/图标/OG 正常。

## 4. 2026-08-02（晚）· 第二轮优化（Round 2）

- **Commit**：`ab6eb10`（`feat: smart recommendations, style presets, inventory shortfall, and testable state machines`）
- **方式**：三个并行 sub-agent —— 智能化 / 工程化 / UI 集成。
- **内容**：
  - 智能化：`src/domain/recommend.ts`（`analyzeSource` 降采样分析 → 像素画/照片分类 → `recommendSettings` 全参数推荐；4 个风格预设）、`src/domain/shortfall.ts`（库存 v2 按色号计数、localStorage 持久化、v1 自动迁移、差缺计算）。
  - 工程化：`src/domain/drafts.ts`（草稿序列化纯模块）、`src/domain/conversionCoordinator.ts`（转换竞态/取消状态机）、`src/domain/exporters.ts` CSV 转义导出、`App.tsx` 机械重构**净删 81 行**（UI 零漂移）。
  - UI 集成：设置面板「风格预设」chips +「✨ 智能推荐」差异一键应用；色板库存交互 +「项目用色记为库存」；统计表新增「已有/差缺」列（差缺红色高亮）。
  - 测试：新增 71 个用例（recommend/shortfall/drafts/conversion-coordinator/exporters）。
- **质量门**：`npm test` **142/142 通过**（8 文件）、`npm run build` 成功（PWA 预缓存 13 项 / 396.56 KiB；入口 `index-c14KWk2-.js` + `index-CwGCiFS-.css`，抠图懒加载 chunk `index-LLYB6zQB.js`）。
- **浏览器冒烟**（Playwright + chromium-1169，本地 preview + 生产域名各一轮）：预设切换、上传 32×32 图、智能推荐出现并可一键应用、库存差缺 677→672→"—" 联动正确，**零 console/page error**。
- **部署 #2**：备份 `/var/www/image2pindou.backup-20260803-025904`，nginx -t + reload 通过，线上新 hash 资源全部 200。
- **文档**：`deepseek-version-optimize.md` 已标记 2.1/2.3/2.4/5.1(partial)/5.6 完成并补部署记录。

## 5. 2026-08-02（深夜）· 第三轮优化（Round 3，已发布）

- **范围**：完成 `docs/ITERATIONS.md` 的下一轮 A（1.4 焦点控制、1.9 统计口径、2.5 自动描边建议），并在真实移动端视口回归中修复统计面板横向溢出。
- **内容**：
  - 焦点裁剪：新增 `src/domain/focus.ts`，以边缘/饱和度/透明边界/中心先验估计自动焦点；`computeCropRect` 按黄金分割附近锚定 cover 窗口并做边界钳制。裁剪对话框支持点击设置焦点、方向键微调、恢复自动焦点、手动框选优先，并预览最终裁剪窗口；转换器的 cover 采样同步改为焦点驱动。
  - 统计口径：新增 `src/domain/projectStats.ts`，项目总用豆支持“全部 / 项目 / 草稿”筛选；首页计数、库存差缺、采购 CSV 均跟随当前口径，界面明确显示来源与图纸数。
  - 智能描边：`src/domain/recommend.ts` 增加强对比轮廓占比分析，高轮廓且非照片的素材会在智能推荐中建议开启描边，照片保持关闭。
  - 移动端：统计筛选沿用 8px 间距与 44px 触控高度；为主列和统计面板补齐 `minmax(0, 1fr)` / `min-width: 0`，消除窄屏表格撑宽页面的问题。
- **质量门**：`npm test` **156/156 通过**（11 文件）；`npm run build` 成功（PWA 预缓存 13 项 / 405.60 KiB）。
- **浏览器冒烟**（Codex in-app Browser，本地 production preview）：上传真实 JPG、切换 cover、打开焦点裁剪、鼠标/键盘调整与恢复自动焦点、项目/草稿统计联动均通过；375px 视口无横向溢出，统计筛选按钮高度 44px，**零 console error**。
- **提交与发布**：commit `f10ffe6`（`feat: improve focal cropping, stats scope, and smart outlines`）已推送 `origin/main`；产物经 `promote-release.sh` 原子发布，回滚备份为 `/var/www/image2pindou.backup-20260803-041852`，`nginx -t` 与 reload 通过。
- **线上验证**：首页、`manifest.webmanifest`、Service Worker、192/512 图标及新入口 `index-BVBuuA4J.js` / `index-CCJAWTfH.css` 均为 HTTP 200；生产站真实图片上传、52×52 转换、cover 焦点裁剪、键盘微调和项目/草稿统计联动通过，**零 console error**。

## 5.1 2026-08-03 · 亚古兽去背 / 智能推荐缺陷修复（已发布）

- **问题**：高饱和纯色底被黑色主体轮廓封闭时，边缘 flood-fill 无法到达手脚之间的蓝底；去背像素的隐藏 RGB 为 `0,0,0`，智能推荐又会把照片的 `keepTransparent` 关闭，最终把透明区量化为整片黑色。
- **修复**：
  - `backgroundRemoval.ts` 在保留边缘连通泛洪的基础上，仅对高饱和纯色背景补清达到面积阈值的封闭同色块；中性白底和微小同色主体细节保持不动，补清后再次处理 JPEG 混色边。
  - `conversion.ts` 在用户手动关闭透明保留时先把半透明像素合成到白底，再参与限色与三种量化路径，彻底避免无意义的隐藏黑色 RGB 污染结果。
  - 智能推荐改为分析当前编辑图，所有推荐/预设默认保留透明空格；推荐卡补齐抖动算法、降噪、紧贴主体和透明空格等关键差异，避免静默改参。
- **质量门**：`npm test` **162/162 通过**（11 文件）；`npm run build` 成功（PWA 预缓存 13 项 / 406.87 KiB；主入口 `index-DSBQJR-B.js`、去背懒加载 chunk `index-CpwcNpUw.js`）。
- **真实回归**：本地 production preview 上传 `testimage/亚古兽.jpg` → 智能去背景 → 添加新图纸 → 一键应用智能推荐；手脚/身体间蓝底均变为透明棋盘格，推荐后无黑底，“保留 PNG 透明区域为空格”仍勾选，**零 console error**。
- **提交与发布**：commit `4933d72`（`fix: improve cutout transparency and recommendations`）已推送 `origin/main`；产物经 `promote-release.sh` 原子发布，回滚备份 `/var/www/image2pindou.backup-20260803-044634`。首次上传包目录权限为 `0700`，源站回归及时发现后已统一为目录 `0755` / 文件 `0644`，并将权限规范固化到发布脚本。
- **线上验证**：源站首页、主入口、去背 chunk、CSS、manifest、Service Worker 与 192/512 图标全部 HTTP 200；公网 PWA 自动更新到 `index-DSBQJR-B.js`。真实亚古兽线上去背与推荐流程通过，封闭蓝底消失、推荐后无黑底、透明开关保持勾选，**零 console error**。

## 5.2 2026-08-03 · 裁剪像素画智能尺寸修复（已发布）

- **问题**：从合照裁剪出的像素角色经过截图缩放后，基础像素格可能以 7/8px 交替出现；整数周期搜索只看到 15px 倍频，并且旧逻辑偏向最大的可信周期，导致智能尺寸把约 23×31 的角色错误缩成 11×15。推荐分析使用 64px 缩略图时还会与转换器产生“照片 / 像素画”分类分歧。
- **修复**：像素周期检测改为优先最强基础周期，并识别双相位半周期以恢复 7.5px 等非整数像素格；推荐分析与转换器共用结构化像素画检测；智能板型下新增可访问的尺寸说明，明确实际逻辑格数与“52 针为上限”。
- **质量门**：`npm test` **166/166 通过**（11 文件）；`npm run build` 成功（PWA 预缓存 13 项 / 411.48 KiB；主入口 `index-BCt6leN2.js`、CSS `index-BGRK9mwY.css`、Worker `conversion.worker-pk1enJnj.js`）。
- **真实回归**：本地与生产站上传从用户合照裁出的实际角色图，默认智能尺寸均恢复为 **23×31**；推荐改为“像素锐利”，应用推荐后仍保持 23×31，尺寸说明正确显示，**零 console error**。
- **提交与发布**：commit `88e68d3`（`fix: recover smart size for cropped pixel art`）已推送 `origin/main`；产物经 `promote-release.sh` 原子发布，回滚备份 `/var/www/image2pindou.backup-20260803-222001`。
- **线上验证**：公网首页、新入口/CSS、转换 Worker、抠图懒加载 chunk、manifest、Service Worker 与图标全部 HTTP 200。旧 PWA 标签首次命中历史预缓存，自动更新并刷新后切换到新入口，真实交互回归通过。

---

## 5.3 2026-09-07 · 角色原图多尺寸精细图纸（已发布）

- **需求**：用户明确示例是生成效果参考，主要输入角色原图，而不是已有图纸截图。实现原图特征分析与精细转换，不做 OCR 或语义重绘。
- **实现**：按主体比例的多档尺寸与 1–208 自定义；智能上限 156 / 非像素默认长边 104；独立图片设置与尺寸副本；角色主色/细轮廓采样；基于频率及 Lab 色差的多样性限色；错相像素边界采样。
- **导出**：PNG 增加四边逐格坐标、5 格辅助线、物理分板线、色号与用豆图例。完整图例纳入 2400 万像素预算，旧草稿无分板配置时兼容回退 52。
- **质量门**：全量 **181/181**（14 文件）通过，`npm run build` 成功（PWA 13 项 / 421.47 KiB；主入口 `index-Brho2DzG.js`、Worker `conversion.worker-DXOZidQF.js`）。新增测试 15 个；未改动依赖。
- **实图回归**：本地生产构建上传亚古兽并去背景，生成 156×138 / 32 色，绿色眼睛保留；复制后设为 57×60，原版本保持 156×138。PNG 实际下载 4960×4631，四边尺与清单可读。太一上传为 50×104；375px 窄屏尺寸按钮和编辑界面可用，文档宽度等于可视宽度，浏览器日志无错误。
- **验证中发现并修复**：固定步长采样漏掉像素边界；旧限色让眼睛绿色被大量相似黄/肤色挤掉；导出预算遗漏多行用色清单；取消结果到达时必须读取最新协调器状态。
- **UI**：按 ui-ux-pro-max 的表单标签、选择反馈和渐进披露建议，沿用现有 token，增加当前图片作用域、尺寸/最大用豆提示与可访问选中态。
- **提交与发布**：`a51df85`（`feat: generate detailed character patterns in independent sizes`）已推送 `origin/main`；构建产物通过现有 `promote-release.sh` 发布到 VPS，回滚备份 `/var/www/image2pindou.backup-20260907-004236`。Nginx 配置检查和重载成功，服务 active，首页、主入口、CSS、Worker 的 SHA-256 与本地构建一致。参考图及生成样例未进入仓库。
- **线上验证**：首页、PWA 文件、图标和全部新版 assets 均返回 HTTP 200，WASM/MJS MIME 正确（一次请求超时，复查通过）。线上实图上传、去背景、156×138 / 32 色生成通过，绿色眼睛保留，控制台无错误。旧 PWA 首次命中历史缓存，刷新后确认切换新界面；未清除用户草稿或库存。
- **已知限制**：分类是特征启发式；复杂背景边缘和低清压缩图仍可能需要逐格修改；不承诺生成与人工设计相同的针数、配色和结构。

## 5.4 2026-10-29 · 像素化管线 + 拼豆板针数选择 + 界面改版（未提交 / 未发布）

- **算法**：
  - 显式“像素化”阶段：转换结果附带色号匹配前的每格颜色（`BeadDesign.pixelated`，不写入草稿），预览可在「原图 / 像素化」间切换。
  - 边缘感知像素化（`sampleEdgeAware`，照片/面积模式默认开启）：格子 3×3 子块面积平均后做 2-均值，跨强边缘时取主色簇、保留占比足够的深色轮廓，消除普通平均产生的过渡色晕；渐变与平涂区域与原面积平均逐值一致。
  - 新 `src/domain/beadCleanup.ts`：孤豆清理（8 邻域无同色、内部格、CIEDE2000 ≤ 20 才并入邻色，默认开，像素画/抖动不处理）与零散色合并（< 3/6/10 颗且有 ΔE ≤ 24 的常用色时并入，默认关）。
- **拼豆板针数**：`boards.ts` 新增单板针数（29/50/52/自定义 10–104）与横 × 纵拼板块数（单边 ≤ 208 针）、按图片比例排板；`settings.ts` 新增 `resolveBoardLayout/resolveBoardSize/resolveTilePins`，旧板型预设（52/104/52x104/156…）自动换算回显。所有尺寸方式下分板粗线与打印分页都按所选针数。
- **界面**：紧凑顶栏 + 四步流程指示；`BoardPicker`（针数分段选择、智能比例/按拼豆板/自定义、步进器、拼板示意与主体占位、成品厘米估算）；`Segmented` 通用分段控件替换色数/适配/降噪下拉；`DesignGallery` 缩略图画廊（生成中占位/草稿标记）；生成步骤条；拖拽投放区状态；新图纸逐行揭示、拼豆加载指示、空状态落豆插画；全部动效在 `prefers-reduced-motion` 下关闭。
- **验证**：`npm test` 15 文件 / 190 例全绿（新增 `bead-pipeline.test.ts` 9 例；`detail-design` 轮廓用例改为分别断言普通平均与边缘感知）；`npm run build` 成功；本地 production preview + 无依赖 CDP 冒烟脚本（`.agents/smoke/cdp-smoke.mjs`，本机 Edge headless）上传亚古兽实图 → 生成 104×90 → 像素化对比 → 29 针 2×2 拼板（58×58）全链路，零 console/page error，390px 视口无横向溢出。

## 5.5 2026-11-03 · 按 mard_color_sheet 核对色卡 + 色卡套装选择

- **来源**：`mard_color_sheet/mard_color_sheet.jpg`（A1–A26、B1–B32、C1–C29、D1–D26、E1–E24、F1–F25、G1–G21、H1–H23、M1–M15，共 221 色）。逐项转录后与图中色块像素交叉核对，并与原色卡比对：221 个色号的 HEX 与原数据完全一致。
- **色卡结构**：`MARD_221_SEEDS`（标准 221 色）+ `MARD_EXTENDED_SEEDS`（T1、P、Q、R、Y、ZG 共 70 色）= `MARD_PALETTE` 291 色，显示、统计、导出与草稿校验都按 291 色查色。
- **色卡套装**：新增 `src/domain/paletteKits.ts`，套装就是一份色号清单；色卡面板可选“MARD 221 色”（默认）或“MARD 291 色”，选择保存在本机。生成图纸只用套装内颜色；库存模式时取“套装 ∩ 库存”，交集为空回退整套。设置面板的色数提示显示当前套装。
- **待补**：市售 24/48/72/96/120/144/168/265/295 色等套装尚无可靠的色号清单，拿到商品色号表后在 `PALETTE_KITS` 追加即可，不按数量臆造。
- **验证**：新增 `mard-palette.test.ts`（221 色号序列、各系列 HEX 抽检、291 色完整性、套装默认/记忆、套装 ∩ 库存、套装外颜色不参与匹配、库存过滤）。

## 5.6 2026-11-03 · 界面架构重排：欢迎页 + 三栏工作台（未提交）

- **Brief（事实）**：用户是拼豆爱好者，桌面和手机都用；核心任务是“上传 → 得到能照着拼的图纸 → 调尺寸/颜色 → 导出打印、按清单买豆”。旧版首屏同时堆出整列设置、221 色色卡和两张空统计表，左栏高度约为主栏 3 倍，图纸只占中间一张卡片。
- **架构（选择）**：
  - 无图纸时显示 `WelcomeScreen`：只突出上传，并可先选拼豆板针数和色卡套装；三步说明“像素化 / 匹配色号 / 编辑与导出”。
  - 有图纸后进入三栏工作台：左“我的图纸”栏（添加图片 + 缩略图列表）、中间舞台（`DesignPreview`）、右侧 `Inspector` 标签页“尺寸 / 颜色 / 效果 / 用豆”，只渲染当前页；智能推荐固定在检查器顶部。
  - `SettingsPanel` 拆成 `SizeSettings / ColorSettings / EffectSettings / RecommendationCard` 分区，原组合组件保留。色卡与库存移入 `Dialog`（色卡网格不再常驻页面），“颜色”页提供套装选择、库存模式开关和“查看色卡 / 管理库存”入口。
  - ≤1180px：图纸栏变为顶部横向条，舞台 + 检查器两栏；≤900px 单列，底部导航（图纸 / 尺寸 / 颜色 / 效果 / 用豆）切换检查器标签并滚动到位。
- **交互契约**：
  - 整窗拖放（`DropOverlay`）：只响应携带文件的拖拽，显示“松开即可添加图片”遮罩，取代只认上传框的拖放。
  - 舞台“图纸 / 像素化 / 原图”同尺寸切换；选择任何编辑工具自动回到“图纸”。编辑工具标题行含“保存本机草稿 / 开始编辑图纸”，撤销/重做/镜像/恢复只在编辑时出现。聚焦图纸时 V/B/I/E 切换查看/改色/取色/擦除。
  - 顶栏流程步骤改为按钮：1 打开选图、2 打开“尺寸”、3 回到图纸、4 打开“用豆”；无图纸时 2–4 禁用。
  - 检查器标签遵循 WAI-ARIA tabs（左右键/Home/End）；对话框 Esc/遮罩关闭、Tab 循环、关闭后焦点回到触发元素、背景滚动锁定。
  - 保存草稿、导出 PNG/CSV 用 `Toasts` 右下角提示（polite live region）；错误条可手动关闭。
- **动效**：标签滑块与分段控件同一 transform 过渡；标签页内容、欢迎页分块淡入上移；对话框/拖放卡片轻微缩放进入；通知弹入。全部在 `prefers-reduced-motion` 下关闭。时长为提案值（140/220/420ms）。
- **验证**：`npm test` 16 文件 198 例；`npm run build`；`.agents/smoke/cdp-smoke-v3.mjs`（Edge headless）15 项检查：欢迎页无检查器、三栏宽度、像素化视图、29 针 2×2 → 58×58、颜色/效果/用豆标签、色卡对话框打开与 Esc 关闭、保存草稿通知、1024/390 宽无横向溢出、手机底部导航；零 console/page error。
- **未验证**：真实读屏软件、真机触控与安全区、低端设备动画性能；未做对比度仪器测量。

## 5.7 2026-11-03 · 104 针板、精选色数套装、智能分析、画笔拖动、按库存替换（未提交）

- **拼豆板**：单板针数新增 104（单块即 104 × 104，单边最多 2 块）。
- **色卡套装**：新增“精选 24/48/72/96/120/144/168 色”，从标准 221 色中以黑白为起点、按 CIEDE2000 最远点依次挑选，套装之间嵌套；明确标注“自动精选，不是官方套装清单”。官方 265/295 色等套装待拿到色号表后再加。
- **智能分析**（`src/domain/smartAdvisor.ts` + `SmartAdvisorCard`）：
  - 颜色组成：缩到 96px 后逐像素匹配所选套装，给出主色占比条、覆盖 95% 面积所需色数。
  - 推荐色数：比较“只用前 k 色”时其余像素被迫换色的平均色差，取与全色差距足够小的最小档（8/16/24/32/48），附理由。
  - 推荐尺寸：在 29/40/52/72/104/156 长边上计算“缩小再放大”的细节损失，取低于阈值或收益拐点的最小档；像素画直接给原始逻辑尺寸；同时换算所需拼豆板块数。可分别“采用”或“一键采用”（含原有采样/抖动等推荐参数）。
- **画笔 / 橡皮拖动**：逐格改色与擦除支持按住拖动，笔刷 1 格 / 2×2 / 3×3；拖动中直接在画布上预览，快速移动按直线补格，抬笔时整笔一次提交（`replaceDesignCells`），一笔一步撤销。
- **按库存管理与替换**：色卡对话框新增“库存颗数”清单逐色填写；“用豆”页按库存检查当前图纸缺口，用手上有余量且 CIEDE2000 ≤ 8 的相近色替换（优先替换邻近已有该色的格子），预览后一键应用、可撤销，替换不了的列为“仍需购买”（`src/domain/inventoryFit.ts`）。
- **体量说明**：全部数据仍保存在浏览器本机（库存 ≤ 291 个数字，约数 KB；草稿最多 6 份，单份最大约 200 KB 级 JSON），没有服务器数据库；新增逻辑为纯前端模块，构建产物增加有限。草稿后续可按 ITERATIONS 5.3 迁移 IndexedDB + RLE。
- **待决定**：作品分享 Gallery + 管理员审核需要后端（存储、账号/审核、内容合规），与当前“纯本地处理”架构不同，需先确定方案后再做。
- **验证**：新增 `smart-features.test.tsx`（104 针、嵌套精选套装、批量改格、库存替换/不越色差、颜色组成与推荐色数、平涂 vs 细节的尺寸推荐、拖动一笔只提交一次）；`cdp-smoke-v4.mjs` 增加智能分析卡、104 针、真实鼠标拖动擦除一笔一步撤销、9 个套装、库存颗数清单。

## 5.8 2026-11-03 · 官方零售套装、新版本提示、图纸文件、编辑工具、按板制作

- **官方零售套装**：用 pixel-beads.com MARD 色号页的零售套装清单（该站注明“依据 MARD 264 色零售色卡整理”）替换上一轮的“精选 N 色”：MARD 24 / 48 / 72 / 96 / 120 / 144 / 168 / 192 / 216 / 221 / 264 色 + 全部 291 色，共 12 项。24 → 221 逐级嵌套；264 色不含 C29，另加珠光 P、冻色 R、夜光 Y、温变 Q 与 T1 共 44 色。旧的 `curated-N` 选择自动迁移到同色数的官方套装。
  - 核对结果：该站 291 个色号与项目完全一致，221 色清单一致；但有 156 个色号的 HEX 不同（44 个 ΔE76 > 10）。该站注明“HEX 为屏幕显示近似值”，项目 HEX 来自用户提供的 MARD 官方色卡印刷值，**继续以官方色卡为准**，未改 HEX。
  - 用户新放入的 295 色卡（第三方“星芒拼豆”，Y 系列到 Y9、Z1–Z8）没有 HEX 值，暂未收录 Y6–Y9。
- **新版本提示**：PWA 改为 `registerType: "prompt"`；发现新版本时底部提示“刷新到新版本 / 稍后”，不再静默停留在旧版本；每小时检查一次更新（`src/domain/appUpdate.ts`、`UpdateBanner`）。
- **图纸文件 / 库存 CSV**（`src/domain/projectFile.ts`）：
  - 左栏“导出图纸文件 / 导入图纸文件”（`.pindou.json`，只含色号格子和设置，不含原图）；欢迎页也可导入。导入只占用空余草稿位，绝不挤掉已有草稿。
  - 色卡对话框“导出 / 导入库存 CSV”（带 BOM，Excel 可直接打开；导入时第一列色号、最后一个数字列为颗数，支持中文逗号和 Tab；按色号合并）。
- **编辑工具**：新增油漆桶（G，相连同色区域整片换色）、框选（M，拖框后复制 / 剪切 / 粘贴 / 填充 / 清空，Ctrl+C / X / V、Delete、Esc；粘贴时空格不覆盖原色）、整图换色（画笔模式下“把 X 全部换成当前色”）、左右对称画笔 / 橡皮。所有批量操作都是一步撤销（`applyCellPatch`、`floodFillRegion` 等）。
- **按板制作**：制作打卡可按板导航（第 r 行第 c 块，上一块 / 下一块，板外淡化并描边当前板），进度按“本板此色”和“本板全部颜色”统计；按住拖动可连续打勾 / 取消。分板 PDF 原本已按板分页并带坐标。
- **按库存替换**：替换标准可选严格 / 适中 / 宽松（CIEDE2000 ≤ 5 / 8 / 12）。
- **成品信息**：步骤条显示成品尺寸（2.6mm 豆，悬停看 5mm 豆）；舞台新增“成品效果”视图（熨烫后 / 未熨烫的豆子模拟）。
- **工程**：GitHub Actions `ci.yml`（npm ci → test → build，只检查不部署）；浏览器冒烟脚本整理为 `scripts/smoke/browser-smoke.mjs`（`npm run smoke -- <url> <图片> <输出目录>`，`BROWSER_PATH` 可指定浏览器）；vitest 限定只跑 `src/**/*.test.*`。
- **规划**：账号、云端同步与作品图库的分阶段规划写入 ITERATIONS 3.6（参考 pixel-beads.com 的作品页与会员模式）。
- **验证**：`tsc -b` 通过；`npm test` 19 文件 227 例（新增 `editor-tools.test.tsx`：油漆桶、整图换色、对称、框选复制粘贴、按板制作与拖动打勾、成品效果、图纸文件 / 库存 CSV 往返、新版本提示；`advisor-benchmark.test.ts`：线稿 / 平涂 / 像素画 / 照片式四类合成图的推荐区间）；`npm run build` 通过；`scripts/smoke/browser-smoke.mjs`（Edge headless，亚古兽）25 项检查全部通过、零 console / page error。
- **已知 / 未验证**：硬边、规则网格的线稿可能被识别为像素画而推荐很小的尺寸（真实线稿通常有抗锯齿，未复现）；首轮冒烟曾在框选步骤断开浏览器连接，鼠标坐标限定在可见区域后未再出现，根因未确认；新版本提示需部署后在真实 Service Worker 更新时验证；真机触控、读屏软件未测。

## 6. 发布记录汇总

| # | 时间（本地） | 对应 commit | 服务器备份目录 | 结果 |
|---|---|---|---|---|
| 1 | 2026-08-02 | `29cd7bb` | `/var/www/image2pindou.backup-20260803-022716` | ✅ 线上验证通过 |
| 2 | 2026-08-02 晚 | `ab6eb10` | `/var/www/image2pindou.backup-20260803-025904` | ✅ 线上 E2E 通过 |
| 3 | 2026-08-03 | `f10ffe6` | `/var/www/image2pindou.backup-20260803-041852` | ✅ 线上焦点裁剪 / 统计筛选 E2E 通过 |
| 4 | 2026-08-03 | `4933d72` | `/var/www/image2pindou.backup-20260803-044634` | ✅ 亚古兽去背 / 推荐 / PWA 线上 E2E 通过 |
| 5 | 2026-08-03 | `88e68d3` | `/var/www/image2pindou.backup-20260803-222001` | ✅ 裁剪像素画 23×31 智能尺寸 / 推荐一致性线上 E2E 通过 |
| 6 | 2026-09-07 | `a51df85` | `/var/www/image2pindou.backup-20260907-004236` | ✅ 精细角色 156×138 / 去背景 / 特征色 / PWA 更新线上验证通过 |

> 时间说明：本地为 America/Vancouver；服务器备份目录名使用服务器时钟（UTC+ 时区），二者相差数小时属正常。

## 7. 测试基线演进

| 日期 | 测试文件数 | 用例数 | 说明 |
|---|---|---|---|
| 2026-08-02（Round 1 后） | 3 | 71 | domain / app / design-preview |
| 2026-08-02 晚（Round 2 后） | 8 | 142 | + recommend(18) / shortfall(20) / drafts(10) / conversion-coordinator(14) / exporters(9) |
| 2026-08-02 深夜（Round 3，本地） | 11 | 156 | + focus(7) / project-stats(4) / crop-dialog(1) / recommend 自动描边回归(2) |
| 2026-08-03（亚古兽缺陷修复） | 11 | 162 | + 封闭色键孔洞 / 中性底保护 / 三种量化透明填色兜底 / 推荐透明差异提示 |
| 2026-08-03（裁剪像素画智能尺寸修复） | 11 | 166 | + 基础周期优先 / 7.5px 半周期恢复 / 推荐分类一致性 / 尺寸说明 |
| 2026-09-07（精细角色，本地） | 14 | 181 | + 多尺寸/轮廓/特征色/错相采样 / 独立图纸与取消 / 完整图纸导出预算 |
