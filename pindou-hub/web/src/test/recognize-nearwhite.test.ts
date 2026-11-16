import { describe, expect, it } from "vitest";
import type { PixelSource } from "@engine/types";
import { outlierInkCells } from "../lib/recognize/glyph";
import { headerStripHeight } from "../lib/recognize/assistant";
import type { GridReading } from "../lib/recognize/types";
import { mulberry32 } from "./fixtures";

// 10x10 格、每格 20px 的近白图纸：每格中间印一个 5x7 点阵的色号字形（多数是 “T”）。
// 个别格子换成别的内容：真实的另一个色号（字形不同但同字号同位置）/ 贯穿格子的水印带 / 淡淡的小碎片。
const P = 20, C = 10, W = P * C;
const T = ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."];
const L = ["#....", "#....", "#....", "#....", "#....", "#....", "#####"];
type Kind = "T" | "L" | "band" | "faint";

function paint(kinds: Record<number, Kind>, seed = 1): PixelSource {
  const rnd = mulberry32(seed);
  const data = new Uint8ClampedArray(W * W * 4);
  for (let i = 0; i < W * W; i += 1) { data[i * 4] = 244; data[i * 4 + 1] = 244; data[i * 4 + 2] = 244; data[i * 4 + 3] = 255; }
  const put = (x: number, y: number, v: number) => { const o = (y * W + x) * 4; data[o] = v; data[o + 1] = v; data[o + 2] = v; };
  for (let cell = 0; cell < C * C; cell += 1) {
    const cx = cell % C, cy = Math.floor(cell / C);
    const k = kinds[cell] ?? "T";
    if (k === "band") {
      for (let x = cx * P; x < (cx + 1) * P; x += 1) for (let y = cy * P + 12; y < cy * P + 15; y += 1) put(x, y, 150);
      continue;
    }
    const glyph = k === "L" ? L : T;
    const v = k === "faint" ? 215 : 30;
    for (let r = 0; r < 7; r += 1) for (let c = 0; c < 5; c += 1) {
      if (glyph[r][c] !== "#") continue;
      if (k === "faint" && (r > 2 || c > 2)) continue; // 只有一小块碎片
      for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 2; dx += 1) put(cx * P + 5 + c * 2 + dx, cy * P + 3 + r * 2 + dy, v);
    }
  }
  for (let i = 0; i < data.length; i += 4) for (let k = 0; k < 3; k += 1) data[i + k] = Math.max(0, Math.min(255, data[i + k] + (rnd() - 0.5) * 6));
  return { width: W, height: W, data };
}

function readingOf(code = "H1"): GridReading {
  const cells = Array.from({ length: C * C }, (_, i) => i);
  return {
    clusters: [{ id: 0, count: cells.length, rgb: { r: 244, g: 244, b: 244 }, colorCode: code, code, empty: false, inkCells: cells.length, cells, members: [] }],
    cellInk: new Uint8Array(cells.length).fill(1),
    cellCluster: new Int32Array(cells.length).fill(0)
  } as unknown as GridReading;
}
const grid = { x0: 0, y0: 0, pitchX: P, pitchY: P, cols: C };
const run = (kinds: Record<number, Kind>, opts?: Parameters<typeof outlierInkCells>[4], code = "H1") =>
  outlierInkCells(paint(kinds), 1, grid, readingOf(code), opts).sort((a, b) => a - b);

describe("近白簇里的离群墨迹：真豆子不能被当杂物擦掉", () => {
  it("没有离群格：什么都不动", () => {
    expect(run({})).toEqual([]);
  });
  it("孤立的、字号字位正常的另一个色号（字形不同）保留", () => {
    expect(run({ 33: "L" })).toEqual([]);
  });
  it("一小簇字形不同的真豆子保留", () => {
    expect(run({ 33: "L", 34: "L", 43: "L" })).toEqual([]);
  });
  it("贯穿格子的水印带仍然擦掉", () => {
    expect(run({ 12: "band", 57: "band" })).toEqual([12, 57]);
  });
  it("淡淡的小碎片（JPEG 振铃 / 水印残片）仍然擦掉", () => {
    expect(run({ 21: "faint", 78: "faint" })).toEqual([21, 78]);
  });
  it("真豆子与水印同时在：只擦水印", () => {
    expect(run({ 33: "L", 12: "band", 78: "faint" })).toEqual([12, 78]);
  });
  it("图例写明该色有 100 颗、簇里正好 100 格：一格都不擦", () => {
    expect(run({ 12: "band", 78: "faint" }, { legendCounts: { H1: 100 } })).toEqual([]);
  });
  it("图例写 98 颗：最多擦 2 格，且挑最不像的", () => {
    expect(run({ 12: "band", 57: "band", 78: "faint" }, { legendCounts: { H1: 98 } })).toHaveLength(2);
  });
  it("图例没列这个色号：不受图例限制", () => {
    expect(run({ 12: "band" }, { legendCounts: { A1: 100 } })).toEqual([12]);
  });
});

describe("抬头条带高度", () => {
  it("小图维持原来的 320px 上限", () => {
    expect(headerStripHeight(900, 800)).toBe(320);
    expect(headerStripHeight(100, 800)).toBe(100);
    expect(headerStripHeight(10, 800)).toBe(24);
  });
  it("高分辨率 / 竖长图按图高比例放宽，但不超过网格上沿", () => {
    expect(headerStripHeight(1500, 6000)).toBe(1500);
    expect(headerStripHeight(3000, 6000)).toBe(1800);
    expect(headerStripHeight(700, 2400)).toBe(700);
  });
});
