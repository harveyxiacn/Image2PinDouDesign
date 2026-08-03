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
| 生产服务器 | VPS `136.175.83.102`（hostname `brightmaple-web`） |
| SSH 登录 | `ssh -i C:\Users\Administrator\.ssh\rabisu2_ed25519 root@136.175.83.102` |
| 站点目录 | `/var/www/image2pindou`（nginx 静态托管） |
| 发布脚本 | 服务器 `/usr/local/bin/promote-release.sh`（镜像见本仓库 `deploy/promote-release.sh`） |

**常用命令：**

```bash
npm test                 # Vitest 全量回归（当前 11 个文件 / 162 用例）
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
scp -i C:\Users\Administrator\.ssh\rabisu2_ed25519 -r $rel root@136.175.83.102:/tmp/
# 3) 服务器原子切换（自动备份 + nginx -t + reload，失败自动回滚）
ssh -i C:\Users\Administrator\.ssh\rabisu2_ed25519 root@136.175.83.102 \
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
- **skill 安装**：`ui-ux-pro-max` 全局安装至 `C:\Users\Administrator\.codex\skills\ui-ux-pro-max\`（所有 session 可加载）；冗余克隆 `ui-ux-pro-max-skill\` 已删除。
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

---

## 6. 发布记录汇总

| # | 时间（本地） | 对应 commit | 服务器备份目录 | 结果 |
|---|---|---|---|---|
| 1 | 2026-08-02 | `29cd7bb` | `/var/www/image2pindou.backup-20260803-022716` | ✅ 线上验证通过 |
| 2 | 2026-08-02 晚 | `ab6eb10` | `/var/www/image2pindou.backup-20260803-025904` | ✅ 线上 E2E 通过 |
| 3 | 2026-08-03 | `f10ffe6` | `/var/www/image2pindou.backup-20260803-041852` | ✅ 线上焦点裁剪 / 统计筛选 E2E 通过 |
| 4 | 2026-08-03 | `4933d72` | `/var/www/image2pindou.backup-20260803-044634` | ✅ 亚古兽去背 / 推荐 / PWA 线上 E2E 通过 |

> 时间说明：本地为 America/Vancouver；服务器备份目录名使用服务器时钟（UTC+ 时区），二者相差数小时属正常。

## 7. 测试基线演进

| 日期 | 测试文件数 | 用例数 | 说明 |
|---|---|---|---|
| 2026-08-02（Round 1 后） | 3 | 71 | domain / app / design-preview |
| 2026-08-02 晚（Round 2 后） | 8 | 142 | + recommend(18) / shortfall(20) / drafts(10) / conversion-coordinator(14) / exporters(9) |
| 2026-08-02 深夜（Round 3，本地） | 11 | 156 | + focus(7) / project-stats(4) / crop-dialog(1) / recommend 自动描边回归(2) |
| 2026-08-03（亚古兽缺陷修复） | 11 | 162 | + 封闭色键孔洞 / 中性底保护 / 三种量化透明填色兜底 / 推荐透明差异提示 |
