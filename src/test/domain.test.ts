import { describe, expect, it } from "vitest";
import { applyAdjustmentsToGrid, hasAdjustments } from "../domain/adjustments";
import { dropBorderWhite } from "../domain/background";
import { isDynamicImportFailure, removeBackgroundFromSource, removeUniformBorderBackground } from "../domain/backgroundRemoval";
import { BOARD_PRESETS, getBoardSize } from "../domain/boards";
import { autoCropToContent, autoFramePixelSource, cropPixelSource, findOpaqueBounds, rectFromFractions } from "../domain/crop";
import { ciede2000, hexToRgb } from "../domain/color";
import type { Lab, SampledGrid } from "../domain/types";
import {
  convertPixelSourceToDesign,
  countMatrixColors,
  estimatePixelArtScale,
  findNearestPaletteColor,
  isLikelyPixelArt,
  outlineMatrix,
  preparePalette,
  resampleToGrid,
  resolveSmartGridSize,
  summarizeProject
} from "../domain/conversion";
import { countsToCsv } from "../domain/exporters";
import { getHighResolutionCellSize } from "../domain/rendering";
import { medianSmoothGrid } from "../domain/simplify";
import type { PixelSource } from "../domain/types";
import {
  designFingerprint,
  getColorBuildProgress,
  mirrorDesignHorizontally,
  replaceDesignCell
} from "../domain/workbench";

const palette = preparePalette([
  { code: "K1", nameZh: "黑色", hex: "#000000" },
  { code: "W1", nameZh: "白色", hex: "#ffffff" },
  { code: "R1", nameZh: "红色", hex: "#ff0000" },
  { code: "B1", nameZh: "蓝色", hex: "#0000ff" }
]);

describe("board presets", () => {
  it("resolves stock and custom board sizes", () => {
    expect(BOARD_PRESETS.map((preset) => preset.id)).toContain("52");
    expect(getBoardSize("104", 1, 1)).toEqual({ width: 104, height: 104 });
    expect(getBoardSize("custom", 34, 55)).toEqual({ width: 34, height: 55 });
  });
});

describe("CIEDE2000", () => {
  // 来自 Sharma, Wu & Dalal (2005) 的标准验证向量，用于证明实现与权威参考一致。
  const cases: Array<[Lab, Lab, number]> = [
    [{ l: 50, a: 2.6772, b: -79.7751 }, { l: 50, a: 0, b: -82.7485 }, 2.0425],
    [{ l: 50, a: 3.1571, b: -77.2803 }, { l: 50, a: 0, b: -82.7485 }, 2.8615],
    [{ l: 50, a: 2.8361, b: -74.02 }, { l: 50, a: 0, b: -82.7485 }, 3.4412],
    [{ l: 50, a: -1.3802, b: -84.2814 }, { l: 50, a: 0, b: -82.7485 }, 1.0],
    [{ l: 50, a: 0, b: 0 }, { l: 50, a: -1, b: 2 }, 2.3669],
    [{ l: 50, a: 2.49, b: -0.001 }, { l: 50, a: -2.49, b: 0.0009 }, 7.1792],
    [{ l: 60.2574, a: -34.0099, b: 36.2677 }, { l: 60.4626, a: -34.1751, b: 39.4387 }, 1.2644],
    [{ l: 22.7233, a: 20.0904, b: -46.694 }, { l: 23.0331, a: 14.973, b: -42.5619 }, 2.0373],
    [{ l: 2.0776, a: 0.0795, b: -1.135 }, { l: 0.9033, a: -0.0636, b: -0.5514 }, 0.9082]
  ];

  it("matches the Sharma reference deltaE values", () => {
    for (const [reference, sample, expected] of cases) {
      expect(ciede2000(reference, sample)).toBeCloseTo(expected, 3);
    }
  });

  it("is zero for identical colors and symmetric", () => {
    const a: Lab = { l: 40, a: 12, b: -8 };
    const b: Lab = { l: 70, a: -5, b: 30 };
    expect(ciede2000(a, a)).toBeCloseTo(0, 6);
    expect(ciede2000(a, b)).toBeCloseTo(ciede2000(b, a), 6);
  });
});

describe("image adjustments", () => {
  const makeGrid = (r: number, g: number, b: number): SampledGrid => ({
    width: 1,
    height: 1,
    cells: [{ r, g, b, a: 255 }]
  });

  it("treats neutral adjustments as a no-op (returns same grid)", () => {
    const grid = makeGrid(100, 120, 140);
    expect(hasAdjustments({ brightness: 0, contrast: 0, saturation: 0 })).toBe(false);
    expect(applyAdjustmentsToGrid(grid, { brightness: 0, contrast: 0, saturation: 0 })).toBe(grid);
  });

  it("brightens by offsetting channels and clamps to 255", () => {
    const out = applyAdjustmentsToGrid(makeGrid(100, 200, 250), { brightness: 50, contrast: 0, saturation: 0 });
    const cell = out.cells[0]!;
    expect(cell.r).toBeCloseTo(100 + 127.5, 5);
    expect(cell.g).toBe(255);
    expect(cell.b).toBe(255);
  });

  it("desaturates toward luma when saturation is -100", () => {
    const out = applyAdjustmentsToGrid(makeGrid(200, 100, 50), { brightness: 0, contrast: 0, saturation: -100 });
    const cell = out.cells[0]!;
    const luma = 0.299 * 200 + 0.587 * 100 + 0.114 * 50;
    expect(cell.r).toBeCloseTo(luma, 5);
    expect(cell.g).toBeCloseTo(luma, 5);
    expect(cell.b).toBeCloseTo(luma, 5);
  });

  it("leaves transparent/null cells untouched", () => {
    const grid: SampledGrid = { width: 2, height: 1, cells: [null, { r: 10, g: 10, b: 10, a: 255 }] };
    const out = applyAdjustmentsToGrid(grid, { brightness: 20, contrast: 0, saturation: 0 });
    expect(out.cells[0]).toBeNull();
    expect(out.cells[1]!.r).toBeGreaterThan(10);
  });
});

describe("ignore white background (border flood-fill)", () => {
  const W = { r: 255, g: 255, b: 255, a: 255 };
  const C = { r: 20, g: 120, b: 240, a: 255 };

  it("clears border-connected white but keeps interior white (eyes/highlights)", () => {
    // 5x5：外圈白底，中间一圈有色主体，正中心一个白点（被主体包住，不与边缘相连）
    const cells: Array<typeof W | null> = [
      W, W, W, W, W,
      W, C, C, C, W,
      W, C, W, C, W,
      W, C, C, C, W,
      W, W, W, W, W
    ].map((c) => ({ ...c }));
    const out = dropBorderWhite({ width: 5, height: 5, cells }, 240);
    // 四角/边缘白 → null
    expect(out.cells[0]).toBeNull();
    expect(out.cells[4]).toBeNull();
    expect(out.cells[24]).toBeNull();
    // 主体仍在
    expect(out.cells[6]).not.toBeNull();
    // 正中心被主体包住的白 → 保留
    expect(out.cells[12]).not.toBeNull();
    expect(out.cells[12]!.r).toBe(255);
  });

  it("returns the same grid when no border white exists", () => {
    const cells = [C, C, C, C].map((c) => ({ ...c }));
    const grid = { width: 2, height: 2, cells };
    expect(dropBorderWhite(grid, 240)).toBe(grid);
  });
});

describe("H7 outline", () => {
  it("adds black outside a subject while preserving its original colored cell", () => {
    const m = [
      [null, null, null],
      [null, "A1", null],
      [null, null, null]
    ];
    expect(outlineMatrix(m, "H7")).toEqual([
      [null, "H7", null],
      ["H7", "A1", "H7"],
      [null, "H7", null]
    ]);
  });

  it("turns the outermost cells black when the subject touches the canvas edge", () => {
    const m = [
      ["A1", "A1", "A1"],
      ["A1", "A1", "A1"],
      ["A1", "A1", "A1"]
    ];
    expect(outlineMatrix(m, "H7")).toEqual([
      ["H7", "H7", "H7"],
      ["H7", "A1", "H7"],
      ["H7", "H7", "H7"]
    ]);
  });
});

describe("uniform border background removal", () => {
  it("recognizes stale dynamic-module errors used by the one-time reload recovery", () => {
    expect(isDynamicImportFailure(new TypeError("Failed to fetch dynamically imported module: /assets/old.js"))).toBe(true);
    expect(isDynamicImportFailure(new Error("network timeout"))).toBe(false);
  });

  it("keeps an already-transparent cutout unchanged without loading AI", async () => {
    const data = new Uint8ClampedArray(3 * 3 * 4);
    data.set([240, 120, 20, 255], (1 * 3 + 1) * 4);
    const source = { width: 3, height: 3, data };
    await expect(removeBackgroundFromSource(source)).resolves.toBe(source);
  });

  it("removes border-connected solid color while preserving an enclosed matching detail", () => {
    const width = 7;
    const height = 7;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      data.set([10, 190, 225, 255], index * 4);
    }
    for (let y = 1; y <= 5; y += 1) {
      for (let x = 1; x <= 5; x += 1) {
        data.set([250, 180, 20, 255], (y * width + x) * 4);
      }
    }
    data.set([10, 190, 225, 255], (3 * width + 3) * 4);

    const output = removeUniformBorderBackground({ width, height, data });
    expect(output).not.toBeNull();
    expect(output!.data[3]).toBe(0);
    expect(output!.data[(3 * width + 3) * 4 + 3]).toBe(255);
    expect(output!.data[(2 * width + 2) * 4 + 3]).toBe(255);
  });

  it("defers to AI when border colors are not uniform", () => {
    const width = 8;
    const height = 8;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = (x + y) % 2 === 0 ? 0 : 255;
        data.set([value, 255 - value, value, 255], (y * width + x) * 4);
      }
    }
    expect(removeUniformBorderBackground({ width, height, data })).toBeNull();
  });
});

describe("median smoothing (denoise)", () => {
  const solid = (r: number, g: number, b: number) => ({ r, g, b, a: 255 });

  it("radius 0 returns the grid unchanged", () => {
    const grid: SampledGrid = { width: 2, height: 1, cells: [solid(10, 20, 30), solid(40, 50, 60)] };
    expect(medianSmoothGrid(grid, 0)).toBe(grid);
  });

  it("removes an isolated speckle pixel toward the surrounding majority", () => {
    // 3x3 全白，中心一个黑色噪点 → 3x3 中值应把中心拉回白
    const cells = Array.from({ length: 9 }, () => solid(255, 255, 255));
    cells[4] = solid(0, 0, 0);
    const grid: SampledGrid = { width: 3, height: 3, cells };
    const out = medianSmoothGrid(grid, 1);
    expect(out.cells[4]).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  it("keeps transparent cells transparent and does not fill them", () => {
    const grid: SampledGrid = {
      width: 3,
      height: 1,
      cells: [null, solid(100, 100, 100), null]
    };
    const out = medianSmoothGrid(grid, 1);
    expect(out.cells[0]).toBeNull();
    expect(out.cells[2]).toBeNull();
    expect(out.cells[1]).not.toBeNull();
  });
});

describe("crop and auto-crop", () => {
  // 3x3，中心一个不透明红点，其余全透明
  const dot: PixelSource = (() => {
    const data = new Uint8ClampedArray(3 * 3 * 4);
    const c = (1 * 3 + 1) * 4;
    data[c] = 255; data[c + 1] = 0; data[c + 2] = 0; data[c + 3] = 255;
    return { width: 3, height: 3, data };
  })();

  it("crops a sub-rectangle and copies the right pixels", () => {
    const out = cropPixelSource(dot, { x: 1, y: 1, width: 1, height: 1 });
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
    expect(Array.from(out.data)).toEqual([255, 0, 0, 255]);
  });

  it("clamps out-of-bounds crop rectangles", () => {
    const out = cropPixelSource(dot, { x: 2, y: 2, width: 10, height: 10 });
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
  });

  it("rectFromFractions maps normalized coords to pixels", () => {
    const r = rectFromFractions({ width: 200, height: 100 }, 0.5, 0.0, 0.25, 1);
    expect(r).toEqual({ x: 100, y: 0, width: 50, height: 100 });
  });

  it("finds opaque bounds and returns null when fully transparent", () => {
    expect(findOpaqueBounds(dot)).toEqual({ x: 1, y: 1, width: 1, height: 1 });
    const empty: PixelSource = { width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) };
    expect(findOpaqueBounds(empty)).toBeNull();
  });

  it("auto-crops to the opaque subject", () => {
    const out = autoCropToContent(dot, 16, 0); // no padding
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
    expect(out.data[3]).toBe(255);
  });

  it("auto-frames a colored subject before white margins consume bead resolution", () => {
    const width = 10;
    const height = 10;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      data.set([255, 255, 255, 255], index * 4);
    }
    for (let y = 3; y <= 6; y += 1) {
      for (let x = 4; x <= 5; x += 1) {
        data.set([240, 90, 20, 255], (y * width + x) * 4);
      }
    }

    const framed = autoFramePixelSource({ width, height, data }, { ignoreWhiteBg: true, paddingRatio: 0 });
    expect(framed.width).toBe(4);
    expect(framed.height).toBe(6);
  });
});

describe("pixel-art detail recovery", () => {
  const makeUpscaledChecker = (logicalWidth: number, logicalHeight: number, scale: number): PixelSource => {
    const width = logicalWidth * scale;
    const height = logicalHeight * scale;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const light = (Math.floor(x / scale) + Math.floor(y / scale)) % 2 === 0;
        data.set(light ? [245, 170, 35, 255] : [10, 15, 22, 255], (y * width + x) * 4);
      }
    }
    return { width, height, data };
  };

  it("recognizes hard-edged block art and recovers its logical pixel dimensions", () => {
    const source = makeUpscaledChecker(12, 16, 6);
    expect(isLikelyPixelArt(source)).toBe(true);
    expect(estimatePixelArtScale(source)).toBe(6);
    expect(resolveSmartGridSize(source, { boardWidth: 52, boardHeight: 52, smartSize: true }))
      .toEqual({ width: 12, height: 16 });
  });

  it("still recognizes periodic pixel art with JPEG-like soft noise inside blocks", () => {
    const source = makeUpscaledChecker(18, 24, 9);
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        if (x % 9 !== 4 && y % 9 !== 4) continue;
        const index = (y * source.width + x) * 4;
        source.data[index] = Math.min(255, source.data[index] + 15);
        source.data[index + 1] = Math.min(255, source.data[index + 1] + 15);
        source.data[index + 2] = Math.min(255, source.data[index + 2] + 15);
      }
    }

    expect(isLikelyPixelArt(source)).toBe(true);
    expect(estimatePixelArtScale(source)).toBe(9);
  });

  it("frames an Agumon-like 9px sprite into the expected 23 by 31 logical chart", () => {
    const subject = makeUpscaledChecker(21, 29, 9);
    const width = subject.width + 36;
    const height = subject.height + 36;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < subject.height; y += 1) {
      const sourceStart = y * subject.width * 4;
      const targetStart = ((y + 18) * width + 18) * 4;
      data.set(subject.data.subarray(sourceStart, sourceStart + subject.width * 4), targetStart);
    }

    const framed = autoCropToContent({ width, height, data });
    expect(framed.width).toBe(205);
    expect(framed.height).toBe(277);
    expect(estimatePixelArtScale(framed)).toBe(9);
    expect(resolveSmartGridSize(framed, { boardWidth: 52, boardHeight: 52, smartSize: true }))
      .toEqual({ width: 23, height: 31 });
  });

  it("does not treat a high-resolution flat illustration as periodic pixel art", () => {
    const width = 120;
    const height = 100;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const subject = x >= 20 && x < 100 && y >= 20 && y < 80;
        data.set(subject ? [245, 170, 35, 255] : [20, 190, 235, 255], (y * width + x) * 4);
      }
    }

    expect(isLikelyPixelArt({ width, height, data })).toBe(false);
  });

  it("does not invent a larger grid when a small pixel-art source is already one pixel per bead", () => {
    const width = 23;
    const height = 31;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const light = x < 12 !== y < 16;
        data.set(light ? [245, 170, 35, 255] : [10, 15, 22, 255], (y * width + x) * 4);
      }
    }
    const source = { width, height, data };
    expect(resolveSmartGridSize(source, { boardWidth: 52, boardHeight: 52, smartSize: true }))
      .toEqual({ width: 23, height: 31 });
  });

  it("keeps area averaging available for photos while nearest mode preserves hard colors", () => {
    const source: PixelSource = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([
        0, 0, 0, 255, 255, 255, 255, 255,
        255, 255, 255, 255, 0, 0, 0, 255
      ])
    };
    const base = {
      boardWidth: 1,
      boardHeight: 1,
      maxColors: "all" as const,
      keepTransparent: false,
      transparentThreshold: 10,
      dither: false,
      fit: "stretch" as const
    };
    const smooth = resampleToGrid(source, { ...base, sampling: "area" });
    const crisp = resampleToGrid(source, { ...base, sampling: "nearest" });
    expect(Math.round(smooth.cells[0]!.r)).toBe(128);
    expect([0, 255]).toContain(Math.round(crisp.cells[0]!.r));
  });
});

describe("color conversion", () => {
  it("parses short and long hex colors", () => {
    expect(hexToRgb("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb("#0a1b2c")).toEqual({ r: 10, g: 27, b: 44 });
  });

  it("finds the nearest MARD palette color by perceptual distance", () => {
    const nearest = findNearestPaletteColor({ r: 245, g: 18, b: 20 }, palette);

    expect(nearest.code).toBe("R1");
  });
});

describe("image to bead design conversion", () => {
  it("maps pixels to palette colors, preserves transparency, and counts beads", () => {
    const source = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([
        255, 0, 0, 255,
        255, 255, 255, 255,
        0, 0, 0, 255,
        0, 0, 255, 0
      ])
    };

    const design = convertPixelSourceToDesign(source, "sample.png", {
      boardWidth: 2,
      boardHeight: 2,
      maxColors: "all",
      keepTransparent: true,
      transparentThreshold: 10,
      dither: false
    }, palette);

    expect(design.matrix).toEqual([
      ["R1", "W1"],
      ["K1", null]
    ]);
    expect(design.colorCounts).toEqual({ R1: 1, W1: 1, K1: 1 });
  });

  it("limits the active palette to the most-used colors before final remapping", () => {
    const source = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([
        255, 0, 0, 255,
        255, 0, 0, 255,
        255, 0, 0, 255,
        0, 0, 255, 255
      ])
    };

    const design = convertPixelSourceToDesign(source, "limited.png", {
      boardWidth: 2,
      boardHeight: 2,
      maxColors: 1,
      keepTransparent: false,
      transparentThreshold: 10,
      dither: false
    }, palette);

    expect(countMatrixColors(design.matrix)).toEqual({ R1: 4 });
  });

  it("reserves a limited-palette slot for a rare high-contrast feature color", () => {
    const detailPalette = preparePalette([
      { code: "O", nameZh: "主体橙", hex: "#f0a020" },
      { code: "S1", nameZh: "橙影1", hex: "#e89c24" },
      { code: "S2", nameZh: "橙影2", hex: "#e09828" },
      { code: "S3", nameZh: "橙影3", hex: "#d8942c" },
      { code: "S4", nameZh: "橙影4", hex: "#d09030" },
      { code: "S5", nameZh: "橙影5", hex: "#c88c34" },
      { code: "S6", nameZh: "橙影6", hex: "#c08838" },
      { code: "S7", nameZh: "橙影7", hex: "#b8843c" },
      { code: "EYE", nameZh: "眼睛绿", hex: "#00b84a" }
    ]);
    const width = 12;
    const height = 12;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      data.set([240, 160, 32, 255], index * 4);
    }
    const shades = [
      [232, 156, 36], [224, 152, 40], [216, 148, 44], [208, 144, 48],
      [200, 140, 52], [192, 136, 56], [184, 132, 60]
    ];
    shades.forEach((rgb, shadeIndex) => {
      const startX = (shadeIndex % 4) * 3;
      const startY = Math.floor(shadeIndex / 4) * 3;
      for (let y = startY; y < startY + 2; y += 1) {
        for (let x = startX; x < startX + 2; x += 1) {
          data.set([...rgb, 255], (y * width + x) * 4);
        }
      }
    });
    data.set([0, 184, 74, 255], (6 * width + 6) * 4);

    const design = convertPixelSourceToDesign({ width, height, data }, "eye-detail.png", {
      boardWidth: width,
      boardHeight: height,
      maxColors: 8,
      keepTransparent: false,
      transparentThreshold: 10,
      dither: false,
      fit: "stretch",
      sampling: "nearest",
      autoFrame: false
    }, detailPalette);

    expect(design.colorCounts.EYE).toBe(1);
    expect(Object.keys(design.colorCounts)).toHaveLength(8);
  });
});

describe("pattern workbench", () => {
  const design = {
    id: "workbench",
    fileName: "agumon.png",
    boardWidth: 3,
    boardHeight: 2,
    matrix: [["A1", "H7", null], ["B1", "A1", "H7"]],
    colorCounts: { A1: 2, H7: 2, B1: 1 }
  };

  it("recolors and erases one cell while keeping counts exact and source immutable", () => {
    const recolored = replaceDesignCell(design, 0, 0, "B1");
    expect(recolored.matrix).toEqual([["B1", "H7", null], ["B1", "A1", "H7"]]);
    expect(recolored.colorCounts).toEqual({ A1: 1, H7: 2, B1: 2 });
    expect(design.matrix[0][0]).toBe("A1");

    const erased = replaceDesignCell(recolored, 1, 1, null);
    expect(erased.colorCounts).toEqual({ H7: 2, B1: 2 });
    expect(replaceDesignCell(erased, -1, 0, "A1")).toBe(erased);
  });

  it("mirrors the chart horizontally without changing bead totals", () => {
    const mirrored = mirrorDesignHorizontally(design);
    expect(mirrored.matrix).toEqual([[null, "H7", "A1"], ["H7", "A1", "B1"]]);
    expect(mirrored.colorCounts).toEqual(design.colorCounts);
    expect(design.matrix[0]).toEqual(["A1", "H7", null]);
  });

  it("uses a stable fingerprint that changes when the pattern changes", () => {
    const samePatternWithAnotherId = { ...design, id: "another-id" };
    expect(designFingerprint(design)).toBe(designFingerprint(samePatternWithAnotherId));
    expect(designFingerprint(replaceDesignCell(design, 0, 0, "B1"))).not.toBe(designFingerprint(design));
  });

  it("calculates remaining beads for the focused build color", () => {
    const completed = new Set([0, 4]);
    expect(getColorBuildProgress(design, completed, "A1"))
      .toEqual({ total: 2, completed: 2, remaining: 0 });
    expect(getColorBuildProgress(design, completed, "H7"))
      .toEqual({ total: 2, completed: 0, remaining: 2 });
  });
});

describe("resampling", () => {
  const horizontalStripe: PixelSource = {
    width: 4,
    height: 2,
    data: new Uint8ClampedArray([
      255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
      0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255
    ])
  };

  it("box-filters source pixels into a target cell", () => {
    const checker: PixelSource = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([
        0, 0, 0, 255, 255, 255, 255, 255,
        255, 255, 255, 255, 0, 0, 0, 255
      ])
    };

    const grid = resampleToGrid(checker, {
      boardWidth: 1,
      boardHeight: 1,
      maxColors: "all",
      keepTransparent: false,
      transparentThreshold: 10,
      dither: false,
      fit: "stretch"
    });

    const cell = grid.cells[0];
    expect(cell).not.toBeNull();
    expect(Math.round(cell!.r)).toBe(128);
    expect(Math.round(cell!.g)).toBe(128);
    expect(Math.round(cell!.b)).toBe(128);
  });

  it("contains the source with letterbox transparent margins", () => {
    const grid = resampleToGrid(horizontalStripe, {
      boardWidth: 4,
      boardHeight: 4,
      maxColors: "all",
      keepTransparent: true,
      transparentThreshold: 10,
      dither: false,
      fit: "contain"
    });

    // 4x2 source into 4x4 contain → fills rows 1 and 2 (centered), rows 0 and 3 are letterbox
    expect(grid.cells.slice(0, 4)).toEqual([null, null, null, null]);
    expect(grid.cells.slice(12, 16)).toEqual([null, null, null, null]);
    expect(grid.cells[4]).not.toBeNull();
    expect(grid.cells[8]).not.toBeNull();
  });

  it("covers fills the target by cropping the source", () => {
    const grid = resampleToGrid(horizontalStripe, {
      boardWidth: 4,
      boardHeight: 4,
      maxColors: "all",
      keepTransparent: true,
      transparentThreshold: 10,
      dither: false,
      fit: "cover"
    });

    // every cell should be non-null when cover fills the board
    expect(grid.cells.every((cell) => cell !== null)).toBe(true);
  });
});

describe("Floyd-Steinberg dithering", () => {
  it("uses both palette colors to approximate a mid-tone bar", () => {
    const palette = preparePalette([
      { code: "K1", nameZh: "黑色", hex: "#000000" },
      { code: "W1", nameZh: "白色", hex: "#ffffff" }
    ]);

    const source: PixelSource = {
      width: 8,
      height: 8,
      data: new Uint8ClampedArray(8 * 8 * 4)
    };
    for (let i = 0; i < 8 * 8; i += 1) {
      const idx = i * 4;
      source.data[idx] = 128;
      source.data[idx + 1] = 128;
      source.data[idx + 2] = 128;
      source.data[idx + 3] = 255;
    }

    const design = convertPixelSourceToDesign(source, "gray.png", {
      boardWidth: 8,
      boardHeight: 8,
      maxColors: "all",
      keepTransparent: false,
      transparentThreshold: 10,
      dither: true,
      fit: "stretch"
    }, palette);

    expect(design.colorCounts.K1).toBeGreaterThan(0);
    expect(design.colorCounts.W1).toBeGreaterThan(0);
  });

  it("non-dithered mid-gray collapses to a single palette color", () => {
    const palette = preparePalette([
      { code: "K1", nameZh: "黑色", hex: "#000000" },
      { code: "W1", nameZh: "白色", hex: "#ffffff" }
    ]);

    const source: PixelSource = {
      width: 4,
      height: 4,
      data: new Uint8ClampedArray(4 * 4 * 4)
    };
    for (let i = 0; i < 4 * 4; i += 1) {
      const idx = i * 4;
      source.data[idx] = 128;
      source.data[idx + 1] = 128;
      source.data[idx + 2] = 128;
      source.data[idx + 3] = 255;
    }

    const design = convertPixelSourceToDesign(source, "gray.png", {
      boardWidth: 4,
      boardHeight: 4,
      maxColors: "all",
      keepTransparent: false,
      transparentThreshold: 10,
      dither: false,
      fit: "stretch"
    }, palette);

    expect(Object.keys(design.colorCounts)).toHaveLength(1);
  });
});

describe("allowed color restriction", () => {
  it("only emits codes from the allowed subset", () => {
    const palette = preparePalette([
      { code: "K1", nameZh: "黑色", hex: "#000000" },
      { code: "W1", nameZh: "白色", hex: "#ffffff" },
      { code: "R1", nameZh: "红色", hex: "#ff0000" },
      { code: "B1", nameZh: "蓝色", hex: "#0000ff" }
    ]);

    const source: PixelSource = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([
        255, 0, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255,
        0, 0, 0, 255
      ])
    };

    const design = convertPixelSourceToDesign(source, "rgb.png", {
      boardWidth: 2,
      boardHeight: 2,
      maxColors: "all",
      keepTransparent: false,
      transparentThreshold: 10,
      dither: false,
      fit: "stretch",
      allowedColorCodes: ["K1", "W1"]
    }, palette);

    const usedCodes = new Set(Object.keys(design.colorCounts));
    expect(usedCodes.has("R1")).toBe(false);
    expect(usedCodes.has("B1")).toBe(false);
    for (const code of usedCodes) {
      expect(["K1", "W1"]).toContain(code);
    }
  });

  it("falls back to full palette when the allowed list is empty", () => {
    const palette = preparePalette([
      { code: "K1", nameZh: "黑色", hex: "#000000" },
      { code: "W1", nameZh: "白色", hex: "#ffffff" },
      { code: "R1", nameZh: "红色", hex: "#ff0000" }
    ]);

    const source: PixelSource = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([240, 10, 10, 255])
    };

    const design = convertPixelSourceToDesign(source, "red.png", {
      boardWidth: 1,
      boardHeight: 1,
      maxColors: "all",
      keepTransparent: false,
      transparentThreshold: 10,
      dither: false,
      fit: "stretch",
      allowedColorCodes: []
    }, palette);

    expect(design.colorCounts).toEqual({ R1: 1 });
  });
});

describe("project statistics and exports", () => {
  it("sums color counts across multiple designs", () => {
    const totals = summarizeProject([
      { colorCounts: { R1: 1, B1: 1 } },
      { colorCounts: { R1: 1, W1: 1 } }
    ]);

    expect(totals).toEqual({ R1: 2, B1: 1, W1: 1 });
  });

  it("exports color counts as CSV sorted by quantity", () => {
    const csv = countsToCsv({ R1: 3, W1: 1 }, palette);

    expect(csv.split("\n")).toEqual([
      "色号,颜色名称,HEX,数量",
      "R1,红色,#ff0000,3",
      "W1,白色,#ffffff,1"
    ]);
  });

  it("keeps mobile PNG labels large without exceeding the large-board pixel budget", () => {
    expect(getHighResolutionCellSize({ boardWidth: 52, boardHeight: 52 })).toBe(32);
    expect(getHighResolutionCellSize({ boardWidth: 156, boardHeight: 156 })).toBe(31);
    expect(getHighResolutionCellSize({ boardWidth: 208, boardHeight: 208 })).toBe(23);
  });
});
