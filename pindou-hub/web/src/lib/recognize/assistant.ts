// “豆探”助手：把网格检测、图例 OCR、读色串起来，给出最终用量与可解释的步骤。
import { ciede2000, rgbToLab } from "@engine/color";
import { MARD_PALETTE } from "@engine/palette";
import { detectGrid, readGrid } from "./grid";
import { cellCodeCandidates, chipStack, findChips, findStatedTotal, parseChipTexts, parseLegendWords } from "./legend";
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

  // 1) 网格
  throwIfAborted(signal);
  let grid: GridDetection | null = null;
  try {
    grid = detectGrid(src, options.region ?? null);
  } catch {
    grid = null;
  }
  grid = applyForce(grid, src, options);
  if (grid) {
    const forced = options.forceCols || options.forceRows ? "（已按手动行列调整）" : "";
    step("grid", "检测网格", grid.score >= 0.6 ? "ok" : "warn",
      `检测到 ${grid.cols}×${grid.rows} 网格（置信 ${grid.score.toFixed(2)}）${forced}`);
  } else {
    step("grid", "检测网格", "fail", "没有找到规则网格；可以框选图纸区域，或手动填写列数和行数");
  }
  await tick();

  // 2) 图例 OCR（总时限 OCR_BUDGET_MS，超时则放弃图例、继续用网格结果）
  throwIfAborted(signal);
  let legend: LegendReading | null = null;
  if (options.ocr === false || options.legendOcr === false) {
    step("legend", "读取图例", "skip", "已跳过图例识别");
  } else {
    const t0 = performance.now();
    try {
      const parsed = await withDeadline(signal, OCR_BUDGET_MS, (sig) => readLegend(src, options.ocrSource ?? src, grid, sig));
      if (parsed.items.length >= 2) {
        legend = parsed;
        const total = sum(parsed.counts);
        step("legend", "读取图例", "ok", `读到图例 ${parsed.items.length} 色，合计 ${fmt(total)} 颗`
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

  // 3) 读色
  throwIfAborted(signal);
  let reading: GridReading | null = null;
  if (grid) {
    const legendCodes = legend ? legend.items.map((i) => i.code) : null;
    reading = readGrid(src, grid, {
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
        const r = await withDeadline(signal, CELL_BUDGET_MS, (sig) => readCellCodes(src, options.ocrSource ?? src, grid!, reading!, sig));
        const nVotes = Object.keys(r.votes).length;
        const nRead = nVotes - r.recovered;
        if (nVotes > 0) {
          const before = reading;
          const next = readGrid(src, grid, {
            allowedCodes: options.allowedCodes ?? null,
            treatBackgroundAsEmpty: options.treatBackgroundAsEmpty ?? true,
            legendCodes: legend ? legend.items.map((i) => i.code) : null,
            legendColors: legend?.colors ?? null,
            cellVotes: r.votes
          });
          const overrides = (next.clusters ?? []).filter((c) => c.overridden).length;
          // 整体数量差异大得离谱（如投票把背景簇当成豆子）时不采用
          if (sum(next.counts) > 0) {
            reading = next;
            cellCodesRead = true;
            cellCodeStats = { read: nRead, clusters: r.total, overrides };
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

  // OCR 数字常见混淆（3↔8、末尾多读一位等）：与网格统计差得远、但改一位后吻合的，采用改后的值
  if (legend && reading) {
    const fixed = reconcileLegend(legend, reading);
    if (fixed > 0) step("legend-fix", "校正图例数字", "warn", `按网格统计校正了 ${fixed} 个疑似 OCR 误读的数量`);
  }

  // 4) 汇总
  const diff: AnalyzeResult["diff"] = [];
  let counts: Counts = {};
  let method: AnalyzeResult["method"] = "none";
  let confidence = 0;

  if (legend && reading) {
    // 图例没读全（OCR 漏读色号）：网格里有、图例里没有的色号，用网格统计补上
    const added: string[] = [];
    counts = { ...legend.counts }; // 图例是作者写的数字，优先采用
    for (const [code, n] of Object.entries(reading.counts)) {
      if (!(code in legend.counts) && n > 0) { counts[code] = n; added.push(code); }
    }
    const lt = sum(counts);
    const gt = sum(reading.counts);
    const codes = new Set([...Object.keys(counts), ...Object.keys(reading.counts)]);
    let abs = 0;
    for (const code of [...codes].sort()) {
      const l = legend.counts[code] ?? 0;
      const g = reading.counts[code] ?? 0;
      diff.push({ code, legend: l, grid: g });
      abs += Math.abs(l - g);
    }
    const mismatch = diff.filter((d) => d.legend !== d.grid && !added.includes(d.code)).length;
    const agreement = Math.max(0, 1 - abs / Math.max(lt, gt, 1));
    if (added.length) step("legend-missing", "补全图例", "warn", `图例漏读 ${added.length} 个色号（${added.join("、")}），已按网格统计补上`);
    if (Math.abs(lt - gt) / Math.max(lt, gt, 1) <= 0.03) {
      method = "legend+grid";
      confidence = 0.75 + 0.2 * agreement;
      step("compare", "图例与网格对照", mismatch ? "warn" : "ok",
        mismatch
          ? `总数吻合（图例 ${fmt(lt)} / 网格 ${fmt(gt)}），网格统计与图例有 ${mismatch} 个色号不一致`
          : `图例与网格完全一致，共 ${fmt(lt)} 颗`);
    } else {
      method = "legend";
      confidence = 0.5 + 0.25 * agreement;
      step("compare", "图例与网格对照", "warn",
        `图例合计 ${fmt(lt)} 颗，网格数出 ${fmt(gt)} 颗，差异较大，有 ${mismatch} 个色号不一致；已采用图例数字`);
    }
    if (legend.statedTotal && Math.abs(legend.statedTotal - lt) / Math.max(lt, 1) <= 0.01) confidence += 0.05;
    else if (legend.statedTotal) confidence -= 0.1;
  } else if (legend) {
    counts = { ...legend.counts };
    method = "legend";
    confidence = 0.6;
    if (legend.statedTotal) {
      confidence += Math.abs(legend.statedTotal - sum(counts)) / Math.max(sum(counts), 1) <= 0.01 ? 0.2 : -0.1;
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
  return { steps, legend, grid: reading, counts, method, confidence, diff, source, cellCodesRead, cellCodeStats };
}

// ── helpers ──

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

const OCR_BUDGET_MS = 25_000;
const CELL_BUDGET_MS = 10_000;

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
async function readLegend(src: PixelSource, hi: PixelSource, grid: GridDetection | null, signal: AbortSignal): Promise<LegendReading> {
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
  if (crop) {
    throwIfAborted(signal);
    const chips = findChips(crop.img, Math.max(12, Math.round(0.015 * hi.width)));
    if (chips.length >= 3) {
      const heights = chips.map((c) => c.height).sort((a, b) => a - b);
      // 目标：文字 x 高约 20–30px；色块高约是字高的 2.4 倍 → 放大到色块高 ≈ 65px
      const scale = Math.min(4, Math.max(1, 65 / heights[heights.length >> 1]));
      const stack = chipStack(crop.img, chips, scale);
      const res = await ocrWords(stack.image, signal, { scale: 1, psm: "6" });
      const rows = stack.rows.map((r) => ({
        chip: r.chip,
        text: res.words.filter((w) => { const cy = (w.bbox.y0 + w.bbox.y1) / 2; return cy >= r.y0 && cy < r.y1; })
          .sort((a, b) => a.bbox.x0 - b.bbox.x0).map((w) => w.text).join(" ")
      }));
      const parsed = parseChipTexts(rows, VALID_CODES, (code) => MARD_PALETTE.find((c) => c.code === code)?.rgb ?? null);
      result = { ...parsed, statedTotal: findStatedTotal(res.text) };
    }
    if (result.items.length < 2) {
      const side = Math.max(crop.img.width, crop.img.height);
      const scale = side < 1600 ? 2 : side > 3200 ? 1 : 1.5;
      const res = await ocrWords(crop.img, signal, { scale });
      const parsed = parseLegendWords(res.words, VALID_CODES, null);
      if (parsed.items.length > result.items.length) result = parsed;
    }
  }
  if (result.statedTotal === null && header) {
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

const DIGIT_PARTNER: Record<string, string[]> = {
  "0": ["8", "6"], "1": ["7"], "3": ["8"], "5": ["6", "3"], "6": ["5", "8", "0"], "7": ["1"], "8": ["3", "0", "6"], "9": ["8", "4"]
};

/** 返回被校正的条目数。 */
function reconcileLegend(legend: LegendReading, reading: GridReading): number {
  const grid = reading.counts;
  let fixed = 0;
  for (const item of legend.items) {
    const g = grid[item.code] ?? 0;
    if (g < 5) continue;
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
    if (best === null) {
      // 改一位也对不上：若该色号的图例色块颜色被网格精确匹配（ΔE≤2），以网格数为准（OCR 很可能读错了）
      const st = reading.colors.find((c) => c.code === item.code);
      if (legend.colors?.[item.code] && st && st.deltaE <= 2) best = g;
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
    if (used.has(i) || !ink[i]) continue;
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
  src: PixelSource, hi: PixelSource, grid: GridDetection, reading: GridReading, signal: AbortSignal
): Promise<{ votes: Record<number, string>; total: number; recovered: number }> {
  const { ocrWords } = await import("./ocr");
  const f = hi.width / src.width;
  const clusters = reading.clusters!;
  const eligible = clusters.filter((c) => c.inkCells >= Math.max(1, Math.ceil(c.count * 0.5)));
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

  await runRound(eligible.map((c) => c.id), 5);
  const unresolved = eligible.filter((c) => decide(c.id) === null && c.count > (picked.get(c.id) ?? 0)).map((c) => c.id);
  if (unresolved.length) await runRound(unresolved, 5);
  const votes: Record<number, string> = {};
  for (const c of eligible) {
    const v = decide(c.id);
    if (v) votes[c.id] = v;
  }
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
    recovered = calibrateVotes(eligible, votes);
  } else if (decided.length >= 4 && agree / decided.length >= 0.6) {
    // 颜色匹配整体可靠时，只采纳“颜色上也说得过去”的不一致结果，防止少数 OCR 误读（如 A17 读成 A7）推翻正确的颜色匹配
    for (const [id, code] of decided) {
      const cl = clusters[Number(id)];
      if (code === cl.colorCode) continue;
      const pal = MARD_PALETTE.find((p) => p.code === code);
      if (!pal || ciede2000(rgbToLab(cl.rgb), pal.lab) > 8) delete votes[Number(id)];
    }
  }
  return { votes, total: eligible.length, recovered };
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
