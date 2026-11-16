// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertPixelSourceToDesign, preparePalette } from "../domain/conversion";
import { deserializeDraft, persistDesignDrafts } from "../domain/drafts";
import { withSingleBom } from "../domain/exporters";
import { inventoryToCsv, parseInventoryCsv } from "../domain/projectFile";
import { medianSmoothGrid } from "../domain/simplify";
import type { BeadDesign, ConversionSettings, PixelSource, SampledGrid } from "../domain/types";
import { boardTiles } from "../domain/workbench";

const VALID = new Set(["A1", "B1"]);
const BASE_SETTINGS: ConversionSettings = {
  boardWidth: 2, boardHeight: 2, maxColors: 8, keepTransparent: true, transparentThreshold: 10, dither: false
};
function rawDraft(pins: unknown): unknown {
  return {
    id: "draft-x", fileName: "x", boardWidth: 60, boardHeight: 60, matrix: [],
    settings: { ...BASE_SETTINGS, boardTilePins: pins }
  };
}

describe("corrupt boardTilePins", () => {
  it.each([0.5, 0, -3, "abc", 1e9, null, Number.NaN])("sanitizes %s so boardTiles terminates", (pins) => {
    const draft = deserializeDraft(rawDraft(pins), 0, VALID);
    const safe = draft?.settings?.boardTilePins as number;
    expect(Number.isInteger(safe)).toBe(true);
    expect(safe).toBeGreaterThanOrEqual(10);
    expect(safe).toBeLessThanOrEqual(104);
    expect(boardTiles({ boardWidth: 60, boardHeight: 60 }, safe).length).toBeLessThan(100);
  });

  it("boardTiles itself survives fractional / tiny pins", () => {
    expect(boardTiles({ boardWidth: 5, boardHeight: 5 }, 0.5)).toHaveLength(1);
    expect(boardTiles({ boardWidth: 5, boardHeight: 5 }, 0)).toHaveLength(1);
  });
});

describe("persistDesignDrafts result", () => {
  afterEach(() => vi.restoreAllMocks());
  const design: BeadDesign = {
    id: "draft-1", fileName: "a", boardWidth: 1, boardHeight: 1, matrix: [["A1"]], colorCounts: { A1: 1 }
  };
  it("returns true on success and false when storage throws", () => {
    expect(persistDesignDrafts([design])).toBe(true);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    expect(persistDesignDrafts([design])).toBe(false);
  });
});

describe("dither does not mutate the shared grid", () => {
  it("pixelated preview is identical with and without dithering", () => {
    const palette = preparePalette([
      { code: "A1", nameZh: "黑", hex: "#000000" },
      { code: "B1", nameZh: "白", hex: "#ffffff" }
    ]);
    const width = 8;
    const height = 8;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      data.set([(i * 4) % 256, (i * 4) % 256, (i * 4) % 256, 255], i * 4);
    }
    const source: PixelSource = { width, height, data };
    const settings: ConversionSettings = { ...BASE_SETTINGS, boardWidth: 8, boardHeight: 8, keepTransparent: false, autoFrame: false, sampling: "nearest" };
    const plain = convertPixelSourceToDesign(source, "a.png", settings, palette);
    const dithered = convertPixelSourceToDesign(source, "a.png", { ...settings, dither: true }, palette);
    expect(Array.from(dithered.pixelated!.data)).toEqual(Array.from(plain.pixelated!.data));
  });
});

describe("single BOM", () => {
  it("inventory CSV has exactly one BOM after export wrapping and re-imports", () => {
    const palette = preparePalette([{ code: "A1", nameZh: "黑", hex: "#000000" }]);
    const csv = inventoryToCsv({ A1: 5 }, palette);
    const wrapped = withSingleBom(csv, true);
    expect(wrapped.startsWith("﻿")).toBe(true);
    expect(wrapped.startsWith("﻿﻿")).toBe(false);
    expect(parseInventoryCsv(wrapped, new Set(["A1"])).owned).toEqual({ A1: 5 });
  });
  it("adds no BOM when disabled", () => {
    expect(withSingleBom("﻿{}", false)).toBe("{}");
  });
});

describe("median smoothing is a majority vote", () => {
  it("picks the most common colour, not the median palette index", () => {
    const palette = preparePalette([
      { code: "A1", nameZh: "X", hex: "#000000" },
      { code: "B1", nameZh: "Z", hex: "#808080" },
      { code: "C1", nameZh: "Y", hex: "#ffffff" }
    ]);
    const rgb = (code: string) => palette.find((color) => color.code === code)!.rgb;
    const cell = (code: string) => ({ ...rgb(code), a: 255 });
    // 3x3：4×X、3×Y、2×Z，中心为 Y。下标中值是 Z，多数票是 X。
    const codes = ["A1", "C1", "B1", "A1", "C1", "A1", "B1", "C1", "A1"];
    const grid: SampledGrid = { width: 3, height: 3, cells: codes.map(cell) };
    const out = medianSmoothGrid(grid, 1, palette);
    expect(out.cells[4]).toMatchObject(rgb("A1"));
  });
});
