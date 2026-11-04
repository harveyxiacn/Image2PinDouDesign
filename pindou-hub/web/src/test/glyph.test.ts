import { describe, expect, it } from "vitest";
import type { PixelSource } from "@engine/types";
import { averageGlyph, lumOf, rankCodes, stackGlyphs, textCost } from "../lib/recognize/glyph";
import { mulberry32 } from "./fixtures";

// 合成图：10x10 格，每格 20px，底色 bg，中间画一个 “T” 形字（5x7 点阵，每点 2px），叠加噪声与随机位置的浅色“水印”块
function synth(bg: [number, number, number], ink: [number, number, number], seed: number): PixelSource {
  const P = 20, C = 10, W = P * C;
  const rnd = mulberry32(seed);
  const data = new Uint8ClampedArray(W * W * 4);
  for (let i = 0; i < W * W; i += 1) { data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255; }
  const T = ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."];
  for (let cy = 0; cy < C; cy += 1) for (let cx = 0; cx < C; cx += 1) {
    const jx = Math.round((rnd() - 0.5) * 2) ; // 随机 ±1px 抖动
    for (let r = 0; r < 7; r += 1) for (let c = 0; c < 5; c += 1) {
      if (T[r][c] !== "#") continue;
      for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 2; dx += 1) {
        const x = cx * P + 5 + c * 2 + dx + jx, y = cy * P + 3 + r * 2 + dy;
        const o = (y * W + x) * 4;
        data[o] = ink[0]; data[o + 1] = ink[1]; data[o + 2] = ink[2];
      }
    }
    // 水印：一条 3px 高的浅灰带，位置随机
    const wy = cy * P + 2 + Math.floor(rnd() * 15);
    for (let x = cx * P; x < (cx + 1) * P; x += 1) for (let y = wy; y < wy + 2; y += 1) {
      const o = (y * W + x) * 4;
      data[o] = Math.min(255, data[o] + 40); data[o + 1] = Math.min(255, data[o + 1] + 40); data[o + 2] = Math.min(255, data[o + 2] + 40);
    }
  }
  for (let i = 0; i < data.length; i += 4) for (let k = 0; k < 3; k += 1) data[i + k] = Math.max(0, Math.min(255, data[i + k] + (rnd() - 0.5) * 20));
  return { width: W, height: W, data };
}
const grid = { x0: 0, y0: 0, pitchX: 20, pitchY: 20, cols: 10 };
const cells = Array.from({ length: 100 }, (_, i) => i);

describe("簇平均字形", () => {
  it("深字浅底：极性 = 深字，字形包围盒居中、清晰", () => {
    const g = averageGlyph(lumOf(synth([240, 240, 240], [20, 20, 20], 1)), grid, 1, cells)!;
    expect(g.polarity).toBe(1);
    expect(g.bbox).not.toBeNull();
    expect(g.n).toBeGreaterThan(40);
    expect(g.bbox!.x1 - g.bbox!.x0).toBeGreaterThanOrEqual(7);
    expect(g.snr).toBeGreaterThan(5);
  });
  it("浅字深底：极性 = 浅字", () => {
    const g = averageGlyph(lumOf(synth([30, 30, 30], [250, 250, 250], 2)), grid, 1, cells)!;
    expect(g.polarity).toBe(-1);
    expect(g.bbox).not.toBeNull();
    const s = stackGlyphs([{ id: 0, glyph: g }]);
    expect(s.rows.length).toBe(1);
    // 叠图是黑字白底：存在深像素
    let dark = 0;
    for (let i = 0; i < s.image.data.length; i += 4) if (s.image.data[i] < 80) dark += 1;
    expect(dark).toBeGreaterThan(50);
  });
  it("文字代价：形近字便宜，其他贵；排序结合颜色", () => {
    expect(textCost("813", "B13")).toBeLessThan(0.5);
    expect(textCost("H6", "B13")).toBeGreaterThan(1.5);
    const r = rankCodes(["8"], (c) => (c === "B16" ? 2 : 20), ["B13", "B16", "H8"]);
    expect(r[0].code).toBe("B16");
  });
});
