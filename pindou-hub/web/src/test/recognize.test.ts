import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MARD_PALETTE } from "@engine/palette";
import { analyzePattern } from "../lib/recognize/assistant";
import { detectGrid, readGrid } from "../lib/recognize/grid";
import { chipStack, findChips, parseChipTexts, parseLegendText, parseLegendWords } from "../lib/recognize/legend";
import { setOcrBackend, terminateOcr } from "../lib/recognize/ocr";
import { buildChart, createNodeOcrBackend, decodePng, downscaleArea, driftColors, gradientImage, TEST_CODES } from "./fixtures";

const VALID = new Set(MARD_PALETTE.map((c) => c.code));

function expectGridMatches(chart: ReturnType<typeof buildChart>, cols: number, rows: number, opts?: { tol?: number }) {
  const g = detectGrid(chart.src);
  expect(g).not.toBeNull();
  expect(g!.cols).toBe(cols);
  expect(g!.rows).toBe(rows);
  const reading = readGrid(chart.src, g!, { allowedCodes: TEST_CODES, legendCodes: null });
  const tol = opts?.tol ?? 0;
  for (const code of TEST_CODES) {
    expect(Math.abs((reading.counts[code] ?? 0) - (chart.counts[code] ?? 0))).toBeLessThanOrEqual(tol);
  }
  const total = Object.values(chart.counts).reduce((a, b) => a + b, 0);
  expect(Object.values(reading.counts).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(total - tol);
  return { g: g!, reading };
}

describe("detectGrid / readGrid", () => {
  it("30x20, 非整数格距 12.5, 细线+粗线+文字块+标题/图例带", () => {
    const chart = buildChart({ cols: 30, rows: 20, pitch: 12.5, boldEvery: 5, textBlobs: true, emptyFrac: 0.12 });
    const { g, reading } = expectGridMatches(chart, 30, 20);
    expect(Math.abs(g.pitchX - 12.5)).toBeLessThan(0.15);
    expect(Math.abs(g.x0 - chart.x0)).toBeLessThan(1.5);
    expect(reading.emptyCells).toBe(30 * 20 - Object.values(chart.counts).reduce((a, b) => a + b, 0));
    // 空格位置也要对上
    for (let y = 0; y < 20; y += 1) for (let x = 0; x < 30; x += 1) expect(reading.matrix[y][x]).toBe(chart.matrix[y][x]);
  });

  it("无网格线（纯色块，整数格距 10）", () => {
    const chart = buildChart({ cols: 40, rows: 25, pitch: 10, lineWidth: 0, solidBorder: true, emptyFrac: 0.1, seed: 7 });
    expectGridMatches(chart, 40, 25);
  });

  it("照片式噪点 ±10 仍可检测", () => {
    const chart = buildChart({ cols: 30, rows: 20, pitch: 12.5, boldEvery: 5, textBlobs: true, noise: 10, seed: 3 });
    expectGridMatches(chart, 30, 20, { tol: 2 });
  });

  it("较大格距 + 每 10 格粗线（52x40, 格距 18.3）", () => {
    const chart = buildChart({ cols: 52, rows: 40, pitch: 18.3, boldEvery: 10, textBlobs: true, seed: 11 });
    expectGridMatches(chart, 52, 40);
  });

  it("框选区域（region）只在区域内检测", () => {
    const chart = buildChart({ cols: 30, rows: 20, pitch: 12.5, boldEvery: 5, seed: 5 });
    const g = detectGrid(chart.src, { x: chart.x0 - 20, y: chart.y0 - 20, width: chart.gridWidth + 40, height: chart.gridHeight + 40 });
    expect(g?.cols).toBe(30);
    expect(g?.rows).toBe(20);
  });

  it("平滑渐变图返回 null；assistant 返回 method none 而不抛错", async () => {
    const img = gradientImage(300, 300);
    expect(detectGrid(img)).toBeNull();
    const res = await analyzePattern(img, { ocr: false });
    expect(res.method).toBe("none");
    expect(res.steps.some((s) => s.status === "fail")).toBe(true);
  });

  it("纯白图也不会误检", () => {
    const data = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    expect(detectGrid({ width: 200, height: 200, data })).toBeNull();
  });

  it("2400px 合成图运行时间", () => {
    const chart = buildChart({ cols: 96, rows: 96, pitch: 24.5, boldEvery: 10, textBlobs: true, margin: { left: 24, top: 24, right: 24, bottom: 24 }, titleBand: false, legendBand: false, seed: 9 });
    expect(chart.src.width).toBeGreaterThan(2300);
    const t0 = performance.now();
    const g = detectGrid(chart.src);
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`detectGrid ${chart.src.width}x${chart.src.height}: ${ms.toFixed(0)} ms`);
    expect(g?.cols).toBe(96);
    expect(g?.rows).toBe(96);
    expect(ms).toBeLessThan(3000);
  });
});

describe("analyzePattern (无 OCR)", () => {
  it("只有网格时 method=grid，用量与真值一致", async () => {
    const chart = buildChart({ cols: 30, rows: 20, pitch: 12.5, boldEvery: 5, textBlobs: true, seed: 21 });
    const steps: string[] = [];
    const res = await analyzePattern(chart.src, { ocr: false, allowedCodes: TEST_CODES, onProgress: (s) => steps.push(s.id) });
    expect(res.method).toBe("grid");
    expect(res.counts).toEqual(chart.counts);
    expect(res.confidence).toBeGreaterThan(0.5);
    expect(steps).toContain("grid");
    expect(res.steps.find((s) => s.id === "grid")?.detail).toContain("30×20");
  });

  it("forceCols/forceRows 覆盖检测结果", async () => {
    const chart = buildChart({ cols: 30, rows: 20, pitch: 12.5, boldEvery: 5, seed: 22 });
    const res = await analyzePattern(chart.src, { ocr: false, forceCols: 15, forceRows: 10 });
    expect(res.grid?.grid.cols).toBe(15);
    expect(res.grid?.grid.rows).toBe(10);
  });

  it("AbortSignal 已取消时抛 AbortError", async () => {
    const chart = buildChart({ cols: 30, rows: 20, pitch: 12.5, seed: 23 });
    const ac = new AbortController();
    ac.abort();
    await expect(analyzePattern(chart.src, { ocr: false, signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("parseLegendText", () => {
  it("括号 / 冒号 / 乘号写法", () => {
    const r = parseLegendText("A1(125) B2: 88 H7 ×320\nC7 x 45 F5=12", VALID);
    expect(r.counts).toEqual({ A1: 125, B2: 88, H7: 320, C7: 45, F5: 12 });
  });

  it("全角标点与数字 + 总计", () => {
    const r = parseLegendText("A1：１２５  B2（８８） H7 ×３２０  总计：５３３", VALID);
    expect(r.counts).toEqual({ A1: 125, B2: 88, H7: 320 });
    expect(r.statedTotal).toBe(533);
  });

  it("OCR 混淆 O→0, l/I/|→1, 小写色号", () => {
    const r = parseLegendText("a1 l25  b2: 8O  h7 x3I0  C7 (|2)", VALID);
    expect(r.counts).toEqual({ A1: 125, B2: 80, H7: 310, C7: 12 });
  });

  it("颗/粒/个/pcs 后缀与千分位总数", () => {
    const r = parseLegendText("C7 12颗 D20 7粒 E3 9个 F5 4pcs\n合计 2,140 颗", VALID);
    expect(r.counts).toEqual({ C7: 12, D20: 7, E3: 9, F5: 4 });
    expect(r.statedTotal).toBe(2140);
  });

  it("“共 12 色”不是总数", () => {
    expect(parseLegendText("共 12 色 A1 5", VALID).statedTotal).toBeNull();
  });

  it("两行排版（色号一行、数量下一行）", () => {
    const r = parseLegendText("A1 B2 H7\n125 88 320", VALID);
    expect(r.counts).toEqual({ A1: 125, B2: 88, H7: 320 });
  });

  it("拼豆工坊导出图：中点分隔 + 抬头“颗豆”总数", () => {
    const text = "156 × 138 格  ·  MARD 32 色  ·  11128 颗豆  ·  每板 52 针\n用色清单 · 空格不计豆 · 每 5 格辅助线 / 粗线为分板边界\nA1 · 154 颗   A26 · 4381 颗   B19 · 1472 颗";
    const r = parseLegendText(text, VALID);
    expect(r.counts).toEqual({ A1: 154, A26: 4381, B19: 1472 });
    expect(r.statedTotal).toBe(11128);
  });

  it("中点被 OCR 成 - . * 或丢失", () => {
    const r = parseLegendText("A1 - 154 颗  A26 . 4381 颗  B19 * 1472 颗  C7 • 20 颗  D20 ・ 8 颗  E3 15 颗", VALID);
    expect(r.counts).toEqual({ A1: 154, A26: 4381, B19: 1472, C7: 20, D20: 8, E3: 15 });
  });

  it("重复色号取较大值", () => {
    expect(parseLegendText("A1 10 A1 20", VALID).counts).toEqual({ A1: 20 });
  });

  it("无效色号 / 中文乱文本 / 无分隔符 不产生条目", () => {
    expect(parseLegendText("拼豆图纸 我的作品 作者 小明 2024 年", VALID).items).toHaveLength(0);
    expect(parseLegendText("A99 5 Z9 12 A125", VALID).items).toHaveLength(0);
    expect(parseLegendText("", VALID).items).toHaveLength(0);
  });
});

describe("parseLegendWords", () => {
  const w = (text: string, x0: number, y0: number, x1 = x0 + 28, y1 = y0 + 18) => ({ text, bbox: { x0, y0, x1, y1 } });

  it("色板排版：上排色号，下排数量", () => {
    const row1 = ["A1", "B2", "H7", "C7"].map((t, i) => w(t, 20 + i * 80, 400));
    const row2 = ["125", "88", "320", "45"].map((t, i) => w(t, 20 + i * 80, 424));
    const r = parseLegendWords([...row2, ...row1, w("总计", 20, 460), w("578", 70, 460)], VALID);
    expect(r.counts).toEqual({ A1: 125, B2: 88, H7: 320, C7: 45 });
    expect(r.statedTotal).toBe(578);
  });

  it("同行排版：色号右侧数量", () => {
    const words = [w("A1", 20, 10), w("125", 60, 10), w("B2", 20, 40), w("(88)", 60, 40), w("H7", 20, 70), w("x320", 60, 70)];
    const r = parseLegendWords(words, VALID);
    expect(r.counts).toEqual({ A1: 125, B2: 88, H7: 320 });
  });

  it("粘连词 A1(125)", () => {
    const r = parseLegendWords([w("A1(125)", 10, 10, 90, 28), w("B2:88", 10, 40, 90, 58)], VALID);
    expect(r.counts).toEqual({ A1: 125, B2: 88 });
  });

  it("词框：A1 / · / 154 / 颗 分开识别", () => {
    const words = [w("A1", 20, 10), w("·", 52, 10, 58), w("154", 62, 10), w("颗", 94, 10), w("A26", 130, 10), w("-", 162, 10, 168), w("4381", 172, 10), w("颗", 212, 10), w("11128", 20, 200), w("颗豆", 60, 200)];
    const r = parseLegendWords(words, VALID);
    expect(r.counts).toEqual({ A1: 154, A26: 4381 });
    expect(r.statedTotal).toBe(11128);
  });

  it("exclude 区域内的格内色号 / 标尺数字被忽略", () => {
    const inGrid = [w("A1", 110, 110), w("5", 142, 110), w("B2", 110, 140), w("7", 142, 140)];
    const legend = [w("H7", 20, 400), w("320", 20, 424)];
    const r = parseLegendWords([...inGrid, ...legend], VALID, { x: 100, y: 100, width: 200, height: 200 });
    expect(r.counts).toEqual({ H7: 320 });
  });
});

describe("legend chips", () => {
  // 合成：白底上 2 行平涂色块（颜色与色卡有偏差），块内有“文字”深色点
  const chipImage = () => {
    const w = 700, h = 200;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    const colors: Array<[number, number, number]> = [[250, 244, 200], [255, 195, 101], [253, 84, 61], [28, 51, 77], [25, 119, 157], [0, 0, 0]];
    const rects: Array<[number, number]> = [[20, 20], [190, 20], [360, 20], [20, 100], [190, 100], [360, 100]];
    rects.forEach(([x0, y0], k) => {
      const [r, g, b] = colors[k];
      for (let y = y0; y < y0 + 38; y += 1) for (let x = x0; x < x0 + 160; x += 1) {
        const i = (y * w + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
      }
      for (let y = y0 + 12; y < y0 + 26; y += 1) for (let x = x0 + 10; x < x0 + 60; x += 3) {
        const i = (y * w + x) * 4;
        data[i] = 255 - r; data[i + 1] = 255 - g; data[i + 2] = 255 - b;
      }
    });
    return { src: { width: w, height: h, data }, colors };
  };

  it("findChips 找到全部平涂色块并给出底色", () => {
    const { src, colors } = chipImage();
    const chips = findChips(src, 40);
    expect(chips).toHaveLength(6);
    const c0 = chips.find((c) => c.x === 20 && c.y === 20)!;
    expect(c0.width).toBe(160);
    expect(c0.height).toBe(38);
    expect([c0.r, c0.g, c0.b]).toEqual(colors[0]);
    const st = chipStack(src, chips, 2);
    expect(st.rows).toHaveLength(6);
    expect(st.image.height).toBeGreaterThan(6 * 20);
  });

  it("parseChipTexts：OCR 混淆纠正 + 色块颜色挑选候选 + 无色号时按颜色推断", () => {
    const chip = (r: number, g: number, b: number) => ({ x: 0, y: 0, width: 100, height: 30, r, g, b });
    const pal = new Map(MARD_PALETTE.map((c) => [c.code, c.rgb]));
    const colorOf = (code: string) => pal.get(code) ?? null;
    const h19 = MARD_PALETTE.find((c) => c.code === "H19")!.rgb;
    const f8 = MARD_PALETTE.find((c) => c.code === "F8")!.rgb;
    const r = parseChipTexts([
      { text: "Al3 - 84", chip: chip(255, 195, 101) },
      { text: "Bll - 17", chip: chip(93, 114, 42) },
      { text: "DIO - 53", chip: chip(54, 24, 81) },
      { text: "Filo - 39", chip: chip(138, 69, 38) },
      { text: "Hr - 295", chip: chip(0, 0, 0) },
      { text: "Fg - 179", chip: chip(f8.r, f8.g, f8.b) },
      { text: "- 1472", chip: chip(h19.r, h19.g, h19.b) },
      { text: "垃圾 文字", chip: chip(10, 10, 10) }
    ], VALID, colorOf);
    expect(r.counts.A13).toBe(84);
    expect(r.counts.B11).toBe(17);
    expect(r.counts.D10).toBe(53);
    expect(r.counts.F10).toBe(39);
    expect(r.counts.H7).toBe(295);
    expect(r.counts.F8).toBe(179); // g 可能是 8 也可能是 9：用色块颜色挑
    expect(r.counts.H19).toBe(1472); // 色号没读出来：由色块颜色推断
    expect(r.colors.A13).toEqual({ r: 255, g: 195, b: 101 });
  });

  it("readGrid 图例色校准：渲染色与色卡相差很大时，用图例色块颜色仍能数对", () => {
    // 让渲染色整体偏离色卡 ±40：只靠色卡会把相近的色号混淆，用图例实际色则精确
    const chart = buildChart({ cols: 30, rows: 20, pitch: 12.5, boldEvery: 5, offset: 40, textBlobs: true, seed: 41 });
    const g = detectGrid(chart.src)!;
    const legendColors: Record<string, { r: number; g: number; b: number }> = {};
    for (const [code, [r, gg, b]] of Object.entries(chart.render)) legendColors[code] = { r, g: gg, b };
    const cal = readGrid(chart.src, g, { legendCodes: TEST_CODES, legendColors });
    expect(cal.counts).toEqual(chart.counts);
  });

  it("没有 OCR 环境（node）时 analyzePattern 只给出警告并继续用网格", async () => {
    const chart = buildChart({ cols: 30, rows: 20, pitch: 12.5, boldEvery: 5, seed: 31 });
    const res = await analyzePattern(chart.src, { allowedCodes: TEST_CODES });
    expect(res.method).toBe("grid");
    expect(res.steps.find((s) => s.id === "legend")?.status).toBe("warn");
    expect(res.counts).toEqual(chart.counts);
  }, 30000);
});

// 真实样张（拼豆工坊导出，2026-09-07，旧版色卡）。文件不在时跳过。
const SAMPLE = fileURLToPath(new URL("../../../../docs/samples/agumon-detail-20260907.png", import.meta.url));
const LEGEND_CODES = ["A1", "A13", "A14", "A17", "A21", "A26", "B4", "B11", "B22", "B23", "C6", "C7", "C9", "C11", "C12", "C17", "C29",
  "D10", "D15", "F1", "F6", "F8", "F10", "F11", "G6", "G20", "H7", "H19", "R5", "R7", "R10", "R22"];
const LEGEND_COUNTS: Record<string, number> = { A1: 154, A13: 84, A14: 193, A17: 199, A21: 275, A26: 4381, B4: 48, B11: 17, B22: 38, B23: 7,
  C6: 14, C7: 22, C9: 51, C11: 76, C12: 49, C17: 17, C29: 18, D10: 53, D15: 48, F1: 259, F6: 95, F8: 179, F10: 39, F11: 901, G6: 1407,
  G20: 43, H7: 295, H19: 1472, R5: 40, R7: 11, R10: 368, R22: 275 };

describe.skipIf(!existsSync(SAMPLE))("真实样张 agumon-detail-20260907.png (156×138, 11128 颗)", () => {
  const full = existsSync(SAMPLE) ? decodePng(readFileSync(SAMPLE)) : null;

  const run = (label: string, src: NonNullable<typeof full>) => {
    let t = performance.now();
    const g = detectGrid(src);
    const detectMs = performance.now() - t;
    expect(g).not.toBeNull();
    expect(g!.cols).toBe(156);
    expect(g!.rows).toBe(138);
    // 图例色块：下方区域里找色块，按阅读顺序对应 32 个色号
    const below = Math.floor(g!.y0 + g!.rows * g!.pitchY + g!.pitchY * 1.2);
    const crop = { width: src.width, height: src.height - below, data: src.data.slice(below * src.width * 4) };
    const chips = findChips(crop, Math.max(12, Math.round(0.015 * src.width))).sort((a, b) => (Math.abs(a.y - b.y) > 0.5 * a.height ? a.y - b.y : a.x - b.x));
    expect(chips).toHaveLength(32);
    const legendColors: Record<string, { r: number; g: number; b: number }> = {};
    chips.forEach((c, i) => { legendColors[LEGEND_CODES[i]] = { r: c.r, g: c.g, b: c.b }; });

    t = performance.now();
    const cal = readGrid(src, g!, { legendCodes: LEGEND_CODES, legendColors });
    const readMs = performance.now() - t;
    const plain = readGrid(src, g!, { legendCodes: LEGEND_CODES });
    const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
    const worst = (c: Record<string, number>) => Math.max(...LEGEND_CODES.map((k) => Math.abs((c[k] ?? 0) - LEGEND_COUNTS[k]) / LEGEND_COUNTS[k]));
    // eslint-disable-next-line no-console
    console.log(`[${label}] ${src.width}x${src.height} detect ${detectMs.toFixed(0)} ms (${g!.cols}x${g!.rows}, pitch ${g!.pitchX.toFixed(2)}), read ${readMs.toFixed(0)} ms; `
      + `calibrated: total ${sum(cal.counts)} worst-err ${(worst(cal.counts) * 100).toFixed(2)}%; palette-only: total ${sum(plain.counts)} worst-err ${(worst(plain.counts) * 100).toFixed(2)}% `
      + `errs ${LEGEND_CODES.filter((k) => (plain.counts[k] ?? 0) !== LEGEND_COUNTS[k]).map((k) => `${k}:${plain.counts[k] ?? 0}/${LEGEND_COUNTS[k]}`).join(" ")}`);
    expect(sum(LEGEND_COUNTS)).toBe(11128);
    expect(sum(cal.counts)).toBe(11128);
    for (const k of LEGEND_CODES) expect(Math.abs((cal.counts[k] ?? 0) - LEGEND_COUNTS[k]) / LEGEND_COUNTS[k]).toBeLessThanOrEqual(0.02);
    // 空格（浅蓝灰）不计入
    expect(cal.emptyCells).toBe(156 * 138 - 11128);
  };

  it("缩小到最长边 2400（浏览器 loadPixelSource 的情形）", () => {
    run("2400", downscaleArea(full!, 2400));
  }, 120000);

  it("原始分辨率 4960×4631", () => {
    run("full", full!);
  }, 120000);
});

// ───────────── 格内色号 OCR（node 里用 tesseract.js；样张不在则跳过） ─────────────
describe.skipIf(!existsSync(SAMPLE))("格内色号 OCR（agumon 样张，关闭图例识别）", () => {
  const backend = createNodeOcrBackend();
  setOcrBackend(backend);
  afterAll(async () => { await terminateOcr(); setOcrBackend(null); });
  const full = existsSync(SAMPLE) ? decodePng(readFileSync(SAMPLE)) : null;
  const wrongCodes = (counts: Record<string, number>) => LEGEND_CODES.filter((k) => (counts[k] ?? 0) !== LEGEND_COUNTS[k]);
  const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

  it("(a)(c) 2400 缩小图 + 原图 ocrSource：32 个色号全对、总数 11128，并记录用时", async () => {
    const small = downscaleArea(full!, 2400);
    backend.log.length = 0;
    const t0 = performance.now();
    const res = await analyzePattern(small, { legendOcr: false, ocrSource: full! });
    const ms = performance.now() - t0;
    const cell = res.steps.find((s) => s.id === "cellcode");
    // eslint-disable-next-line no-console
    console.log(`[cell-codes 2400+ocrSource] total ${ms.toFixed(0)} ms; step: ${cell?.status} ${cell?.detail}; stats ${JSON.stringify(res.cellCodeStats)}; ocr calls ${JSON.stringify(backend.log)}; wrong ${JSON.stringify(wrongCodes(res.counts))}`);
    expect(res.cellCodesRead).toBe(true);
    expect(cell?.label).toBe("读取格内色号");
    expect(res.cellCodeStats!.read).toBeGreaterThanOrEqual(28);
    expect(backend.log.length).toBeLessThanOrEqual(2);
    expect(sum(res.counts)).toBe(11128);
    expect(wrongCodes(res.counts)).toEqual([]);
    expect(Object.keys(res.counts).sort()).toEqual([...LEGEND_CODES].sort());
  }, 180000);

  it("(a) 原始分辨率直接作为 src", async () => {
    const res = await analyzePattern(full!, { legendOcr: false });
    expect(res.cellCodesRead).toBe(true);
    expect(sum(res.counts)).toBe(11128);
    expect(wrongCodes(res.counts)).toEqual([]);
  }, 180000);

  it("(b) 颜色整体漂移：只靠颜色匹配明显出错，格内色号读取后恢复", async () => {
    const gain: [number, number, number] = [0.75, 1.1, 0.6];
    const offset: [number, number, number] = [30, -12, 60];
    const small = driftColors(downscaleArea(full!, 2400), gain, offset);
    const big = driftColors(full!, gain, offset);
    const colorOnly = await analyzePattern(small, { ocr: false });
    const wrongBefore = wrongCodes(colorOnly.counts).length;
    backend.log.length = 0;
    const t0 = performance.now();
    const res = await analyzePattern(small, { legendOcr: false, ocrSource: big });
    const ms = performance.now() - t0;
    const wrongAfter = wrongCodes(res.counts);
    // eslint-disable-next-line no-console
    console.log(`[drift] color-only wrong codes ${wrongBefore}/32 (total ${sum(colorOnly.counts)}); with cell codes wrong ${wrongAfter.length}/32 (${wrongAfter.join(",")}), total ${sum(res.counts)}, ${ms.toFixed(0)} ms; stats ${JSON.stringify(res.cellCodeStats)}; step ${res.steps.find((s) => s.id === "cellcode")?.detail}`);
    expect(wrongBefore).toBeGreaterThanOrEqual(10);
    expect(res.cellCodesRead).toBe(true);
    expect(32 - wrongAfter.length).toBeGreaterThanOrEqual(30);
    expect(sum(res.counts)).toBe(11128);
  }, 180000);

  it("没有 ocrSource、只有 2400 小图时：证据不足则放弃，不出现误读覆盖", async () => {
    const small = downscaleArea(full!, 2400);
    const res = await analyzePattern(small, { legendOcr: false });
    // 无论是否读到，总数必须仍然正确；若读到则不能比纯颜色匹配更差
    expect(sum(res.counts)).toBe(11128);
    expect(wrongCodes(res.counts).length).toBeLessThanOrEqual(1);
  }, 180000);
});
