import { describe, expect, it } from "vitest";
import { convertPixelSourceToDesign, resampleToGrid, resolveSmartGridSize } from "../domain/conversion";
import { getDesignSizeOptions } from "../domain/designSizing";
import { analyzeSource, recommendSettings } from "../domain/recommend";
import { DEFAULT_SETTINGS, toConversionSettings } from "../domain/settings";
import { MARD_PALETTE, preparePalette } from "../domain/palette";
import type { PixelSource } from "../domain/types";

function gradient(width: number, height: number): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    data.set([x / width * 255, y / height * 255, 110, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

describe("character detail sizing", () => {
  it("offers proportional portrait and landscape sizes without inventing source pixels", () => {
    const portrait = getDesignSizeOptions(gradient(240, 360), false);
    expect(portrait.map(({ width, height }) => [width, height]))
      .toEqual([[27, 40], [48, 72], [69, 104], [104, 156]]);
    expect(getDesignSizeOptions(gradient(360, 240), false).map(({ width, height }) => [width, height]))
      .toEqual([[40, 27], [72, 48], [104, 69], [156, 104]]);
    expect(getDesignSizeOptions(gradient(20, 30), false)).toHaveLength(1);
  });

  it("uses the framed subject ratio rather than a large transparent margin", () => {
    const source = gradient(240, 360);
    const data = new Uint8ClampedArray(500 * 500 * 4);
    for (let y = 0; y < 360; y++) data.set(source.data.subarray(y * 240 * 4, (y + 1) * 240 * 4), ((y + 50) * 500 + 80) * 4);
    const options = getDesignSizeOptions({ width: 500, height: 500, data });
    expect(options[0].height).toBe(40);
    expect(options[0].width).toBeLessThan(30);
  });

  it.each([2, 4, 6, 8])("preserves enlarged 80x96 pixel artwork at scale %i without sampling aliasing", (scale) => {
    const width = 80 * scale, height = 96 * scale;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      data.set((Math.floor(x / scale) + Math.floor(y / scale)) % 2 ? [20, 30, 40, 255] : [245, 170, 35, 255], (y * width + x) * 4);
    }
    const source = { width, height, data };
    expect(resolveSmartGridSize(source, toConversionSettings(DEFAULT_SETTINGS, null))).toEqual({ width: 80, height: 96 });
    expect(getDesignSizeOptions(source, false)[0]).toMatchObject({ id: "native", width: 80, height: 96 });
  });

  it("generates non-square smart output and obeys exact custom dimensions", () => {
    const source = gradient(300, 400);
    expect(resolveSmartGridSize(source, toConversionSettings(DEFAULT_SETTINGS, null))).toEqual({ width: 78, height: 104 });
    const settings = toConversionSettings({ ...DEFAULT_SETTINGS, boardPreset: "custom", customWidth: 57, customHeight: 60, sampling: "detail" }, null);
    const design = convertPixelSourceToDesign(source, "portrait.png", settings, MARD_PALETTE);
    expect([design.boardWidth, design.boardHeight]).toEqual([57, 60]);
    expect(design.matrix).toHaveLength(60);
    expect(design.matrix.every((row) => row.length === 57)).toBe(true);
    expect(Object.values(design.colorCounts).reduce((sum, n) => sum + n, 0)).toBe(design.matrix.flat().filter(Boolean).length);
  });
});

describe("detail sampling", () => {
  it("retains a small distinctive eye color instead of filling the budget with similar body shades", () => {
    const palette = preparePalette([
      ...Array.from({ length: 16 }, (_, i) => ({ code: `Y${i}`, nameZh: "黄色", hex: `#ff${(130 + i * 6).toString(16)}20` })),
      { code: "GREEN", nameZh: "眼睛", hex: "#159035" }
    ]);
    const width = 40, height = 40;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const { r, g, b } = palette[i < 4 ? 16 : i % 16].rgb;
      data.set([r, g, b, 255], i * 4);
    }
    const settings = { ...toConversionSettings(DEFAULT_SETTINGS, null), boardWidth: width, boardHeight: height,
      smartSize: false, autoFrame: false, ignoreWhiteBg: false, sampling: "detail" as const, maxColors: 8 as const };
    const design = convertPixelSourceToDesign({ width, height, data }, "eye.png", settings, palette);
    expect(design.colorCounts.GREEN).toBe(4);
    expect(Object.keys(design.colorCounts).length).toBeLessThanOrEqual(8);
  });

  it("retains a thin dark outline that area averaging washes out", () => {
    const width = 7, height = 7;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      data.set(x < 2 ? [10, 10, 10, 255] : [245, 175, 40, 255], (y * width + x) * 4);
    }
    const source = { width, height, data };
    const base = { ...toConversionSettings(DEFAULT_SETTINGS, null), boardWidth: 1, boardHeight: 1 };
    expect(resampleToGrid(source, { ...base, sampling: "detail" }).cells[0]).toMatchObject({ r: 10, g: 10, b: 10 });
    expect(resampleToGrid(source, { ...base, sampling: "area" }).cells[0]?.r).toBeGreaterThan(150);
  });

  it("ignores hidden RGB in transparent cells and preserves empty space", () => {
    const source = { width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 0, 240, 180, 40, 255]) };
    const settings = { ...toConversionSettings(DEFAULT_SETTINGS, null), boardWidth: 2, boardHeight: 1, sampling: "detail" as const };
    const grid = resampleToGrid(source, settings);
    expect(grid.cells[0]?.a).toBe(0);
    expect(grid.cells[1]).toMatchObject({ r: 240, g: 180, b: 40, a: 255 });
  });

  it("recommends flat illustrations without photo dithering or smoothing", () => {
    const width = 400, height = 400;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const band = Math.floor((x + y * 0.6) / 31) % 3;
      data.set(band === 0 ? [20, 25, 30, 255] : band === 1 ? [255, 165, 30, 255] : [30, 160, 200, 255], (y * width + x) * 4);
    }
    const analysis = analyzeSource({ width, height, data });
    expect(analysis.kind).toBe("illustration");
    expect(recommendSettings(analysis)).toMatchObject({ boardPreset: "smart", sampling: "detail", dither: false, smooth: 0 });
  });
});
