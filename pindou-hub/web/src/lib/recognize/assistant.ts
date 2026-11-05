// “豆探”助手：把网格检测、图例 OCR、读色串起来，给出最终用量与可解释的步骤。
import { ciede2000, rgbToLab } from "@engine/color";
import { MARD_PALETTE } from "@engine/palette";
import { detectGrid, readGrid } from "./grid";
import { refineLattice } from "./lattice";
import { trimRulerBands } from "./ruler";
import { assignBelowBands, cellCodeCandidates, chipStack, findChips, findStatedTotal, parseChipTexts, parseHeaderText, parseLegendWords } from "./legend";
import type { HeaderInfo } from "./legend";
import { readChipLegend } from "./legendchips";
import { reconcileCounts } from "./reconcile";
import type { ReconcileResult } from "./reconcile";
import { enhanceImage, summarizeEnhance, assessQuality } from "../enhance";
import type { EnhanceResult } from "../enhance";
import type {
  AnalyzeOptions, AnalyzeResult, AssistantStep, ColorCluster, Counts, GridDetection, GridReading, LegendReading, PixelSource, Rect, StepStatus
} from "./types";

const VALID_CODES = new Set(MARD_PALETTE.map((c) => c.code));
const fmt = (n: number) => n.toLocaleString("en-US");
const sum = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0);
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
}

export async function analyzePattern(src: PixelSource, options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const steps: AssistantStep[] = [];
  const step = (id: string, label: string, status: StepStatus, detail: string) => {
    const s = { id, label, status, detail };
    steps.push(s);
    options.onProgress?.(s);
  };
  const source = { width: src.width, height: src.height };
  const signal = options.signal;

  const ocrOn = options.ocr !== false;
  let hiSrc = options.ocrSource ?? src;
  let enhanced: EnhanceResult | null = null;
  let enhBase: PixelSource = src;
  const enhanceSummary = () => (enhanced ? summarizeEnhance(enhBase, enhanced) : undefined);

  // 0) 抬头（尺寸 / 色数 / 总数）：英文识别模型读不出汉字，但“55x61”“1806”这类数字照样能读。
  // 先无先验地粗检一次网格，抬头条带取网格上方那一块（避免把标尺数字一起读进来）
  throwIfAborted(signal);
  let grid0: GridDetection | null = null;
  try { grid0 = detectGrid(src, options.region ?? null); } catch { grid0 = null; }
  // 0a) 低清图（长边 ≤ 1100）上网格常常检测不到，或只锁住每 5 / 10 格一条的粗线：放大 ×3 再检测一次，
  // 得到更细且与粗网格整倍数吻合的格子就采用；之后读格子颜色也在放大图上进行（坐标仍以原图为准）。
  let readSrc: PixelSource = src;
  let rf = 1;
  const enhMode = options.enhance ?? "auto";
  let upNote = "";
  /** 图例是否只读了个大概（有数量没读清 / 被按网格校正过 / 漏读色号）：这时格内色号读得全的网格计数比图例数字更可靠 */
  let legendPatchy = 0;
  /** 图例刚读出来（未经网格校正）的合计 */
  let legendRawSum = 0;
  if (enhMode !== "off" && !options.region && Math.max(src.width, src.height) <= 2000) {
    const sus = !grid0 || Math.min(grid0.cols, grid0.rows) <= 24 || grid0.score < 0.55;
    if (sus) {
      try {
        const F = Math.max(2, Math.min(6, Math.ceil(2400 / Math.max(src.width, src.height))));
        const up = await enhanceImage(src, { grid: null, scale: F, method: "sharp-upscale", signal });
        const g1 = up.method === "none" ? null : detectGrid(up.image, null);
        const k = up.image.width / src.width;
        // 粗网格（≤24 格）多半是每 5 / 10 格一条的粗线：按边缘能量找回细格
        const coarse = g1 && g1.score >= 0.45 ? g1 : grid0 ? { ...grid0, x0: grid0.x0 * k, y0: grid0.y0 * k, pitchX: grid0.pitchX * k, pitchY: grid0.pitchY * k } : null;
        if (up.method !== "none" && coarse && Math.min(coarse.cols, coarse.rows) <= 40) {
          const fine = refineLattice(up.image, coarse);
          // 细格在原图上必须真的很小（< 9 像素）才算“低清”问题；否则就是一张格子本来就大的图
          if (fine && fine.cols >= 8 && fine.rows >= 8 && fine.pitchX / k < 11 && fine.pitchY / k < 11) {
            upNote = `（原图上只检测到 ${grid0?.cols ?? coarse.cols}×${grid0?.rows ?? coarse.rows} 的粗网格，按边缘细分）`;
            grid0 = { ...fine, x0: fine.x0 / k, y0: fine.y0 / k, pitchX: fine.pitchX / k, pitchY: fine.pitchY / k };
            readSrc = up.image; rf = k;
          }
        }
        const ratioOk = (a: number, b: number) => { const r = a / b; return r >= 1.6 && Math.abs(r - Math.round(r)) <= 0.12 * r; };
        if (rf === 1 && g1 && g1.cols >= 8 && g1.rows >= 8 && g1.score >= 0.5 && g1.pitchX / k >= 2.4 && g1.pitchY / k >= 2.4
          && (!grid0 || (ratioOk(g1.cols, grid0.cols) && ratioOk(g1.rows, grid0.rows))
            // 原图网格本来就很弱（JPEG 小图上常检测成乱七八糟的尺寸）：放大图上明显更规整的网格直接采用
            || (grid0.score < 0.55 && g1.score >= 0.62 && g1.score >= grid0.score + 0.12 && Math.min(g1.cols, g1.rows) > 40))) {
          upNote = grid0 ? `（原图上只检测到 ${grid0.cols}×${grid0.rows} 的粗网格）` : "（原图上没检测到网格）";
          grid0 = { ...g1, x0: g1.x0 / k, y0: g1.y0 / k, pitchX: g1.pitchX / k, pitchY: g1.pitchY / k };
          readSrc = up.image; rf = k;
        }
      } catch (err) { if ((err as Error)?.name === "AbortError") throw err; }
    }
  }
  const readG = (g: GridDetection, o: Parameters<typeof readGrid>[2]): GridReading => {
    if (rf === 1) return readGrid(src, g, o);
    const gu = { ...g, x0: g.x0 * rf, y0: g.y0 * rf, pitchX: g.pitchX * rf, pitchY: g.pitchY * rf };
    const r = readGrid(readSrc, gu, o);
    r.grid = g;
    return r;
  };
  // 0b) 高清化：图太小 / 太糊时先放大重建，再读抬头 / 图例 / 格内色号（坐标按 hiSrc.width / src.width 缩放）
  if (enhMode !== "off" && ocrOn) {
    const t0 = performance.now();
    try {
      const larger = !!options.ocrSource && options.ocrSource.width > src.width * 1.2;
      const base = larger ? options.ocrSource! : src;
      enhBase = base;
      const f0 = base.width / src.width;
      const gBase = grid0 && grid0.cols >= 8 && grid0.rows >= 8 && grid0.score >= 0.45
        ? { ...grid0, x0: grid0.x0 * f0, y0: grid0.y0 * f0, pitchX: grid0.pitchX * f0, pitchY: grid0.pitchY * f0 } : null;
      if (options.enhanced) enhanced = options.enhanced;
      else {
        const q = assessQuality(base, gBase);
        // 格子 8–14 像素但边缘锐利的图（多数网上流传的图纸）放大没有收益，实测反而让图例 OCR 掉点：只在很低清 / 明显糊或方块时才放大
        const worth = q.level === "very-low" || (q.level !== "good" && (q.blur > 0.5 || q.blockiness > 0.55));
        if (enhMode === "force" || worth) {
          enhanced = await enhanceImage(base, { grid: gBase, signal, scale: enhMode === "force" && q.level === "good" ? 2 : "auto" });
        } else {
          enhanced = { image: base, scale: 1, method: "none", quality: q, ms: Math.round(performance.now() - t0), detail: "图片已足够清晰，未放大" };
        }
      }
      if (enhanced.method !== "none" && enhanced.scale > 1) {
        hiSrc = enhanced.image;
        step("enhance", "高清化", "ok", `${enhanced.quality.reasons.join("、") || "图片偏小"} → 放大 ×${Number(enhanced.scale.toFixed(1))}${enhanced.method === "chart-rebuild" ? " 按网格重建" : " 锐化"}，文字更清楚（${((performance.now() - t0) / 1000).toFixed(1)} 秒）`);
      } else step("enhance", "高清化", "skip", "图片已足够清晰");
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw err;
      enhanced = null;
      step("enhance", "高清化", "skip", `高清化没有成功（${(err as Error)?.message ?? "未知错误"}），按原图识别`);
    }
  }

  let header: HeaderInfo | null = null;
  if (ocrOn && options.headerOcr !== false) {
    try {
      const bottom = grid0 && grid0.y0 > 20 ? Math.floor(grid0.y0) : Math.round(src.height * 0.12);
      header = await withDeadline(signal, 6000, (sig) => readHeader(src, hiSrc, sig, bottom));
      const bits = [header.cols && header.rows ? `${header.cols}×${header.rows} 格` : null, header.colors ? `${header.colors} 色` : null, header.total ? `${fmt(header.total)} 颗` : null].filter(Boolean);
      if (bits.length) step("header", "读取抬头", "ok", `抬头写着：${bits.join("，")}`);
      else { step("header", "读取抬头", "skip", "没有读到抬头信息"); header = null; }
    } catch (err) {
      if (signal?.aborted && (err as Error)?.name === "AbortError" && !(err as { timeout?: boolean }).timeout) throw err;
      header = null;
      step("header", "读取抬头", "skip", `没有读到抬头信息（${(err as Error)?.message ?? "识别不可用"}）`);
    }
  }
  const hint = {
    cols: options.forceCols ?? header?.cols ?? null,
    rows: options.forceRows ?? header?.rows ?? null
  };
  const hasHint = !!(hint.cols || hint.rows);

  // 1) 网格
  throwIfAborted(signal);
  let grid: GridDetection | null = grid0;
  if (hasHint) {
    try { grid = detectGrid(src, options.region ?? null, hint); } catch { grid = grid0; }
    if (rf > 1 && (!grid || grid.score < 0.5)) grid = grid0;
  }
  // 过小 / 置信太低的“网格”多半是插画里的巧合周期，没有尺寸先验时不采信
  if (grid && !hasHint && (grid.cols < 8 || grid.rows < 8 || grid.score < 0.45)) grid = null;
  grid = applyForce(grid, src, options);
  let rulerTrim = 0;
  if (grid && !(hint.cols && hint.rows && grid.cols === hint.cols && grid.rows === hint.rows)) {
    // 标尺行列带着网格线时会被当成格子：按“整行 / 整列同色且只出现在最外圈”剥掉
    const t0 = trimRulerBands(src, grid);
    const t = trimRulers(src, t0.grid, options.treatBackgroundAsEmpty ?? true);
    grid = t.grid;
    rulerTrim = t0.trimmed + t.trimmed;
  }
  if (grid) {
    const forced = options.forceCols || options.forceRows ? "（已按手动行列调整）" : "";
    const hdr = header?.cols && header.rows
      ? (grid.cols === header.cols && grid.rows === header.rows ? "，与抬头尺寸一致" : `，抬头写的是 ${header.cols}×${header.rows}，与检测不一致`)
      : "";
    const trim = rulerTrim ? `，已去掉 ${rulerTrim} 圈标尺` : "";
    step("grid", "检测网格", grid.score >= 0.6 && !hdr.includes("不一致") ? "ok" : "warn",
      `检测到 ${grid.cols}×${grid.rows} 网格（置信 ${grid.score.toFixed(2)}）${forced}${hdr}${trim}${rf > 1 ? `，放大 ×${rf} 后才看清格线${upNote}` : ""}`);
  } else {
    step("grid", "检测网格", "fail", "没有找到规则网格；可以框选图纸区域，或手动填写列数和行数");
  }
  await tick();

  // 2) 图例 OCR（总时限 OCR_BUDGET_MS，超时则放弃图例、继续用网格结果）
  throwIfAborted(signal);
  let legend: LegendReading | null = null;
  if (!ocrOn || options.legendOcr === false) {
    step("legend", "读取图例", "skip", "已跳过图例识别");
  } else {
    const t0 = performance.now();
    try {
      const parsed = await withDeadline(signal, OCR_BUDGET_MS, (sig) => readLegend(src, hiSrc, grid, sig, ocrOn && options.headerOcr !== false));
      if (parsed.items.length >= 2) {
        legend = parsed;
        const total = sum(parsed.counts);
        const pal = parsed.palette?.length ?? 0;
        if (pal > parsed.items.length) legendPatchy += pal - parsed.items.length;
        legendRawSum = total;
        step("legend", "读取图例", parsed.items.length >= 2 ? "ok" : "warn", `读到图例 ${parsed.items.length} 色，合计 ${fmt(total)} 颗`
          + (pal > parsed.items.length ? `（色块共 ${pal} 个，${pal - parsed.items.length} 个的数量没读清，按网格统计补上）` : "")
          + (parsed.statedTotal ? `（图上标注总数 ${fmt(parsed.statedTotal)}）` : "")
          + `，用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
        if (parsed.statedTotal && Math.abs(parsed.statedTotal - total) / Math.max(total, 1) > 0.01) {
          step("legend-total", "核对图例总数", "warn", `图例各色相加 ${fmt(total)}，图上写的总数是 ${fmt(parsed.statedTotal)}，可能有色号被漏读`);
        }
      } else {
        step("legend", "读取图例", "warn", parsed.items.length
          ? "只读到 1 个色号，不足以当作图例使用"
          : "没有识别到“色号 + 数量”形式的图例");
      }
    } catch (err) {
      if (signal?.aborted && (err as Error)?.name === "AbortError" && !(err as { timeout?: boolean }).timeout) throw err;
      step("legend", "读取图例", "warn", (err as { timeout?: boolean }).timeout
        ? `图例识别超过 ${Math.round(OCR_BUDGET_MS / 1000)} 秒，已放弃，改用网格统计`
        : `图例识别不可用：${(err as Error)?.message ?? "未知错误"}`);
    }
  }
  await tick();

  // 2b) 是不是图纸：没有抬头、没有图例，也没有带文字的规整网格 → 当作普通图片，交给“生成图纸”
  {
    let r0: GridReading | null = null;
    if (grid && !legend && !header) {
      try { r0 = readG(grid, { treatBackgroundAsEmpty: options.treatBackgroundAsEmpty ?? true }); } catch { r0 = null; }
    }
    // 低清放大后（rf > 1）格子被插值抹糊、JPEG 噪点又把颜色簇推到几百个，纯色占比 / 簇数都不可信；
    // 但能走到这里说明细格线已经被边缘能量证实（格线上有边缘、半格处没有），这本身就是规整网格的证据
    // 置信度很高、格数足够多的规整格阵本身就是图纸的证据（低清 JPEG 上纯色占比 / 簇数会被噪点拉坏）
    const strongLattice = !!grid && grid.score >= 0.8 && Math.min(grid.cols, grid.rows) >= 30;
    const plausible = !!r0 && (rf > 1 || !!grid?.faint || strongLattice || r0.inkChart || (r0.flatFrac ?? 0) >= 0.55 && (r0.clusters?.length ?? 999) <= 150);
    // 只有 1–2 个“色号 + 数字”的零散文字（插画里的字、水印）不足以证明是图纸：没网格、没抬头时，图例至少要 3 色。
    const legendEvidence = !!legend && (!!grid || legend.items.length >= 3);
    const chartLike = !!header || legendEvidence || options.forceCols || options.forceRows || (grid && (r0 ? plausible : true));
    if (!chartLike) {
      const reason = "没有找到规则网格，也没有图例或抬头——这更像一张普通图片，可以用“生成图纸”把它转成拼豆图";
      step("chart", "判断是否图纸", "fail", reason);
      return { steps, legend: null, grid: null, counts: {}, method: "none", confidence: 0, diff: [], source, isChart: false, notChartReason: reason, header: undefined, enhance: enhanceSummary() };
    }
  }

  // 3) 读色
  throwIfAborted(signal);
  let reading: GridReading | null = null;
  if (grid) {
    const legendCodes = legend ? legendCodeList(legend) : null;
    reading = readG(grid, {
      closedPalette: closedOf(legend),
      allowedCodes: options.allowedCodes ?? null,
      treatBackgroundAsEmpty: options.treatBackgroundAsEmpty ?? true,
      legendCodes,
      legendColors: legend?.colors ?? null
    });
    const total = sum(reading.counts);
    if (total > 0) {
      step("read", "读取格子颜色", "ok",
        `识别 ${Object.keys(reading.counts).length} 个色号，共 ${fmt(total)} 颗，空格 ${fmt(reading.emptyCells)} 个`
        + (legendCodes ? "（按图例色号匹配）" : ""));
    } else {
      step("read", "读取格子颜色", "fail", "网格里没有读到有颜色的格子，检查是否框错区域或全是背景色");
      reading = null;
    }
  } else {
    step("read", "读取格子颜色", "skip", "没有网格，跳过");
  }
  await tick();
  throwIfAborted(signal);

  // 3b) 格内色号：图纸每个格子里印了色号时，这是最强的信号，用它校正颜色匹配
  let cellCodesRead = false;
  let cellCodeStats: AnalyzeResult["cellCodeStats"];
  if (grid && reading && options.ocr !== false && options.cellCodes !== false) {
    throwIfAborted(signal);
    if (!reading.inkChart || !reading.clusters) {
      step("cellcode", "读取格内色号", "skip", "格子里没有印色号，按颜色匹配");
    } else {
      const t1 = performance.now();
      try {
        const r = await withDeadline(signal, CELL_BUDGET_MS, (sig) => readCellCodes(src, hiSrc, grid!, reading!, sig, legend && legend.items.length >= 3 ? { allowed: legendCodeList(legend), legendColors: legend.colors ?? null } : {}));
        // 有可信图例（≥3 色）时，图例就是这张图的色号全集：格内 OCR 读出图例之外的色号（如把 “A1” 读成 “P11”）一律不采用，
        // 否则会把一整簇颜色改名，再被“补全图例”当成漏读色号重复计数。
        if (legend && legend.items.length >= 3) {
          const allowed = new Set(legendCodeList(legend));
          for (const [id, code] of Object.entries(r.votes)) if (!allowed.has(code)) delete r.votes[Number(id)];
        }
        const nVotes = Object.keys(r.votes).length;
        const nRead = Math.max(0, nVotes - r.recovered - r.merged);
        if (nVotes > 0) {
          const before = reading;
          const next = readG(grid!, {
            allowedCodes: options.allowedCodes ?? null,
            treatBackgroundAsEmpty: options.treatBackgroundAsEmpty ?? true,
            legendCodes: legend ? legendCodeList(legend) : null,
            closedPalette: closedOf(legend),
            legendColors: legend?.colors ?? null,
            cellVotes: r.votes
          });
          const overrides = (next.clusters ?? []).filter((c) => c.overridden).length;
          // 整体数量差异大得离谱（如投票把背景簇当成豆子）时不采用
          if (sum(next.counts) > 0) {
            reading = next;
            cellCodesRead = true;
            cellCodeStats = { read: nRead, clusters: r.total, overrides, glyph: r.glyph, merged: r.merged, names: [...new Set(Object.values(r.votes))] };
            const ovTxt = overrides ? `，格内色号校正了 ${overrides} 个颜色匹配` : "，与颜色匹配一致";
            step("cellcode", "读取格内色号", nRead >= r.total * 0.8 ? "ok" : "warn",
              `读出 ${nRead}/${r.total} 个颜色的格内色号${r.recovered ? `（另 ${r.recovered} 个按校正后的颜色补全）` : ""}${ovTxt}，用时 ${((performance.now() - t1) / 1000).toFixed(1)} 秒`);
          } else {
            reading = before;
            step("cellcode", "读取格内色号", "warn", "格内色号读取结果不可用，按颜色匹配");
          }
        } else {
          step("cellcode", "读取格内色号", "warn", "没有读出可信的格内色号，按颜色匹配");
        }
      } catch (err) {
        if (signal?.aborted && (err as Error)?.name === "AbortError" && !(err as { timeout?: boolean }).timeout) throw err;
        step("cellcode", "读取格内色号", "warn", (err as { timeout?: boolean }).timeout
          ? `格内色号识别超过 ${Math.round(CELL_BUDGET_MS / 1000)} 秒，已放弃，按颜色匹配`
          : `格内色号识别不可用：${(err as Error)?.message ?? "未知错误"}`);
      }
    }
    await tick();
  } else if (grid && reading && (options.ocr === false || options.cellCodes === false)) {
    step("cellcode", "读取格内色号", "skip", "已跳过格内色号识别");
  }

  // 3c) 智能去背景后的核对：背景到底是“空”还是“某色豆子”（整片 H2 的图），由图例 / 抬头总数裁决
  if (reading && (reading.backgroundCells ?? 0) > 0) {
    const sumBefore = sum(reading.counts);
    const bgN = reading.backgroundCells ?? 0;
    step("background", "智能去背景", "ok", `去掉 ${fmt(bgN)} 个与边缘相连的背景格，主体 ${fmt(sumBefore)} 颗`);
    const assigned = decideBackground(reading, legend && legend.items.length >= 2 ? legend : null, header?.total ?? legend?.statedTotal ?? null);
    if (assigned) step("background-code", "背景算作豆子", "warn", `${assigned.why}；背景不是空的，已把 ${fmt(bgN)} 个背景格算作 ${assigned.code} 豆子`);
  }

  // OCR 数字常见混淆（3↔8、末尾多读一位等）：与网格统计差得远、但改一位后吻合的，采用改后的值
  if (legend && reading) {
    const fixed = reconcileLegend(legend, reading, header?.total ?? legend.statedTotal ?? null);
    legendPatchy += fixed;
    if (fixed > 0) step("legend-fix", "校正图例数字", "warn", `按网格统计校正了 ${fixed} 个疑似 OCR 误读的数量`);
  }

  // 4) 汇总
  const diff: AnalyzeResult["diff"] = [];
  let counts: Counts = {};
  let method: AnalyzeResult["method"] = "none";
  let confidence = 0;

  // 只有色块色板、没读到几个数量的“图例”只用来限定色板，用量仍按网格统计
  const legendUsed = legend && legend.items.length >= 2 ? legend : null;
  if (legendUsed && reading) {
    // 图例没读全（OCR 漏读色号）：网格里有、图例里没有的色号，用网格统计补上
    const added: string[] = [];
    const merged: string[] = [];
    counts = { ...legendUsed.counts }; // 图例是作者写的数字，优先采用
    for (const [code, n] of Object.entries(reading.counts)) {
      if (code in legendUsed.counts) continue;
      // 网格里多出一个图例没有的色号、而图例里恰好有一个色号在网格上是 0 颗且数量几乎相同：
      // 这是同一簇颜色被叫错了名字（颜色/格内 OCR 误判），不是漏读，不能两边都算。
      const twin = Object.entries(legendUsed.counts).find(([lc, ln]) => !(reading.counts[lc] > 0) && Math.abs(ln - n) <= Math.max(2, 0.03 * ln));
      if (twin) {
        merged.push(`${code}→${twin[0]}`);
        // 网格读数也改名，后面的“图例与网格对照 / 与下方用量核对”和复原预览才一致
        reading.counts[twin[0]] = (reading.counts[twin[0]] ?? 0) + n;
        delete reading.counts[code];
        for (const row of reading.matrix) for (let i = 0; i < row.length; i++) if (row[i] === code) row[i] = twin[0];
        continue;
      }
      // 只补“数量够大”的：JPEG 噪点 / 水印会产生一堆几颗的假色号
      const inPalette = !!legendUsed.palette?.some((p) => p.code === code);
      if (inPalette || n >= Math.max(4, Math.round(0.004 * sum(reading.counts)))) { counts[code] = n; added.push(code); }
    }
    if (merged.length) step("legend-twin", "合并误判色号", "warn", `网格里的 ${merged.join("、")} 与图例色号数量一致、网格上该图例色号为 0，按同一种豆计算`);
    const lt = sum(counts);
    const gt = sum(reading.counts);
    const codes = new Set([...Object.keys(counts), ...Object.keys(reading.counts)]);
    let abs = 0;
    for (const code of [...codes].sort()) {
      const l = legendUsed.counts[code] ?? 0;
      const g = reading.counts[code] ?? 0;
      diff.push({ code, legend: l, grid: g });
      abs += Math.abs(l - g);
    }
    const mismatch = diff.filter((d) => d.legend !== d.grid && !added.includes(d.code)).length;
    // 网格读数是否“硬”：格内色号读出了绝大多数颜色，或网格规整、平涂、色差小。
    // JPEG 压缩后图例小数字常被读错（8↔6、1↔7），而格子是一颗颗数出来的——此时有分歧的色号以网格为准。
    const gtAll = sum(reading.counts);
    const gridDeAll = reading.colors.reduce((s, c) => s + c.deltaE * c.count, 0) / Math.max(1, gtAll);
    const gridTrusted = reading.grid.score >= 0.7 && (reading.flatFrac ?? 0) >= 0.7 && gridDeAll <= 4;
    // 图例“只读了个大概”的程度：没读清的数量 + 漏读的色号 + 被校正的数字，占全部色号的比例
    const patchRatio = (legendPatchy + added.length) / Math.max(1, codes.size);
    // 刚读出来的图例合计与逐格计数差了一成以上：数字整体读得不可靠（校正后看起来吻合只是被网格拉回来的）
    const rawOff = legendPatchy > 0 && legendRawSum > 0 && Math.abs(legendRawSum - gt) / Math.max(1, gt) >= 0.1;
    // 图例读得很完整：每个色块都读出了数量、没有数字被校正，补上的只是网格里零星的假色号——图例是作者写的数，比网格可靠
    const legendClean = legendPatchy === 0 && added.every((c) => (counts[c] ?? 0) < 0.02 * Math.max(1, lt));
    const patchy = patchRatio >= 0.3 || rawOff;
    const codesStrong = !!cellCodesRead && !!cellCodeStats && cellCodeStats.read / Math.max(1, cellCodeStats.clusters) >= 0.75;
    const agreement = Math.max(0, 1 - abs / Math.max(lt, gt, 1));
    if (added.length) step("legend-missing", "补全图例", "warn", `图例漏读 ${added.length} 个色号（${added.join("、")}），已按网格统计补上`);
    if (Math.abs(lt - gt) / Math.max(lt, gt, 1) <= 0.03) {
      method = "legend+grid";
      confidence = 0.75 + 0.2 * agreement;
      if (codesStrong && patchy && mismatch && Math.abs(lt - gt) / Math.max(lt, gt, 1) >= 0.005) {
        // 网格上数到了的色号用网格数字；网格上为 0 的（如被当成背景去掉的浅色豆）保留图例数字
        const fixed: string[] = [];
        for (const d of diff) if (d.grid > 0 && d.legend !== d.grid && !added.includes(d.code)) { counts[d.code] = d.grid; fixed.push(d.code); }
        if (fixed.length) step("legend-fix-grid", "按网格校正图例", "warn", `${fixed.length} 个色号的图例数字与逐格计数不同（${fixed.slice(0, 8).join("、")}${fixed.length > 8 ? " 等" : ""}），格子读数更可靠，已按网格计数`);
      }
      step("compare", "图例与网格对照", mismatch ? "warn" : "ok",
        mismatch
          ? `总数吻合（图例 ${fmt(lt)} / 网格 ${fmt(gt)}），网格统计与图例有 ${mismatch} 个色号不一致`
          : `图例与网格完全一致，共 ${fmt(lt)} 颗`);
    } else {
      // 两边总数对不上：谁更可信？有总数（抬头 / 图上标注）就看谁更接近；没有就看网格是否“可信”
      // （规整、平涂、平均色差小）——小图里图例数字 OCR 常读错位，而网格计数是确定性的
      const target = header?.total ?? legendUsed.statedTotal ?? null;
      const useGrid = target ? Math.abs(gt - target) < Math.abs(lt - target) : !legendClean && (gridTrusted || (codesStrong && patchy) || patchRatio >= 0.6);
      if (useGrid) {
        counts = { ...reading.counts };
        method = agreement >= 0.5 ? "legend+grid" : "grid";
        confidence = 0.55 + 0.2 * agreement + (target ? 0.1 : 0);
        step("compare", "图例与网格对照", "warn",
          `图例合计 ${fmt(lt)} 颗，网格数出 ${fmt(gt)} 颗，差异较大（${mismatch} 个色号不一致）；${target ? `按抬头 / 图上总数 ${fmt(target)} 判断` : "网格规整、颜色吻合度高"}，图例数字多半是识别错位，采用网格统计`);
      } else {
        method = "legend";
        confidence = 0.5 + 0.25 * agreement;
        // 图例完整：网格里零星多出来的色号多半是 JPEG 噪点造成的假色，不计入
        const dropped = legendClean && !target ? added.filter((c) => c in counts) : [];
        for (const c of dropped) delete counts[c];
        step("compare", "图例与网格对照", "warn",
          `图例合计 ${fmt(sum(counts))} 颗，网格数出 ${fmt(gt)} 颗，差异较大，有 ${mismatch} 个色号不一致；已采用图例数字${dropped.length ? `（图例读得完整，网格里零星的 ${dropped.join("、")} 视为噪点，不计入）` : ""}`);
      }
    }
    if (legendUsed.statedTotal && Math.abs(legendUsed.statedTotal - lt) / Math.max(lt, 1) <= 0.01) confidence += 0.05;
    else if (legendUsed.statedTotal) confidence -= 0.1;
  } else if (legendUsed) {
    counts = { ...legendUsed.counts };
    method = "legend";
    confidence = 0.6;
    if (legendUsed.statedTotal) {
      confidence += Math.abs(legendUsed.statedTotal - sum(counts)) / Math.max(sum(counts), 1) <= 0.01 ? 0.2 : -0.1;
    }
    step("compare", "采用图例", grid ? "warn" : "ok", grid ? "网格没有读出有效格子，只能采用图例数字" : "没有找到网格，采用图例数字");
  } else if (reading) {
    counts = { ...reading.counts };
    method = "grid";
    const total = sum(reading.counts);
    let de = 0;
    for (const c of reading.colors) de += c.deltaE * c.count;
    de /= Math.max(total, 1);
    confidence = Math.min(0.8, 0.45 * reading.grid.score + 0.4 * Math.max(0, 1 - de / 10));
    // 读到了格内色号：色号来自图上文字，比单靠颜色可靠得多
    if (cellCodesRead && cellCodeStats) confidence = Math.min(0.92, confidence + 0.1 + 0.15 * (cellCodeStats.read / Math.max(1, cellCodeStats.clusters)));
    step("compare", "采用网格统计", de > 6 ? "warn" : "ok",
      `没有可用的图例，按网格统计 ${fmt(total)} 颗（平均色差 ΔE ${de.toFixed(1)}）${de > 6 ? "，图纸颜色与色卡偏差较大，建议核对" : ""}`);
  } else {
    step("compare", "汇总结果", "fail", "没有识别到图例或网格。试试：框选图纸区域、手动填写行列数，或换一张更清晰、不带水印的截图");
  }

  confidence = Math.max(0, Math.min(1, confidence));
  // 多来源核对：图例读数（含备选读法）/ 网格 / 抬头总数——合计对不上总数时，在有争议的色号里挑合计恰好吻合的组合，并给每个色号标注把握
  let recon: ReconcileResult | null = null;
  if (sum(counts) > 0) {
    try {
      recon = reconcileCounts({
        current: counts,
        legend: legend && legend.items.length >= 2 ? legend.items : null,
        grid: reading?.counts ?? null,
        cellCodes: cellCodesRead,
        total: header?.total ?? legend?.statedTotal ?? null,
        colors: header?.colors ?? null
      });
      if (recon.changed.length) {
        counts = recon.counts;
        step("reconcile", "按总数核对读数", "warn", recon.notes.join("；"));
      }
    } catch { recon = null; }
  }
    // 抬头总数核对 / 色数核对
  if (header?.total && sum(counts) > 0) {
    const ok = Math.abs(sum(counts) - header.total) / header.total <= 0.01;
    step("header-check", "核对抬头总数", ok ? "ok" : "warn", ok
      ? `最终用量 ${fmt(sum(counts))} 颗，与抬头 ${fmt(header.total)} 颗一致`
      : `最终用量 ${fmt(sum(counts))} 颗，抬头写的是 ${fmt(header.total)} 颗，有出入`);
    confidence = Math.max(0, Math.min(1, confidence + (ok ? 0.05 : -0.1)));
  }
  // 与下方图例逐色核对
  const checks: NonNullable<AnalyzeResult["checks"]> = [];
  {
    const lc = legend && legend.items.length >= 2 ? legend.counts : null;
    const rc = reading?.counts ?? counts;
    const codes = new Set([...Object.keys(rc), ...(lc ? Object.keys(lc) : [])]);
    for (const code of [...codes].sort()) {
      const l = lc && code in lc ? lc[code] : null;
      const r = rc[code] ?? 0;
      let status: "ok" | "short" | "over" | "no-legend" = "no-legend";
      if (l !== null) status = Math.abs(l - r) <= Math.max(2, Math.round(0.03 * l)) ? "ok" : r < l ? "short" : "over";
      const pv = recon?.prov[code];
      checks.push({ code, legend: l, read: r, status, ...(pv ? { source: pv.source, confidence: pv.confidence, uncertain: pv.uncertain } : {}) });
    }
    if (lc) {
      const withLegend = checks.filter((c) => c.legend !== null);
      const okN = withLegend.filter((c) => c.status === "ok").length;
      const bad = withLegend.filter((c) => c.status !== "ok").map((c) => `${c.code} ${c.status === "short" ? "少" : "多"} ${fmt(Math.abs((c.legend ?? 0) - c.read))}`);
      step("legend-check", "与下方用量核对", okN === withLegend.length ? "ok" : "warn",
        `与下方用量核对：${okN}/${withLegend.length} 色一致${bad.length ? `（${bad.slice(0, 6).join("、")}${bad.length > 6 ? "…" : ""}）` : ""}`);
    }
  }
  {
    const unsure = checks.filter((c) => c.uncertain && c.read > 0);
    if (unsure.length && unsure.length <= 12) step("uncertain", "需要核对的色号", "warn", `${unsure.map((c) => c.code).join("、")} 的读数来源互相矛盾或把握不高，建议对照原图核对`);
  }
  const paletteWarning = detectPaletteMismatch(legend, reading, cellCodeStats);
  if (paletteWarning) step("palette", "核对色卡", "warn", paletteWarning);
  return {
    steps, legend, grid: reading, counts, method, confidence, diff, source, cellCodesRead, cellCodeStats, enhance: enhanceSummary(),
    isChart: true, checks, header: header ?? undefined, paletteWarning: paletteWarning ?? undefined
  };
}

// ── helpers ──

/** 图例里所有色号（读到数量的 + 只有色块的）。 */
function legendCodeList(legend: LegendReading): string[] {
  return [...new Set([...legend.items.map((i) => i.code), ...(legend.palette ?? []).map((p) => p.code)])];
}

/** 色块基本找全了（≥ 3 个）时，格子只在图例色板里匹配。 */
function closedOf(legend: LegendReading | null): boolean {
  return !!legend?.palette && legend.palette.length >= 3;
}

export function trimRulersForTest(src: PixelSource, g: GridDetection) { const t0 = trimRulerBands(src, g); const t = trimRulers(src, t0.grid, true); return t.grid; }

function gridRect(g: GridDetection): Rect {
  return { x: g.x0, y: g.y0, width: g.cols * g.pitchX, height: g.rows * g.pitchY };
}

function padRect(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

/** 网格外的上 / 下 / 左 / 右四条带（足够大才算），格子里的小字不会进入 OCR，也更快。 */
function outsideBands(src: PixelSource, g: Rect): Rect[] {
  const x0 = Math.max(0, Math.floor(g.x)), x1 = Math.min(src.width, Math.ceil(g.x + g.width));
  const y0 = Math.max(0, Math.floor(g.y)), y1 = Math.min(src.height, Math.ceil(g.y + g.height));
  const out: Rect[] = [];
  if (y0 >= 24) out.push({ x: 0, y: 0, width: src.width, height: y0 });
  if (src.height - y1 >= 24) out.push({ x: 0, y: y1, width: src.width, height: src.height - y1 });
  if (x0 >= 60) out.push({ x: 0, y: y0, width: x0, height: y1 - y0 });
  if (src.width - x1 >= 60) out.push({ x: x1, y: y0, width: src.width - x1, height: y1 - y0 });
  return out;
}

function cropSource(src: PixelSource, r: Rect): PixelSource {
  const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const from = ((Math.floor(r.y) + y) * src.width + Math.floor(r.x)) * 4;
    data.set(src.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

/** 用户手动指定行列：沿用检测到的整体范围重新等分；没检测到就用框选区域 / 整图。 */
function applyForce(grid: GridDetection | null, src: PixelSource, o: AnalyzeOptions): GridDetection | null {
  const fc = o.forceCols && o.forceCols > 0 ? Math.round(o.forceCols) : null;
  const fr = o.forceRows && o.forceRows > 0 ? Math.round(o.forceRows) : null;
  if (!fc && !fr) return grid;
  if (grid) {
    const w = grid.cols * grid.pitchX;
    const h = grid.rows * grid.pitchY;
    const cols = fc ?? grid.cols;
    const rows = fr ?? grid.rows;
    return { ...grid, cols, rows, pitchX: w / cols, pitchY: h / rows };
  }
  if (fc && fr) {
    const r = o.region ?? { x: 0, y: 0, width: src.width, height: src.height };
    return { x0: r.x, y0: r.y, cols: fc, rows: fr, pitchX: r.width / fc, pitchY: r.height / fr, score: 0.3 };
  }
  return null;
}

// ── 图例读取 ──

const OCR_BUDGET_MS = 12_000;
const CELL_BUDGET_MS = 8_000;

/** 给一次异步任务加总时限：超时 abort 内部 signal 并抛出带 timeout 标记的 AbortError。 */
async function withDeadline<T>(outer: AbortSignal | undefined, ms: number, run: (s: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  const onOuter = () => ctl.abort();
  outer?.addEventListener("abort", onOuter, { once: true });
  try {
    return await run(ctl.signal);
  } catch (err) {
    if (timedOut) throw Object.assign(new Error("OCR 超时"), { name: "AbortError", timeout: true });
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
    if (timedOut) void import("./ocr").then((m) => m.terminateOcr());
  }
}

type RectI = { x: number; y: number; width: number; height: number };

/** 裁掉四周与底色相同的空白，只留有内容的外接矩形（加一点边距）。 */
function contentBox(img: PixelSource, pad = 6): RectI | null {
  const { width: w, height: h, data: d } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  const votes = new Map<number, number>();
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 4;
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  let bk = 0, bv = -1;
  for (const [k, v] of votes) if (v > bv) { bv = v; bk = k; }
  const br = ((bk >> 8) << 4) + 8, bg = (((bk >> 4) & 15) << 4) + 8, bb = ((bk & 15) << 4) + 8;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb) > 60) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function scaleRect(r: Rect, f: number): RectI {
  return { x: Math.floor(r.x * f), y: Math.floor(r.y * f), width: Math.max(1, Math.floor(r.width * f)), height: Math.max(1, Math.floor(r.height * f)) };
}

/**
 * 图例读取：最多 2 次 OCR。
 * ① 网格以外最大的条带（通常是下方图例），裁到有内容的范围；若里面是一排排平涂色块（“A1 · 154 颗”印在色块上），
 *   把每块的文字叠成一张小图一次识别（版面规整，快且准），否则按词框空间配对。
 * ② 若还没读到总数，再识别上方抬头条带找“N 颗豆”。
 */
async function readLegend(src: PixelSource, hi: PixelSource, grid: GridDetection | null, signal: AbortSignal, headerRead = false): Promise<LegendReading> {
  const { ocrWords } = await import("./ocr");
  const f = hi.width / src.width;
  const exclude = grid ? padRect(gridRect(grid), Math.max(grid.pitchX, grid.pitchY) * 1.2) : null;
  const bands = exclude ? outsideBands(src, exclude) : [{ x: 0, y: 0, width: src.width, height: src.height }];
  if (!bands.length) return { items: [], counts: {}, statedTotal: null, rawText: "" };
  const area = (r: Rect) => r.width * r.height;
  // 下方优先；没有下方条带则取面积最大的
  const below = exclude ? bands.filter((b) => b.y >= exclude.y + exclude.height - 1) : [];
  const main = [...(below.length ? below : bands)].sort((a, b) => area(b) - area(a))[0];
  const header = exclude ? bands.find((b) => b.y === 0 && b !== main) ?? null : null;

  const cropTight = (r: Rect): { img: PixelSource; ox: number; oy: number } | null => {
    const rr = scaleRect(r, f);
    const raw = cropSource(hi, rr);
    const box = contentBox(raw);
    if (!box) return null;
    return { img: cropSource(raw, box), ox: rr.x + box.x, oy: rr.y + box.y };
  };

  let result: LegendReading = { items: [], counts: {}, statedTotal: null, rawText: "" };
  const crop = cropTight(main);
  {
    // 新：版式无关的图例读取器（色块 + 色号 + 数量，数量可在下 / 右 / 块内）。读出的条目够多就直接采用，否则走下面的老路径。
    // 条带不加网格外扩的安全边距：小图里图例紧贴标尺，外扩会把色块切掉
    const g0 = grid ? gridRect(grid) : null;
    const rawBands = g0 ? outsideBands(src, g0) : bands;
    const rawBelow = g0 ? rawBands.filter((b) => b.y >= g0.y + g0.height - 1) : [];
    const rawMain = [...(rawBelow.length ? rawBelow : rawBands)].sort((a, b) => area(b) - area(a))[0];
    const rc = rawMain ? cropTight(rawMain) : null;
    let cl0: Awaited<ReturnType<typeof readChipLegend>> = null;
    for (const cand of [rc, crop]) {
      cl0 = null;
      if (!cand || cand.img.height < 8) continue;
      throwIfAborted(signal);
      try {
        const cl = await readChipLegend(cand.img, signal);
        cl0 = cl;
        // 读数合计不可能超过格子总数（超过说明色号 / 数量被连写读错了）
        const clSum = cl ? cl.items.reduce((a, it) => a + it.count, 0) : 0;
        const tooMany = !!grid && clSum > grid.cols * grid.rows;
        if (cl && !tooMany && cl.confirmed >= Math.max(3, Math.ceil(0.5 * cl.chipCount))) { result = cl; break; }
      } catch (err) { if ((err as Error)?.name === "AbortError") throw err; }
      if (cand === crop || (rc && crop && rc.oy === crop.oy && rc.img.height === crop.img.height)) break;
      if (cl0 && cl0.chipCount > 0) break; // 已经找到色块、只是不是带数量的图例：换个裁剪重试也一样
    }
  }
  // 网格框被误检得很大（盖住了图例）时，上面按“网格外的条带”找不到图例：退而读整图最下面 ~1/3（图例几乎总在底部）
  if (result.items.length < 2 && hi.height >= 400) {
    throwIfAborted(signal);
    const y0 = Math.floor(hi.height * 0.68);
    const raw = cropSource(hi, { x: 0, y: y0, width: hi.width, height: hi.height - y0 });
    const box = contentBox(raw);
    if (box) {
      try {
        const cl = await readChipLegend(cropSource(raw, box), signal);
        const clSum = cl ? cl.items.reduce((a, it) => a + it.count, 0) : 0;
        if (cl && clSum <= hi.width * hi.height / 100 && cl.confirmed >= Math.max(3, Math.ceil(0.5 * cl.chipCount))) result = cl;
      } catch (err) { if ((err as Error)?.name === "AbortError") throw err; }
    }
  }
  if (crop && result.items.length < 2) {
    throwIfAborted(signal);
    const chips = findChips(crop.img, Math.max(12, Math.round(0.015 * hi.width)), 0.9);
    // 图例最多几十色；上百个“色块”是把图纸格子 / 标尺当成了色块，不读（又慢又会读出一堆假色号）
    if (chips.length >= 3 && chips.length <= 60) {
      // 去掉尺寸明显不同的“色块”（水印 / 文字团）：以中位尺寸为准
      const hs = chips.map((c) => c.height).sort((x, y) => x - y), ws2 = chips.map((c) => c.width).sort((x, y) => x - y);
      const mh = hs[hs.length >> 1], mw = ws2[ws2.length >> 1];
      for (let i = chips.length - 1; i >= 0; i -= 1) {
        const c = chips[i];
        if (c.height < 0.6 * mh || c.height > 1.6 * mh || c.width < 0.6 * mw || c.width > 1.6 * mw) chips.splice(i, 1);
      }
      // 数量印在色块下方的图例：给每个色块带上下方条带（直到下一排色块之前）
      assignBelowBands(chips, crop.img.height);
      const heights = chips.map((c) => c.height).sort((a, b) => a - b);
      const medH = heights[heights.length >> 1];
      // 小字图例一遍读不全：放大 ~110/高 与 ~150/高 各读一遍（最多 2 次），按色号合并
      const merged = new Map<string, import("./types").LegendItem>();
      const colors: Record<string, { r: number; g: number; b: number }> = {};
      const perChip = new Map<import("./legend").Chip, { code: string | null; count: number | null }>();
      let stated: number | null = null;
      let raw = "";
      for (const [target, bin] of [[110, false], [150, true]] as const) {
        const scale = Math.min(4, Math.max(1, target / medH));
        const stack = chipStack(crop.img, chips, scale, undefined, 0.5, bin);
        const res = await ocrWords(stack.image, signal, { scale: 1, psm: "6" });
        const rows = stack.rows.map((r) => ({
          chip: r.chip,
          text: wordsToLines(res.words.filter((w) => { const cy = (w.bbox.y0 + w.bbox.y1) / 2; return cy >= r.y0 && cy < r.y1; })).replace(/\n/g, " ")
        }));
        const parsed = parseChipTexts(rows, VALID_CODES, (code) => MARD_PALETTE.find((c) => c.code === code)?.rgb ?? null);
        for (const it of parsed.items) if (!merged.has(it.code)) merged.set(it.code, it);
        for (const [k, v] of Object.entries(parsed.colors)) if (!(k in colors)) colors[k] = v;
        for (const pc of parsed.perChip) {
          const cur = perChip.get(pc.chip);
          if (!cur || (pc.code && !cur.code) || (pc.count !== null && cur.count === null)) perChip.set(pc.chip, { code: pc.code ?? cur?.code ?? null, count: pc.count ?? cur?.count ?? null });
        }
        stated = stated ?? findStatedTotal(res.text);
        raw += parsed.rawText;
        if (merged.size >= chips.length * 0.9) break; // 基本读全了
      }
      // 数量印在色块下方：单独把“色块下方一条”叠成一张图，只认数字（白名单），放大到字高约 36px
      const withBelow = chips.filter((c) => (c.below ?? 0) >= 6);
      if (withBelow.length >= 3) {
        throwIfAborted(signal);
        const below = await readCountsBelow(crop.img, withBelow, signal);
        for (const [chip, n] of below) { const cur = perChip.get(chip); perChip.set(chip, { code: cur?.code ?? null, count: n }); }
      }
      const palette = buildChipPalette(chips, perChip);
      const items: import("./types").LegendItem[] = [];
      const counts: Counts = {};
      for (const p of palette) {
        if (p.count === null || p.count <= 0) continue;
        items.push({ code: p.code, count: p.count, source: p.guessed ? "色块颜色+数量" : "色块文字" });
        counts[p.code] = p.count;
      }
      for (const it of merged.values()) if (!(it.code in counts) && palette.some((p) => p.code === it.code)) { items.push(it); counts[it.code] = it.count; }
      for (const p of palette) if (!(p.code in colors)) colors[p.code] = p.rgb;
      // 色块很多、却只读到零星几个数量：多半是插画 / 拼图里的色块，不是图例
      if (items.length >= Math.max(2, Math.ceil(0.25 * chips.length))) result = { items, counts, statedTotal: stated, rawText: raw.slice(0, 2000), colors, palette };
    }
    if (result.items.length < 2) {
      const side = Math.max(crop.img.width, crop.img.height);
      const scale = side < 1600 ? 2 : side > 3200 ? 1 : 1.5;
      const res = await ocrWords(crop.img, signal, { scale });
      const parsed = parseLegendWords(res.words, VALID_CODES, null);
      if (parsed.items.length > result.items.length) result = parsed;
    }
  }
  // 抬头条带在“读取抬头”那一步已经读过（没读到就是没有），不重复读：这一遍 OCR 常要好几秒
  if (result.statedTotal === null && header && !headerRead) {
    throwIfAborted(signal);
    const hc = cropTight(header);
    if (hc) {
      const side = Math.max(hc.img.width, hc.img.height);
      const res = await ocrWords(hc.img, signal, { scale: side < 1600 ? 2 : 1 });
      result.statedTotal = parseLegendWords(res.words, VALID_CODES, null).statedTotal ?? findStatedTotal(res.text);
    }
  }
  return result;
}


/** 读色块正下方的数量（一行一块，数字白名单）。返回 色块 → 数量。 */
async function readCountsBelow(img: PixelSource, chips: import("./legend").Chip[], signal: AbortSignal): Promise<Map<import("./legend").Chip, number>> {
  const { ocrWords } = await import("./ocr");
  const pseudo = chips.map((c, i) => {
    const bg = c.bg ?? [255, 255, 255];
    const x = Math.max(0, c.x - 2);
    return { x, y: c.y + c.height + 1, width: Math.max(4, Math.min(img.width - x, c.width + 4)), height: Math.max(4, Math.min(img.height - (c.y + c.height + 1), (c.below ?? 0) - 1)), r: bg[0], g: bg[1], b: bg[2], bg, tag: i };
  }).filter((c) => c.y < img.height - 4);
  const out = new Map<import("./legend").Chip, number>();
  if (pseudo.length < 3) return out;
  const stack = chipStack(img, pseudo, 1, 36);
  if (!stack.rows.length) return out;
  const res = await ocrWords(stack.image, signal, { scale: 1, psm: "6", whitelist: "0123456789" });
  for (const row of stack.rows) {
    const text = res.words
      .filter((w) => { const cy = (w.bbox.y0 + w.bbox.y1) / 2; return cy >= row.y0 && cy < row.y1; })
      .sort((a, b) => a.bbox.x0 - b.bbox.x0).map((w) => w.text).join("");
    const digits = text.replace(/[^0-9]/g, "");
    if (!digits || digits.length > 5) continue;
    const n = Number(digits);
    const chip = chips[row.chip.tag ?? -1];
    if (chip && n >= 1) out.set(chip, n);
  }
  return out;
}

/**
 * 所有色块（含文字没读出来的）→ 闭集色板：读到色号的用读到的，没读到的按色块颜色找最近的、还没被占用的色卡色（ΔE ≤ 10）。
 * 图纸上的颜色只会是这些色块里的颜色，所以格子只在色板里匹配，不会冒出一堆浅色 / 灰色幻影色号。
 */
export function buildChipPalette(
  chips: Array<{ r: number; g: number; b: number }>,
  perChip: Map<any, { code: string | null; count: number | null }>
): NonNullable<LegendReading["palette"]> {
  const pal = new Map(MARD_PALETTE.map((p) => [p.code, p]));
  type Slot = { chip: { r: number; g: number; b: number }; rgb: { r: number; g: number; b: number }; lab: ReturnType<typeof rgbToLab>; ocr: string | null; dOcr: number; count: number | null; code: string | null; guessed: boolean };
  const slots: Slot[] = chips.map((c) => {
    const e = perChip.get(c);
    const rgb = { r: c.r, g: c.g, b: c.b };
    const lab = rgbToLab(rgb);
    const ocr = e?.code && pal.has(e.code) ? e.code : null;
    return { chip: c, rgb, lab, ocr, dOcr: ocr ? ciede2000(lab, pal.get(ocr)!.lab) : Infinity, count: e?.count ?? null, code: null, guessed: false };
  });
  const used = new Set<string>();
  // ① 文字读出的色号且与色块颜色吻合（ΔE ≤ 5）：采用
  for (const sl of slots) if (sl.ocr && sl.dOcr <= 5 && !used.has(sl.ocr)) { sl.code = sl.ocr; used.add(sl.ocr); }
  // ② 其余按色块颜色找最近且未被占用的色卡色（ΔE ≤ 10），颜色越贴近的先分配
  const rest = slots.filter((sl) => !sl.code);
  const cand: Array<{ sl: Slot; code: string; d: number }> = [];
  for (const sl of rest) for (const p of MARD_PALETTE) { const d = ciede2000(sl.lab, p.lab); if (d <= 10) cand.push({ sl, code: p.code, d }); }
  cand.sort((x, y) => x.d - y.d);
  for (const c of cand) {
    if (c.sl.code || used.has(c.code)) continue;
    c.sl.code = c.code; c.sl.guessed = true; used.add(c.code);
  }
  // ③ 颜色对不上但文字读出了色号（色块偏色严重）：退而采用文字
  for (const sl of slots) if (!sl.code && sl.ocr && sl.dOcr <= 14 && !used.has(sl.ocr)) { sl.code = sl.ocr; used.add(sl.ocr); }
  const out: NonNullable<LegendReading["palette"]> = [];
  for (const sl of slots) if (sl.code) out.push({ code: sl.code, rgb: sl.rgb, count: sl.count, ...(sl.guessed ? { guessed: true } : {}) });
  return out;
}

const DIGIT_PARTNER: Record<string, string[]> = {
  "0": ["8", "6"], "1": ["7"], "3": ["8"], "5": ["6", "3"], "6": ["5", "8", "0"], "7": ["1"], "8": ["3", "0", "6"], "9": ["8", "4"]
};

/** 返回被校正的条目数。 */
function reconcileLegend(legend: LegendReading, reading: GridReading, statedTotal: number | null = null): number {
  const grid = reading.counts;
  // 图例各色相加恰好等于图上写的总数：数字整体可信，网格数（颜色相近的色号会互相串）不能再去“校正”
  const legendSum = Object.values(legend.counts).reduce((a, b) => a + b, 0);
  if (statedTotal && Math.abs(legendSum - statedTotal) <= Math.max(1, Math.round(0.002 * statedTotal))) return 0;
  // 网格整体可信吗：图例与网格在绝大多数色号上吻合（≥ 85%）时，个别不吻合的多半是图例数字读错；
  // 大面积对不上（颜色相近的色号互相串、背景被误并）时，网格数不可信，不能拿它推翻图例上读到的数
  const cmp = legend.items.filter((it) => (reading.counts[it.code] ?? 0) >= 5);
  const gridTrusted = cmp.length >= 3 && cmp.filter((it) => Math.abs(it.count - reading.counts[it.code]) / reading.counts[it.code] <= 0.1).length >= 0.85 * cmp.length;
  let fixed = 0;
  for (const item of legend.items) {
    const g = grid[item.code] ?? 0;
    if (g < 5) continue;
    // 色块图例读取器里被两遍以上识别一致、没有备选读法的数量很可信：网格数（颜色相近的色号会互相串）不能推翻它
    // （网格读数有格内色号印证时除外：此时网格数比同一种读法反复读出的同一个错数更可信）
    if (!gridTrusted && item.source === "色块图例" && (item.votes ?? 0) >= 2 && !item.alts?.length) continue;
    // 白色（H1 / H2）常常就是图纸底色，网格数里被去背景 / 并背景弄乱了，不能拿来推翻图例上写的数
    if (/^H[12]$/.test(item.code) && item.source === "色块图例") continue;
    const l = item.count;
    if (Math.abs(l - g) / g <= 0.1) continue;
    const s = String(l);
    const cands = new Set<number>();
    if (s.length > 1) { cands.add(Number(s.slice(0, -1))); cands.add(Number(s.slice(1))); }
    // 漏读一位（49 → 9）：在任意位置补一个数字
    for (let i = 0; i <= s.length; i += 1) for (let dgt = 0; dgt <= 9; dgt += 1) cands.add(Number(s.slice(0, i) + dgt + s.slice(i)));
    for (let i = 0; i < s.length; i += 1) {
      for (const p of DIGIT_PARTNER[s[i]] ?? []) cands.add(Number(s.slice(0, i) + p + s.slice(i + 1)));
    }
    let best: number | null = null;
    for (const c of cands) {
      if (c > 0 && Math.abs(c - g) / g <= 0.03 && (best === null || Math.abs(c - g) < Math.abs(best - g))) best = c;
    }
    if (best === null && gridTrusted) {
      // 改一位也对不上（且网格在绝大多数色号上与图例吻合，网格整体可信）：若该色号的图例色块颜色被网格精确匹配（ΔE≤2），以网格数为准（OCR 很可能读错了）
      const st = reading.colors.find((c) => c.code === item.code);
      if (legend.colors?.[item.code] && st && st.deltaE <= ((item.votes ?? 0) >= 2 && !item.alts?.length ? 1.5 : legend.palette ? 5 : 2)) best = g;
    }
    if (best !== null) {
      item.count = best;
      legend.counts[item.code] = best;
      fixed += 1;
    }
  }
  return fixed;
}

// ── 格内色号 ──

const CELL_WHITELIST = "ABCDEFGHMPQRTYZ0123456789";

type Pick = { cluster: number; cell: number };

/** 每个颜色簇挑 n 个代表格：优先“四邻同簇”的内部格，并沿图均匀分布。 */
function pickCells(reading: GridReading, clusterId: number, n: number, used: Set<number>): number[] {
  const c = reading.clusters![clusterId];
  const { cols, rows } = reading.grid;
  const ink = reading.cellInk!;
  const cc = reading.cellCluster!;
  const inner: number[] = [];
  const rest: number[] = [];
  for (const i of c.cells) {
    if (used.has(i) || !ink[i] || reading.backgroundMask?.[i]) continue;
    const x = i % cols, y = Math.floor(i / cols);
    const same = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < cols && yy < rows && cc[yy * cols + xx] === clusterId;
    (same(x - 1, y) && same(x + 1, y) && same(x, y - 1) && same(x, y + 1) ? inner : rest).push(i);
  }
  const pool = inner.length >= n ? inner : [...inner, ...rest];
  const out: number[] = [];
  for (let k = 0; k < Math.min(n, pool.length); k += 1) out.push(pool[Math.floor(((k + 0.5) * pool.length) / Math.min(n, pool.length))]);
  return out;
}

/**
 * 格内色号 OCR：每个有字的颜色簇取最多 5 个代表格（每个用不同的墨迹阈值），把格内文字（与格子底色不同的像素 → 黑字白底，放大到字高约 30px）
 * 竖向叠成一张图识别一次；簇内多数票决定色号。最多 2 次 OCR（第二次补读第一次没结论的簇）。
 */
async function readCellCodes(
  src: PixelSource, hi: PixelSource, grid: GridDetection, reading: GridReading, signal: AbortSignal,
  gopts: { allowed?: string[] | null; legendColors?: Record<string, { r: number; g: number; b: number }> | null } = {}
): Promise<{ votes: Record<number, string>; total: number; recovered: number; glyph: number; merged: number }> {
  const { ocrWords } = await import("./ocr");
  const f = hi.width / src.width;
  const clusters = reading.clusters!;
  let eligible = clusters.filter((c) => c.inkCells >= Math.max(1, Math.ceil(c.count * 0.5)));
  // 颜色簇太多（照片 / 噪点）说明不是规整的色号图：放弃；否则只取格子最多的前 60 个簇，并限制叠图总高度
  // 先把噪点拆碎的簇并成颜色组，整组读一次字；碎簇太多（照片）才放弃
  const gv: Record<number, string> = {};
  const noisy = clusters.length > 90;
  let glyphGroups = 0;
  try {
    const { groupClusters, readGlyphCodes } = await import("./glyph");
    const groups = groupClusters(reading).filter((g) => g.count >= 2 && g.cells.filter((i) => reading.cellInk![i]).length >= 0.4 * g.count);
    if (groups.length > 0 && groups.length <= 90) {
      const g = await readGlyphCodes(hi, f, grid, reading, groups, gopts, signal, (img, sg, o) => ocrWords(img, sg, o));
      for (const [gid, v] of Object.entries(g.votes)) for (const m of groups.find((x) => x.id === Number(gid))!.members) gv[m] = v.code;
      glyphGroups = Object.keys(g.votes).length;
    }
  } catch (err) {
    (globalThis as { __phGlyphDebug?: (info: unknown) => void }).__phGlyphDebug?.({ error: String((err as Error)?.stack ?? err) });
    if (signal.aborted) throw err;
  }
  if (eligible.length > 90) eligible = [];
  if (noisy && !Object.keys(gv).length) return { votes: {}, total: clusters.length, recovered: 0, glyph: 0, merged: 0 };
  eligible = [...eligible].sort((x, y) => y.count - x.count).slice(0, 60);
  const perCluster = Math.max(1, Math.min(5, Math.floor(200 / Math.max(1, eligible.length))));
  const tally = new Map<number, Map<string, number>>();
  const picked = new Map<number, number>();
  const used = new Set<number>();
  const palRgb = (code: string) => MARD_PALETTE.find((c) => c.code === code)?.rgb ?? null;

  const runRound = async (ids: number[], perCluster: number) => {
    const picks: Array<Pick & { thr: number }> = [];
    // 同一簇的几个代表格用不同的墨迹阈值：笔画粗细不同，OCR 的漏字 / 误读互不相同，多数票才有意义
    const THRS = [0.5, 0.6, 0.42, 0.55, 0.46];
    for (const id of ids) pickCells(reading, id, perCluster, used).forEach((cell, k) => { picks.push({ cluster: id, cell, thr: THRS[k % THRS.length] }); used.add(cell); });
    if (!picks.length) return;
    const chips = picks.map((p, t) => {
      const cl = clusters[p.cluster];
      const cx = p.cell % grid.cols, cy = Math.floor(p.cell / grid.cols);
      const inset = 0.08;
      const x = (grid.x0 + (cx + inset) * grid.pitchX) * f, y = (grid.y0 + (cy + inset) * grid.pitchY) * f;
      const w = grid.pitchX * (1 - 2 * inset) * f, h = grid.pitchY * (1 - 2 * inset) * f;
      const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
      return { x: x0, y: y0, width: Math.max(2, Math.min(hi.width - x0, Math.floor(w))), height: Math.max(2, Math.min(hi.height - y0, Math.floor(h))), r: cl.rgb.r, g: cl.rgb.g, b: cl.rgb.b, tag: t, inkThr: p.thr };
    });
    const stack = chipStack(hi, chips, 1, 30);
    if (!stack.rows.length) return;
    const res = await ocrWords(stack.image, signal, { scale: 1, psm: "6", whitelist: CELL_WHITELIST });
    for (const row of stack.rows) {
      const pk = picks[row.chip.tag ?? -1];
      if (!pk) continue;
      picked.set(pk.cluster, (picked.get(pk.cluster) ?? 0) + 1);
      const text = res.words
        .filter((w) => { const cy = (w.bbox.y0 + w.bbox.y1) / 2; return cy >= row.y0 && cy < row.y1; })
        .sort((x, y) => x.bbox.x0 - y.bbox.x0).map((w) => w.text).join(" ");
      let cands = cellCodeCandidates(text, VALID_CODES);
      if (!cands.length) continue;
      if (cands.length > 1) {
        // 先看长度与识别文字最接近（少删字符），再看与簇颜色最接近的色卡色（如 g 可能是 8 或 9）
        const compact = text.replace(/[^0-9A-Za-z|]/g, "").length;
        const cl = clusters[pk.cluster];
        cands = [...cands].sort((x, y) => Math.abs(x.length - compact) - Math.abs(y.length - compact) || dist(palRgb(x), cl.rgb) - dist(palRgb(y), cl.rgb));
      }
      const m = tally.get(pk.cluster) ?? new Map<string, number>();
      m.set(cands[0], (m.get(cands[0]) ?? 0) + 1);
      tally.set(pk.cluster, m);
    }
  };
  const dist = (p: { r: number; g: number; b: number } | null, q: { r: number; g: number; b: number }) => (p ? Math.hypot(p.r - q.r, p.g - q.g, p.b - q.b) : 1e9);

  const decide = (id: number): string | null => {
    const m = tally.get(id);
    const n = picked.get(id) ?? 0;
    if (!m || !n) return null;
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const [code, v] = ranked[0];
    if (ranked.length > 1 && ranked[1][1] === v) {
      // 平票：保留颜色匹配
      return ranked.find(([c]) => c === clusters[id].colorCode)?.[0] ?? null;
    }
    // 过半数同意（1 票的簇：唯一一票；2 票的簇需两票一致）；否则只有与颜色匹配一致时才采纳
    if (n === 1 || (v >= 2 && v * 2 > n) || code === clusters[id].colorCode) return code;
    return null;
  };

  // 1) 簇平均字形：同色格子对齐平均后整体识别（抗水印 / JPEG 噪点）；2) 没读出的簇再退回逐格投票
  const rest = eligible.filter((c) => !gv[c.id]);
  if (rest.length) await runRound(rest.map((c) => c.id), perCluster);
  const unresolved = rest.filter((c) => decide(c.id) === null && c.count > (picked.get(c.id) ?? 0)).map((c) => c.id);
  if (unresolved.length) await runRound(unresolved.slice(0, 40), Math.min(5, perCluster + 2));
  const votes: Record<number, string> = {};
  for (const c of eligible) {
    const v = gv[c.id] ?? decide(c.id);
    if (v) votes[c.id] = v;
  }
  for (const [id, code] of Object.entries(gv)) if (!votes[Number(id)]) votes[Number(id)] = code;
  // 证据太少（文字太小 / 识别很差）时整体放弃：几票很可能是误读，宁可按颜色匹配
  if (Object.keys(votes).length < Math.max(3, Math.ceil(eligible.length * 0.25))) {
    for (const k of Object.keys(votes)) delete votes[Number(k)];
  }
  const decided = Object.entries(votes);
  const agree = decided.filter(([id, code]) => code === clusters[Number(id)].colorCode).length;
  const dup = new Set(decided.map(([, c]) => c)).size < decided.length;
  let recovered = 0;
  if (decided.length >= 8 && (agree / decided.length < 0.9 || dup) && agree / decided.length < 0.6) {
    // 颜色整体漂移（一致率低）：用文字读出的色号当“标准答案”，拟合 颜色→色卡 的校正，再补全 / 纠正个别读错的簇
    recovered = calibrateVotes(clusters.filter((c) => !c.empty), votes);
  } else if (decided.length >= 4 && agree / decided.length >= 0.6) {
    // 颜色匹配整体可靠时，只采纳“颜色上也说得过去”的不一致结果，防止少数 OCR 误读（如 A17 读成 A7）推翻正确的颜色匹配
    for (const [id, code] of decided) {
      const cl = clusters[Number(id)];
      if (code === cl.colorCode) continue;
      const pal = MARD_PALETTE.find((p) => p.code === code);
      if (!pal || ciede2000(rgbToLab(cl.rgb), pal.lab) > 8) delete votes[Number(id)];
    }
  }
  // 3) 水印 / JPEG 噪点把同一颜色拆成的小碎簇：颜色与某个已读簇几乎相同、且小得多 → 并入它（同色号）
  let merged = 0;
  if (Object.keys(votes).length >= 3) {
    const labs = clusters.map((c) => rgbToLab(c.rgb));
    for (const c of clusters) {
      if (votes[c.id] || c.empty) continue;
      let bi = -1, bd = Infinity;
      for (const idStr of Object.keys(votes)) {
        const j = Number(idStr);
        if (clusters[j].count < 2.5 * c.count) continue;
        const d = ciede2000(labs[c.id], labs[j]);
        if (d < bd) { bd = d; bi = j; }
      }
      if (bi >= 0 && bd <= 5) { votes[c.id] = votes[bi]; merged += 1; }
    }
  }
  return { votes, total: Math.max(eligible.length, Object.keys(votes).length - merged), recovered, glyph: glyphGroups, merged };
}

/**
 * 颜色整体漂移时：用已读出的簇（颜色 → 色卡色）逐通道拟合线性校正，剔除离群点后，
 * 对每个簇用校正后的颜色重新匹配色卡，补全缺失的 / 纠正与校正色明显不符的投票。返回补全 / 纠正的簇数。
 */
function calibrateVotes(clusters: ColorCluster[], votes: Record<number, string>): number {
  const pal = new Map(MARD_PALETTE.map((p) => [p.code, p]));
  let pts = Object.entries(votes).flatMap(([id, code]) => {
    const p = pal.get(code);
    return p ? [{ id: Number(id), x: clusters.find((c) => c.id === Number(id))!.rgb, y: p.rgb }] : [];
  });
  type Coef = Array<[number, number]>;
  const fit = (use: typeof pts): Coef => (["r", "g", "b"] as const).map((ch) => {
    const n = use.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of use) { sx += p.x[ch]; sy += p.y[ch]; sxx += p.x[ch] * p.x[ch]; sxy += p.x[ch] * p.y[ch]; }
    const den = n * sxx - sx * sx;
    const a = Math.abs(den) < 1e-6 ? 1 : (n * sxy - sx * sy) / den;
    return [a, (sy - a * sx) / n] as [number, number];
  });
  const apply = (k: Coef, c: { r: number; g: number; b: number }) => ({
    r: Math.min(255, Math.max(0, k[0][0] * c.r + k[0][1])),
    g: Math.min(255, Math.max(0, k[1][0] * c.g + k[1][1])),
    b: Math.min(255, Math.max(0, k[2][0] * c.b + k[2][1]))
  });
  let k = fit(pts);
  let res: number[] = [];
  for (let iter = 0; iter < 4; iter += 1) {
    res = pts.map((p) => ciede2000(rgbToLab(apply(k, p.x)), rgbToLab(p.y)));
    const med = [...res].sort((x, y) => x - y)[Math.floor(res.length / 2)];
    const keep = pts.filter((_, i) => res[i] <= Math.max(6, 2.5 * med));
    if (keep.length === pts.length || keep.length < 8) break;
    pts = keep;
    k = fit(pts);
  }
  res = pts.map((p) => ciede2000(rgbToLab(apply(k, p.x)), rgbToLab(p.y)));
  if (pts.length < 8 || [...res].sort((x, y) => x - y)[Math.floor(res.length / 2)] > 8) return 0;

  let changed = 0;
  for (const c of clusters) {
    const lab = rgbToLab(apply(k, c.rgb));
    let best = "", bd = Infinity;
    for (const p of MARD_PALETTE) {
      const d = ciede2000(lab, p.lab);
      if (d < bd) { bd = d; best = p.code; }
    }
    const v = votes[c.id];
    if (v) {
      const pv = pal.get(v);
      if (pv && ciede2000(lab, pv.lab) <= 6) continue;
      if (bd <= 4 && best !== v) { votes[c.id] = best; changed += 1; }
    } else if (bd <= 4) {
      votes[c.id] = best;
      changed += 1;
    }
  }
  return changed;
}

// ── 抬头 / 标尺 / 色卡核对 ──

function wordsToLines(words: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }>): string {
  const ws = [...words].sort((p, q) => (p.bbox.y0 + p.bbox.y1) - (q.bbox.y0 + q.bbox.y1));
  const lines: typeof ws[] = [];
  for (const w of ws) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2, h = Math.max(1, w.bbox.y1 - w.bbox.y0);
    const last = lines[lines.length - 1];
    const lc = last ? (last[0].bbox.y0 + last[0].bbox.y1) / 2 : 0;
    if (last && Math.abs(lc - cy) < 0.6 * h) last.push(w); else lines.push([w]);
  }
  return lines.map((l) => l.sort((p, q) => p.bbox.x0 - q.bbox.x0).map((w) => w.text).join(" ")).join("\n");
}

/** 读图片上方的抬头条带（到网格上沿为止，最多 320px），解析尺寸 / 色数 / 总数。小字所以放大到 3 倍，识别不出再换整块文字模式。 */
async function readHeader(src: PixelSource, hi: PixelSource, signal: AbortSignal, bottom: number): Promise<HeaderInfo> {
  const { ocrWords } = await import("./ocr");
  const f = hi.width / src.width;
  const hh = Math.max(24, Math.min(bottom, 320));
  const rr = scaleRect({ x: 0, y: 0, width: src.width, height: hh }, f);
  const raw = cropSource(hi, rr);
  const box = contentBox(raw, 4);
  const empty: HeaderInfo = { cols: null, rows: null, colors: null, total: null };
  if (!box) return empty;
  const img = cropSource(raw, box);
  // 按行拆开：抬头常是“大标题 + 一行小字”，混在一起识别小字会被忽略；每行单独放大到字高约 30px 再读
  const lines = splitTextLines(img);
  let text = "";
  let used = 0;
  for (const ln of lines.filter((l) => l.height >= 10 && l.height <= 120 && l.width / l.height <= 60).slice(0, 4)) {
    const lineImg = cropSource(img, ln);
    let scale = Math.min(4, Math.max(1.5, 36 / ln.height));
    if (ln.height * scale > 160) scale = Math.max(1, 160 / ln.height);
    if (lineImg.width * scale > 5200) scale = Math.max(1, 5200 / lineImg.width);
    const res = await ocrWords(lineImg, signal, { scale, psm: "7" });
    text += res.text + "\n";
    used += 1;
    const info = parseHeaderText(text);
    if (info.cols && info.rows && info.total) return info;
  }
  const info = parseHeaderText(text);
  if (info.cols || info.total || info.colors || used === 0) return info;
  // 兜底：整块稀疏文字
  const side = Math.max(img.width, img.height);
  const res = await ocrWords(img, signal, { scale: side < 1600 ? 2 : 1, psm: "11" });
  return parseHeaderText(res.text + "\n" + wordsToLines(res.words));
}

/** 按横向投影把一块区域拆成文字行（与底色不同的像素行），返回各行外接矩形（含上下 3px 边距）。 */
function splitTextLines(img: PixelSource): RectI[] {
  const { width: w, height: h, data: d } = img;
  const votes = new Map<number, number>();
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 3) {
    const i = (y * w + x) * 4;
    const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  let bk = 0, bv = -1;
  for (const [k, v] of votes) if (v > bv) { bv = v; bk = k; }
  const br = ((bk >> 8) << 4) + 8, bg = (((bk >> 4) & 15) << 4) + 8, bb = ((bk & 15) << 4) + 8;
  const rowInk: number[] = [];
  for (let y = 0; y < h; y += 1) {
    let n = 0;
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb) > 60) n += 1;
    }
    rowInk.push(n);
  }
  const out: RectI[] = [];
  let start = -1, gap = 0;
  for (let y = 0; y <= h; y += 1) {
    const on = y < h && rowInk[y] >= 2;
    if (on) { if (start < 0) start = y; gap = 0; }
    else if (start >= 0) {
      gap += 1;
      if (gap > 3 || y === h) {
        const end = y - gap;
        if (end - start + 1 >= 6) {
          const y0 = Math.max(0, start - 3), y1 = Math.min(h - 1, end + 3);
          // 横向也裁到有字的范围：整行很宽（全图宽）时放大不动，字会太小；裁窄后才能放大到字高约 30px
          let xa = w, xb = -1;
          for (let y = start; y <= end; y += 1) for (let x = 0; x < w; x += 1) {
            const i = (y * w + x) * 4;
            if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb) > 60) { if (x < xa) xa = x; if (x > xb) xb = x; }
          }
          if (xb - xa >= 12) { xa = Math.max(0, xa - 8); xb = Math.min(w - 1, xb + 8); out.push({ x: xa, y: y0, width: xb - xa + 1, height: y1 - y0 + 1 }); }
        }
        start = -1;
      }
    }
  }
  return out;
}

/**
 * 标尺（坐标数字）行列带网格线时会被检测成格子。判据：
 *  ① 某颜色簇 ≥90% 的格子在最外两圈内（如蓝紫色标尺底色），最外一行 / 列 ≥75% 属于这类簇；
 *  ② 最外一行 / 列几乎每格都有文字，却是背景色簇，而该背景色簇在内部基本无字（白底标尺 + 数字）。
 */
function trimRulers(src: PixelSource, grid0: GridDetection, treatEmpty: boolean): { grid: GridDetection; trimmed: number } {
  let grid = grid0;
  let trimmed = 0;
  for (let iter = 0; iter < 4; iter += 1) {
    if (grid.cols < 10 || grid.rows < 10) break;
    const r = readGrid(src, grid, { treatBackgroundAsEmpty: treatEmpty, useInk: false });
    const cl = r.clusters, cc = r.cellCluster, ink = r.cellInk;
    if (!cl || !cc || !ink) break;
    const { cols, rows } = grid;
    const ring = (i: number) => { const x = i % cols, y = Math.floor(i / cols); return x < 2 || y < 2 || x >= cols - 2 || y >= rows - 2; };
    const rulerLike = cl.map((c) => c.count >= 6 && c.cells.filter(ring).length / c.count >= 0.9);
    // 背景簇内部的墨迹率
    const innerInk = cl.map((c) => { const inner = c.cells.filter((i) => !ring(i)); return inner.length ? inner.filter((i) => ink[i]).length / inner.length : 1; });
    const strip = (side: "t" | "b" | "l" | "r") => {
      const idx: number[] = [];
      if (side === "t") for (let x = 0; x < cols; x += 1) idx.push(x);
      if (side === "b") for (let x = 0; x < cols; x += 1) idx.push((rows - 1) * cols + x);
      if (side === "l") for (let y = 0; y < rows; y += 1) idx.push(y * cols);
      if (side === "r") for (let y = 0; y < rows; y += 1) idx.push(y * cols + cols - 1);
      return idx;
    };
    // relaxed：对边已判定是标尺时（标尺总是四边对称）放宽门槛——JPEG 压缩后一侧的数字可能糊掉
    const isRuler = (side: "t" | "b" | "l" | "r", relaxed = false) => {
      // 去掉两端的角格（角上常是别的颜色）
      const idx = strip(side).slice(1, -1);
      const rl = idx.filter((i) => cc[i] >= 0 && rulerLike[cc[i]]).length / idx.length;
      if (rl >= (relaxed ? 0.3 : 0.75)) return true;
      const inkRate = idx.filter((i) => ink[i]).length / idx.length;
      const bg = idx.filter((i) => cc[i] >= 0 && cl[cc[i]].empty && innerInk[cc[i]] < 0.15).length / idx.length;
      return relaxed ? inkRate >= 0.35 && bg >= 0.6 : inkRate >= 0.7 && bg >= 0.8;
    };
    let t = isRuler("t"), b = isRuler("b"), l = isRuler("l"), rr = isRuler("r");
    if (t !== b) { if (t) b = isRuler("b", true); else t = isRuler("t", true); }
    if (l !== rr) { if (l) rr = isRuler("r", true); else l = isRuler("l", true); }
    if (!t && !b && !l && !rr) break;
    const g = { ...grid };
    if (t) { g.y0 += g.pitchY; g.rows -= 1; trimmed += 1; }
    if (b) { g.rows -= 1; trimmed += 1; }
    if (l) { g.x0 += g.pitchX; g.cols -= 1; trimmed += 1; }
    if (rr) { g.cols -= 1; trimmed += 1; }
    grid = g;
  }
  return { grid, trimmed };
}

/** 色卡不是 MARD（或图片整体偏色）：图例色块 / 格内色号与 MARD 色值普遍相差很大。 */
function detectPaletteMismatch(
  legend: LegendReading | null, reading: GridReading | null, stats: AnalyzeResult["cellCodeStats"]
): string | null {
  const msg = "图纸上的颜色与 MARD 色卡相差很大，色号可能来自其他品牌（或图片偏色）；用量按图上写的色号统计，颜色仅供参考";
  if (legend?.colors) {
    const des: number[] = [];
    for (const [code, rgb] of Object.entries(legend.colors)) {
      const pal = MARD_PALETTE.find((p) => p.code === code);
      if (pal) des.push(ciede2000(rgbToLab(rgb), pal.lab));
    }
    if (des.length >= 5) {
      des.sort((x, y) => x - y);
      if (des[des.length >> 1] > 15) return msg;
    }
  }
  if (reading?.clusters && stats && stats.clusters >= 6) {
    const decided = reading.clusters.filter((c) => !c.empty && c.code);
    const disagree = decided.filter((c) => c.code !== c.colorCode).length;
    if (decided.length >= 6 && disagree / decided.length >= 0.6) return msg;
  }
  return null;
}


/**
 * 背景是“空”还是“某色豆子”：用图例（逐色用量）或抬头总数裁决。
 * 例：游戏王图纸的整片背景其实是 H2 白豆，图例 H2 ≈ 主体 + 背景。成立时把背景格并入该色号（原地修改 reading）。
 */
export function decideBackground(reading: GridReading, legend: LegendReading | null, total: number | null): { code: string; why: string } | null {
  const mask = reading.backgroundMask;
  const n = reading.backgroundCells ?? 0;
  if (!mask || n < 8) return null;
  const subj = sum(reading.counts);
  let pick: { code: string; why: string } | null = null;
  // 画像素式图纸：边缘背景格里每格都印着色号（H2 白豆铺满整张图），图例里 H2 的数字常因字小读错，所以不依赖图例数量；
  // 只有抬头 / 图上总数明确说“主体已经对上”时才不采用
  const subjOk = !!total && Math.abs(subj - total) / total <= 0.015 && Math.abs(subj + n - total) / total > 0.015;
  if ((reading.backgroundInkFrac ?? 0) >= 0.9 && !subjOk) {
    pick = { code: "H2", why: `背景格里每格都印着色号（铺满整张图的 H2 白豆）` };
  } else if (legend) {
    let bestGain = 0;
    for (const [code, l] of Object.entries(legend.counts)) {
      const r = reading.counts[code] ?? 0;
      const errWithout = Math.abs(l - r);
      const errWith = Math.abs(l - (r + n));
      // 该色缺口约等于背景格数，且并入后误差缩到原来的 1/3 以内、不超过 8%
      if (l - r >= 0.6 * n && errWith <= 0.08 * l && errWith * 3 <= errWithout && errWithout - errWith > bestGain) {
        bestGain = errWithout - errWith;
        pick = { code, why: `图例 ${code} ${fmt(l)}，主体只有 ${fmt(r)}，加上背景 ${fmt(r + n)}` };
      }
    }
    if (pick && total) {
      // 总数也要支持：并入后更接近总数
      if (!(Math.abs(subj + n - total) < Math.abs(subj - total))) pick = null;
    }
  } else if (total) {
    const withBg = Math.abs(subj + n - total) / total;
    const without = Math.abs(subj - total) / total;
    if (without > 0.05 && withBg <= 0.02) {
      const light = Object.keys(reading.counts).find((c) => /^(H2|H1|T1|P1)$/.test(c)) ?? "H2";
      pick = { code: light, why: `抬头共 ${fmt(total)} 颗，主体 ${fmt(subj)}，加上背景 ${fmt(subj + n)}` };
    }
  }
  if (!pick) return null;
  const { cols, rows } = reading.grid;
  for (let y = 0; y < rows; y += 1) for (let x = 0; x < cols; x += 1) if (mask[y * cols + x]) reading.matrix[y][x] = pick.code;
  reading.counts[pick.code] = (reading.counts[pick.code] ?? 0) + n;
  reading.emptyCells -= n;
  const st = reading.colors.find((c) => c.code === pick!.code);
  if (st) st.count += n;
  else reading.colors.push({ code: pick.code, count: n, deltaE: 0, sampleHex: reading.backgroundHex ?? "#ffffff" });
  reading.backgroundAssigned = { code: pick.code, cells: n };
  reading.backgroundMask = new Uint8Array(mask.length);
  reading.backgroundCells = 0;
  return pick;
}
