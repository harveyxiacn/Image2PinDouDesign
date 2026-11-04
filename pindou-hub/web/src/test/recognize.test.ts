import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MARD_PALETTE } from "@engine/palette";
import { analyzePattern, buildChipPalette } from "../lib/recognize/assistant";
import { detectGrid, readGrid } from "../lib/recognize/grid";
import type { Chip } from "../lib/recognize/legend";
import { assignBelowBands, chipStack, findChips, normalizeCode, parseChipTexts, parseHeaderText, parseLegendText, parseLegendWords } from "../lib/recognize/legend";
import { setOcrBackend, terminateOcr } from "../lib/recognize/ocr";
import { buildChart, buildRulerChart, createNodeOcrBackend, decodePng, downscaleArea, driftColors, gradientImage, illustrationImage, TEST_CODES } from "./fixtures";

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

describe("标尺剥离 / 抬头尺寸强制", () => {
  it.each([
    ["blue", false, 18],
    ["white", true, 20],
    ["blue", true, 26.5]
  ] as const)("四周带数字标尺（%s 底，下/右标尺倒数=%s，格距 %s）：标尺不算格子", async (ruler, reversed, pitch) => {
    const chart = buildRulerChart({ cols: 40, rows: 30, pitch, ruler, reversed, boldEvery: 10, emptyFrac: 0.15, seed: 4 });
    const res = await analyzePattern(chart.src, { ocr: false, allowedCodes: TEST_CODES });
    expect(res.grid?.grid.cols).toBe(40);
    expect(res.grid?.grid.rows).toBe(30);
    expect(res.counts).toEqual(chart.counts);
    expect(res.steps.find((s) => s.id === "grid")?.detail).toContain("标尺");
  });

  it("没有标尺的图不会被误剥（边缘一整行同色 + 有字的豆子）", async () => {
    const chart = buildChart({ cols: 36, rows: 24, pitch: 16, boldEvery: 6, textBlobs: true, solidBorder: true, emptyFrac: 0.1, seed: 8, titleBand: false, legendBand: false });
    const res = await analyzePattern(chart.src, { ocr: false, allowedCodes: TEST_CODES });
    expect(res.grid?.grid.cols).toBe(36);
    expect(res.grid?.grid.rows).toBe(24);
  });

  it("抬头给出尺寸：线条很浅、图形只占一角时，把检测到的小块网格延伸到抬头尺寸", () => {
    const chart = buildChart({ cols: 40, rows: 30, pitch: 16, lineColor: 248, beadRect: { c0: 12, r0: 8, c1: 27, r1: 21 }, emptyFrac: 0.1, seed: 5, titleBand: false, legendBand: false });
    const auto = detectGrid(chart.src);
    expect(auto && auto.cols * auto.rows).toBeLessThan(40 * 30 * 0.5); // 自动检测只找到有豆子的一块
    const g = detectGrid(chart.src, null, { cols: 40, rows: 30 });
    expect(g?.cols).toBe(40);
    expect(g?.rows).toBe(30);
    expect(Math.abs(g!.x0 - chart.x0)).toBeLessThan(2);
    expect(Math.abs(g!.y0 - chart.y0)).toBeLessThan(2);
  });
});

describe("闭集色板 / 图例色块几何", () => {
  it("闭集：图例色板外的浅色幻影色号不会冒出来；白格没有字仍是空格", () => {
    // 3 种豆子 + 一小撮浅粉色（3 格）：开放匹配会给它一个色卡里的浅粉色号，闭集只能落在色板里
    const chart = buildChart({ cols: 30, rows: 20, pitch: 14, boldEvery: 5, codes: ["A4", "B5", "H7"], emptyFrac: 0.1, seed: 41, titleBand: false, legendBand: false });
    const { data, width } = chart.src;
    for (let cell = 3; cell <= 5; cell += 1) {
      for (let y = chart.y0 + 3 * 14 + 1; y < chart.y0 + 4 * 14 - 1; y += 1) for (let x = chart.x0 + cell * 14 + 1; x < chart.x0 + (cell + 1) * 14 - 1; x += 1) { const i = (y * width + x) * 4; data[i] = 248; data[i + 1] = 214; data[i + 2] = 226; }
    }
    const g = detectGrid(chart.src)!;
    const colors: Record<string, { r: number; g: number; b: number }> = {};
    for (const c of ["A4", "B5", "H7"]) { const p = MARD_PALETTE.find((x) => x.code === c)!; colors[c] = p.rgb; }
    const closed = readGrid(chart.src, g, { legendCodes: ["A4", "B5", "H7"], legendColors: colors, closedPalette: true });
    const open = readGrid(chart.src, g, { legendCodes: ["A4", "B5", "H7"], legendColors: colors });
    expect(Object.keys(open.counts).length).toBeGreaterThan(3); // 开放匹配：给浅粉色的 3 格另起一个色号
    expect(Object.keys(closed.counts).sort()).toEqual(["A4", "B5", "H7"]);
  });

  it("buildChipPalette：文字色号与色块颜色吻合则采用，对不上按颜色找最近、且不重复占用色号", () => {
    const rgbOf = (code: string) => MARD_PALETTE.find((c) => c.code === code)!.rgb;
    const mk = (code: string) => ({ ...rgbOf(code) });
    const chips = [mk("A4"), mk("B5"), mk("H7"), mk("D20")];
    const perChip = new Map<unknown, { code: string | null; count: number | null }>([
      [chips[0], { code: "A4", count: 12 }], // 吻合
      [chips[1], { code: "C7", count: 30 }], // 文字读错（C7 与蓝绿色块差很远）→ 按颜色改回 B5，保留数量
      [chips[2], { code: null, count: null }] // 没读出文字 → 按颜色 H7
    ]);
    const pal = buildChipPalette(chips, perChip);
    expect(pal.map((p) => p.code)).toEqual(["A4", "B5", "H7", "D20"]);
    expect(pal[1].count).toBe(30);
    expect(pal[2].guessed).toBe(true);
    expect(new Set(pal.map((p) => p.code)).size).toBe(pal.length);
  });

  it("数量印在色块下方：assignBelowBands 给每块算出下方条带，最后一排用图底，同排下面还有色块则用到下一排之前", () => {
    const chip = (x: number, y: number): Chip => ({ x, y, width: 40, height: 30, r: 200, g: 100, b: 50 });
    const chips = [chip(10, 10), chip(70, 10), chip(130, 10), chip(10, 100), chip(70, 100)];
    assignBelowBands(chips, 160);
    // 第一排下方到第二排之前 60px 空隙 → 封顶 0.85×30 ≈ 26
    expect(chips[0].below).toBe(26);
    expect(chips[2].below).toBe(26); // 第二排没有色块在它正下方，但仍有 130+ 的空隙（图底）
    // 最后一排：图底 160 - 130 = 30 的空隙 ≥ 15 → min(28, 26)
    expect(chips[3].below).toBe(26);
    // 色块紧挨着下一排（数量印在色块里）时没有下方条带
    const tight = [chip(10, 10), chip(10, 44)];
    assignBelowBands(tight, 80);
    expect(tight[0].below).toBeUndefined();
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

describe("色号归一化 / 抬头 / 表格图例 / 棋盘格 / 非图纸", () => {
  it("normalizeCode：零填充色号归一化", () => {
    expect(normalizeCode("H07")).toBe("H7");
    expect(normalizeCode("b08")).toBe("B8");
    expect(normalizeCode("A26")).toBe("A26");
    expect(normalizeCode("ZG01")).toBe("ZG1");
    expect(normalizeCode("H10")).toBe("H10");
  });

  it("图例里的零填充色号：H07 (502) → H7", () => {
    const r = parseLegendText("A26 (871) B08 (6) H07 (502) H02 (18)", VALID);
    expect(r.counts).toEqual({ A26: 871, B8: 6, H7: 502, H2: 18 });
    const w = (text: string, x0: number, y0: number) => ({ text, bbox: { x0, y0, x1: x0 + 30, y1: y0 + 14 } });
    const rw = parseLegendWords([w("H07", 10, 10), w("(502)", 50, 10), w("B08", 10, 40), w("(6)", 50, 40)], VALID);
    expect(rw.counts).toEqual({ H7: 502, B8: 6 });
  });

  it("parseHeaderText：各种抬头写法", () => {
    expect(parseHeaderText("尺寸:55x61 · mard · 9 色 · 1806 颗")).toEqual({ cols: 55, rows: 61, colors: 9, total: 1806 });
    // 英文识别模型读不出汉字：只剩数字顺序
    expect(parseHeaderText("RT:55x61 Amard «9M o 1806 W")).toEqual({ cols: 55, rows: 61, colors: 9, total: 1806 });
    expect(parseHeaderText("156 × 138 格  ·  MARD 32 色  ·  11128 颗豆  ·  每板 52 针")).toEqual({ cols: 156, rows: 138, colors: 32, total: 11128 });
    expect(parseHeaderText("总计 7024 颗 | 规格 116×88")).toMatchObject({ cols: 116, rows: 88, total: 7024 });
    expect(parseHeaderText("规格: 54x76 · 总用豆数: 2285 · 总色卡数: 10")).toEqual({ cols: 54, rows: 76, colors: 10, total: 2285 });
    expect(parseHeaderText("总豆数 2,904颗").total).toBe(2904);
    expect(parseHeaderText("今天天气不错").cols).toBeNull();
  });

  it("表格图例（数量在色号左边）：颜色 | 数量 | 色号", () => {
    const w = (text: string, x0: number, y0: number) => ({ text, bbox: { x0, y0, x1: x0 + 40, y1: y0 + 16 } });
    const words = [
      w("704", 240, 100), w("H01", 380, 100),
      w("282", 240, 130), w("H02", 380, 130),
      w("496", 240, 160), w("H13", 380, 160),
      w("574", 240, 190), w("H15", 380, 190)
    ];
    const r = parseLegendWords(words, VALID);
    expect(r.counts).toEqual({ H1: 704, H2: 282, H13: 496, H15: 574 });
  });

  it("棋盘格空格：不影响格距检测，且按空格计数", () => {
    const chart = buildChart({ cols: 30, rows: 24, pitch: 18, lineWidth: 1, boldEvery: 10, checker: true, emptyFrac: 0.35, textBlobs: true, solidBorder: true, seed: 51 });
    const g = detectGrid(chart.src);
    expect(g).not.toBeNull();
    expect(g!.cols).toBe(30);
    expect(g!.rows).toBe(24);
    const r = readGrid(chart.src, g!, { allowedCodes: TEST_CODES });
    expect(r.counts).toEqual(chart.counts);
  });

  it("平滑插画：isChart=false、method none，不抛错", async () => {
    const res = await analyzePattern(illustrationImage(600, 340), {});
    expect(res.isChart).toBe(false);
    expect(res.method).toBe("none");
    expect(res.notChartReason).toBeTruthy();
    const chart = buildChart({ cols: 30, rows: 20, pitch: 12.5, boldEvery: 5, seed: 61 });
    const ok = await analyzePattern(chart.src, { allowedCodes: TEST_CODES });
    expect(ok.isChart).toBe(true);
  }, 30000);
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
    const res = await analyzePattern(small, { legendOcr: false, headerOcr: false, ocrSource: full! });
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
