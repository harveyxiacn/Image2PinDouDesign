import { describe, expect, it, vi } from "vitest";
import { dropBorderWhite } from "../domain/background";
import { removeBackgroundSmart } from "../domain/backgroundRemoval";
import {
  analyzeBackground,
  buildMattingPreview,
  matteBackground,
  translateEdits
} from "../domain/matting";
import type { PixelSource, SampledGrid } from "../domain/types";

vi.mock("@imgly/background-removal", () => ({
  removeBackground: async () => {
    throw new Error("network blocked");
  }
}));

type Pixel = [number, number, number, number?];
const W = 60;
const H = 60;

function make(width: number, height: number, paint: (x: number, y: number) => Pixel): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = paint(x, y);
      data.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const alphaAt = (s: PixelSource, x: number, y: number) => s.data[(y * s.width + x) * 4 + 3];
const ORANGE: Pixel = [240, 130, 20];
const inBox = (x: number, y: number, x0 = 15, y0 = 10, x1 = 44, y1 = 49) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

// 确定性伪随机，模拟 JPEG 噪声。
function lcg(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe("matteBackground: plain backgrounds", () => {
  it("removes a plain white background and keeps the subject", () => {
    const src = make(W, H, (x, y) => (inBox(x, y) ? ORANGE : [255, 255, 255]));
    const analysis = analyzeBackground(src);
    expect(analysis.kind).toBe("plain");
    expect(analysis.usable).toBe(true);
    const out = matteBackground(src);
    expect(out.reliable).toBe(true);
    expect(alphaAt(out.source, 2, 2)).toBe(0);
    expect(alphaAt(out.source, 30, 30)).toBe(255);
    expect(alphaAt(out.source, 15, 10)).toBe(255);
  });

  it("removes a saturated solid colour background", () => {
    const src = make(W, H, (x, y) => (inBox(x, y) ? ORANGE : [20, 120, 220]));
    const analysis = analyzeBackground(src);
    expect(analysis.chromatic).toBe(true);
    const out = matteBackground(src);
    expect(alphaAt(out.source, 0, 0)).toBe(0);
    expect(alphaAt(out.source, 30, 30)).toBe(255);
  });

  it("handles a two-tone background (left/right halves)", () => {
    const src = make(W, H, (x, y) => (inBox(x, y) ? ORANGE : x < 30 ? [255, 255, 255] : [60, 140, 90]));
    const analysis = analyzeBackground(src);
    expect(analysis.kind).toBe("two-tone");
    const out = matteBackground(src);
    expect(alphaAt(out.source, 3, 30)).toBe(0);
    expect(alphaAt(out.source, 57, 30)).toBe(0);
    expect(alphaAt(out.source, 30, 30)).toBe(255);
  });

  it("handles a soft vertical gradient background", () => {
    const src = make(W, H, (x, y) => {
      if (inBox(x, y)) return ORANGE;
      const v = Math.round(250 - (y / H) * 60); // 250 -> 190
      return [v, v, v + 4];
    });
    const analysis = analyzeBackground(src);
    expect(["gradient", "plain"]).toContain(analysis.kind);
    expect(analysis.usable).toBe(true);
    const out = matteBackground(src);
    expect(alphaAt(out.source, 3, 3)).toBe(0);
    expect(alphaAt(out.source, 3, 56)).toBe(0);
    expect(alphaAt(out.source, 30, 30)).toBe(255);
  });

  it("tolerates JPEG-like noise on the background without leaving specks", () => {
    const rnd = lcg(7);
    const src = make(W, H, (x, y) => {
      if (inBox(x, y)) return ORANGE;
      const n = () => Math.round((rnd() - 0.5) * 10);
      return [248 + n(), 248 + n(), 248 + n()];
    });
    const out = matteBackground(src);
    let leftover = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (!inBox(x, y) && alphaAt(out.source, x, y) !== 0) leftover += 1;
      }
    }
    expect(leftover).toBe(0);
    expect(alphaAt(out.source, 30, 30)).toBe(255);
  });

  it("works when the subject touches the image border", () => {
    const src = make(W, H, (x, y) => (inBox(x, y, 15, 0, 44, 49) ? ORANGE : [255, 255, 255]));
    const out = matteBackground(src);
    expect(alphaAt(out.source, 30, 0)).toBe(255);
    expect(alphaAt(out.source, 2, 0)).toBe(0);
    expect(alphaAt(out.source, 30, 55)).toBe(0);
  });
});

describe("matteBackground: subject interior", () => {
  it("removes a thin enclosed gap but keeps thick white areas and eyes", () => {
    const src = make(W, H, (x, y) => {
      if (!inBox(x, y)) return [255, 255, 255];
      if (x >= 28 && x <= 29 && y >= 15 && y <= 30) return [255, 255, 255]; // 手臂与身体之间的缝
      if (x >= 18 && x <= 27 && y >= 34 && y <= 44) return [255, 255, 255]; // 白衣服（厚实）
      if (x >= 36 && x <= 38 && y >= 14 && y <= 16) return [255, 255, 255]; // 眼睛
      return ORANGE;
    });
    const out = matteBackground(src);
    expect(alphaAt(out.source, 28, 22)).toBe(0);
    expect(alphaAt(out.source, 22, 39)).toBe(255);
    expect(alphaAt(out.source, 37, 15)).toBe(255);
  });

  it("strong strength also removes thick enclosed background-coloured blocks", () => {
    const src = make(W, H, (x, y) => {
      if (!inBox(x, y)) return [255, 255, 255];
      if (x >= 22 && x <= 31 && y >= 24 && y <= 33) return [255, 255, 255];
      return ORANGE;
    });
    expect(alphaAt(matteBackground(src, { strength: "standard" }).source, 26, 28)).toBe(255);
    expect(alphaAt(matteBackground(src, { strength: "strong" }).source, 26, 28)).toBe(0);
  });

  it("drops a speck island far from the subject", () => {
    // 背景里有一个小色点，不与边缘背景连通性无关：它是孤立前景小岛，应被清掉。
    const src = make(W, H, (x, y) => {
      if (inBox(x, y)) return ORANGE;
      if (x >= 3 && x <= 4 && y >= 3 && y <= 4) return [30, 30, 30];
      return [255, 255, 255];
    });
    const out = matteBackground(src);
    expect(alphaAt(out.source, 3, 3)).toBe(0);
    expect(alphaAt(out.source, 30, 30)).toBe(255);
  });

  it("cleans anti-aliased fringe pixels around the subject", () => {
    const src = make(W, H, (x, y) => {
      if (inBox(x, y)) return ORANGE;
      if (inBox(x, y, 14, 9, 45, 50)) return [252, 235, 215]; // 1px 混色边
      return [255, 255, 255];
    });
    const out = matteBackground(src);
    expect(alphaAt(out.source, 14, 30)).toBe(0);
    expect(alphaAt(out.source, 15, 30)).toBe(255);
  });
});

describe("matteBackground: shadows and strength", () => {
  const shadowed = make(W, H, (x, y) => {
    if (inBox(x, y, 15, 8, 44, 39)) return ORANGE;
    if (y >= 40 && y <= 47 && x >= 12 && x <= 47) {
      const v = 200 + (y - 40) * 3; // 靠近主体最深，向下渐浅
      return [v, v, v];
    }
    return [255, 255, 255];
  });

  it("treats a soft drop shadow as background at standard strength", () => {
    const out = matteBackground(shadowed, { strength: "standard" });
    expect(alphaAt(out.source, 30, 44)).toBe(0);
    expect(alphaAt(out.source, 30, 20)).toBe(255);
  });

  it("conservative strength leaves the shadow alone", () => {
    const out = matteBackground(shadowed, { strength: "conservative" });
    expect(alphaAt(out.source, 30, 44)).toBe(255);
  });
});

describe("matteBackground: user corrections", () => {
  it("tap-to-remove clears an extra connected region", () => {
    const src = make(W, H, (x, y) => {
      if (inBox(x, y)) return ORANGE;
      if (x >= 46 && x <= 56 && y >= 20 && y <= 30) return [150, 160, 170]; // 背景里的杂物
      return [255, 255, 255];
    });
    const before = matteBackground(src);
    expect(alphaAt(before.source, 50, 25)).toBe(255);
    const after = matteBackground(src, { edits: { keep: [], remove: [{ x: 50, y: 25 }] } });
    expect(alphaAt(after.source, 50, 25)).toBe(0);
    expect(alphaAt(after.source, 30, 30)).toBe(255);
  });

  it("tap-to-keep protects a region the automatic pass would remove", () => {
    const src = make(W, H, (x, y) => {
      if (inBox(x, y)) return ORANGE;
      if (x >= 46 && x <= 52 && y >= 20 && y <= 26) return [250, 250, 250]; // 与背景几乎同色的主体细节
      return [255, 255, 255];
    });
    expect(alphaAt(matteBackground(src).source, 49, 23)).toBe(0);
    const kept = matteBackground(src, { edits: { keep: [{ x: 49, y: 23 }], remove: [] } });
    expect(alphaAt(kept.source, 49, 23)).toBe(255);
  });

  it("maps edit points into a cropped image and drops outside points", () => {
    const mapped = translateEdits(
      { keep: [{ x: 110, y: 60 }, { x: 5, y: 5 }], remove: [] },
      { x: 100, y: 50 },
      { width: 50, height: 50 }
    );
    expect(mapped.keep).toEqual([{ x: 10, y: 10 }]);
  });
});

describe("method choice", () => {
  it("flags a busy background so it goes to the AI model", () => {
    const rnd = lcg(3);
    const busy = make(64, 64, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)]);
    expect(analyzeBackground(busy).usable).toBe(false);
    const checker = make(64, 64, (x, y) => ((x + y) % 2 === 0 ? [0, 255, 0] : [255, 0, 255]));
    expect(analyzeBackground(checker).usable).toBe(false);
  });

  it("uses the local method for a plain background and explains why", async () => {
    const src = make(W, H, (x, y) => (inBox(x, y) ? ORANGE : [255, 255, 255]));
    const result = await removeBackgroundSmart(src);
    expect(result.used).toBe("local");
    expect(result.message).toContain("无需下载模型");
    expect(alphaAt(result.source, 0, 0)).toBe(0);
  });

  it("falls back to the local method with a clear message when the model fails", async () => {
    const rnd = lcg(11);
    // 左半边杂乱彩色，右半边单色：边缘不够干净 → 走模型 → 模型失败 → 兜底
    const src = make(64, 64, (x, y) => {
      if (x >= 24 && x <= 40 && y >= 24 && y <= 40) return [10, 10, 10];
      return x < 40 ? [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)] : [255, 255, 255];
    });
    const result = await removeBackgroundSmart(src, { method: "model" });
    expect(["local-fallback", "none"]).toContain(result.used);
    expect(result.message).toContain("没能加载");
  });

  it("keeps already-transparent images untouched", async () => {
    const src = make(8, 8, (x, y) => (x > 2 && x < 6 && y > 2 && y < 6 ? [200, 20, 20] : [0, 0, 0, 0]));
    const result = await removeBackgroundSmart(src);
    expect(result.source).toBe(src);
    expect(result.used).toBe("none");
  });

  it("builds a downscaled live preview that matches the full-size decision", () => {
    const src = make(600, 600, (x, y) => (x > 150 && x < 450 && y > 100 && y < 500 ? ORANGE : [255, 255, 255]));
    const preview = buildMattingPreview(src, "standard", { keep: [], remove: [] }, 120);
    expect(Math.max(preview.source.width, preview.source.height)).toBeLessThanOrEqual(120);
    expect(preview.output).not.toBeNull();
  });

  it("processes a mid-size image without per-pixel objects (sanity, no timing)", () => {
    const size = 500;
    const src = make(size, size, (x, y) => ((x - 250) ** 2 + (y - 250) ** 2 < 150 ** 2 ? ORANGE : [250, 250, 250]));
    const out = matteBackground(src);
    expect(out.reliable).toBe(true);
    expect(alphaAt(out.source, 250, 250)).toBe(255);
    expect(alphaAt(out.source, 5, 5)).toBe(0);
  });
});

describe("dropBorderWhite rim cleanup", () => {
  const cell = (r: number, g: number, b: number) => ({ r, g, b, a: 255 });
  it("removes the light anti-aliased rim bead but keeps a near-white bead inside the subject", () => {
    const white = cell(255, 255, 255);
    const rim = cell(240, 238, 236); // 与白相近的混色
    const red = cell(220, 20, 20);
    const inner = cell(250, 250, 250);
    const cells = [
      white, white, white, white, white, white, white,
      white, rim, rim, rim, rim, rim, white,
      white, rim, red, red, red, rim, white,
      white, rim, red, inner, red, rim, white,
      white, rim, red, red, red, rim, white,
      white, rim, rim, rim, rim, rim, white,
      white, white, white, white, white, white, white
    ];
    const grid: SampledGrid = { width: 7, height: 7, cells };
    const out = dropBorderWhite(grid);
    expect(out.cells[0]).toBeNull();
    expect(out.cells[7 + 1]).toBeNull();
    expect(out.cells[3 * 7 + 3]).not.toBeNull();
    expect(out.cells[2 * 7 + 2]).not.toBeNull();
  });
});
