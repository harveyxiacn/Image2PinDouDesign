import { describe, expect, it } from "vitest";
import { boardsNeeded, legacyPresetLayout, maxBoardsPerSide, suggestBoardLayout } from "../domain/boards";
import { cleanupIsolatedBeads, mergeRareColors } from "../domain/beadCleanup";
import { convertPixelSourceToDesign, resampleToGrid } from "../domain/conversion";
import { MARD_PALETTE } from "../domain/palette";
import { DEFAULT_SETTINGS, resolveBoardSize, resolveTilePins, toConversionSettings } from "../domain/settings";
import type { BeadMatrix, ConversionSettings, PixelSource } from "../domain/types";
import { mirrorDesignHorizontally } from "../domain/workbench";

const byCode = new Map(MARD_PALETTE.map((color) => [color.code, color]));

function fill(width: number, height: number, color: (x: number, y: number) => [number, number, number, number]): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(color(x, y), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

// 找出与给定色号色差最小、又不是它本身的另一个色号，用来构造“几乎同色”的孤豆。
function closestOtherCode(code: string): string {
  const base = byCode.get(code)!;
  let best = "";
  let bestDistance = Infinity;
  for (const color of MARD_PALETTE) {
    if (color.code === code) continue;
    const distance = (color.lab.l - base.lab.l) ** 2 + (color.lab.a - base.lab.a) ** 2 + (color.lab.b - base.lab.b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = color.code;
    }
  }
  return best;
}

const BASE: ConversionSettings = {
  boardWidth: 10,
  boardHeight: 10,
  maxColors: "all",
  keepTransparent: true,
  transparentThreshold: 10,
  dither: false,
  fit: "stretch",
  sampling: "area",
  autoFrame: false
};

describe("board layouts", () => {
  it("maps legacy presets onto pins × boards and resolves sizes", () => {
    expect(legacyPresetLayout("104")).toEqual({ pins: 52, cols: 2, rows: 2 });
    expect(legacyPresetLayout("52x104")).toEqual({ pins: 52, cols: 1, rows: 2 });
    expect(legacyPresetLayout("smart")).toBeNull();
    expect(resolveBoardSize({ ...DEFAULT_SETTINGS, boardPreset: "boards", boardPins: 29, boardCols: 3, boardRows: 2 }))
      .toEqual({ width: 87, height: 58 });
    expect(resolveTilePins({ ...DEFAULT_SETTINGS, boardPreset: "smart", boardPins: 29 })).toBe(29);
    expect(resolveTilePins({ ...DEFAULT_SETTINGS, boardPreset: "104", boardPins: 29 })).toBe(52);
  });

  it("caps each side at 208 pins and follows the image aspect ratio", () => {
    expect(maxBoardsPerSide(52)).toBe(4);
    expect(maxBoardsPerSide(29)).toBe(7);
    expect(suggestBoardLayout(2, 52, 4)).toEqual({ pins: 52, cols: 4, rows: 2 });
    expect(suggestBoardLayout(0.5, 29, 3)).toEqual({ pins: 29, cols: 2, rows: 3 });
    expect(suggestBoardLayout(1, 52, 9)).toEqual({ pins: 52, cols: 4, rows: 4 });
    expect(boardsNeeded(57, 60, 52)).toEqual({ cols: 2, rows: 2 });
  });

  it("passes the chosen board pins to conversion for split lines and pagination", () => {
    const settings = toConversionSettings({ ...DEFAULT_SETTINGS, boardPreset: "boards", boardPins: 50, boardCols: 2, boardRows: 1 }, null);
    expect(settings).toMatchObject({ boardWidth: 100, boardHeight: 50, boardTilePins: 50, smartSize: false, cleanupNoise: true });
  });
});

describe("bead cleanup", () => {
  it("merges an isolated near-identical bead into its surroundings", () => {
    const near = closestOtherCode("A4");
    const matrix: BeadMatrix = Array.from({ length: 5 }, () => Array(5).fill("A4"));
    matrix[2][2] = near;
    const cleaned = cleanupIsolatedBeads(matrix, MARD_PALETTE);
    expect(cleaned[2][2]).toBe("A4");
    expect(matrix[2][2]).toBe(near);
  });

  it("keeps high-contrast details such as an eye highlight and silhouette edges", () => {
    const matrix: BeadMatrix = Array.from({ length: 5 }, () => Array(5).fill("H7"));
    matrix[2][2] = "H2";
    matrix[0][0] = closestOtherCode("H7");
    expect(cleanupIsolatedBeads(matrix, MARD_PALETTE)).toBe(matrix);
  });

  it("folds rare colors into a close common color but keeps distinctive rare colors", () => {
    const near = closestOtherCode("A4");
    const matrix: BeadMatrix = [
      ["A4", "A4", "A4", "A4"],
      ["A4", near, "A4", "A4"],
      ["A4", "A4", "A4", "H2"],
      ["A4", "A4", "A4", "A4"]
    ];
    const merged = mergeRareColors(matrix, MARD_PALETTE, 3);
    expect(merged[1][1]).toBe("A4");
    expect(merged[2][3]).toBe("H2");
    expect(mergeRareColors(matrix, MARD_PALETTE, 0)).toBe(matrix);
  });
});

describe("pixelation stage", () => {
  it("picks the dominant side of a hard edge instead of a blended halo color", () => {
    // 每格 6×6 源像素；第 1 列格子里左 4 列红、右 2 列蓝，普通面积平均会得到紫色。
    const source = fill(12, 6, (x) => (x < 4 ? [220, 30, 40, 255] : x < 6 ? [30, 60, 220, 255] : [30, 60, 220, 255]));
    const plain = resampleToGrid(source, { ...BASE, boardWidth: 2, boardHeight: 1 });
    const edgeAware = resampleToGrid(source, { ...BASE, boardWidth: 2, boardHeight: 1, edgeAwarePixelate: true });
    expect(plain.cells[0]!.b).toBeGreaterThan(80);
    expect(edgeAware.cells[0]).toMatchObject({ r: 220, g: 30, b: 40 });
    expect(edgeAware.cells[1]).toMatchObject({ r: 30, g: 60, b: 220 });
  });

  it("keeps smooth gradients identical to area averaging", () => {
    const source = fill(30, 30, (x) => [100 + x, 120, 140, 255]);
    const plain = resampleToGrid(source, { ...BASE, boardWidth: 5, boardHeight: 5 });
    const edgeAware = resampleToGrid(source, { ...BASE, boardWidth: 5, boardHeight: 5, edgeAwarePixelate: true });
    expect(edgeAware.cells).toEqual(plain.cells);
  });

  it("returns the pixelated grid alongside the matrix and mirrors it with the design", () => {
    const source = fill(20, 10, (x, y) => (y < 2 ? [0, 0, 0, 0] : x < 10 ? [240, 240, 240, 255] : [20, 20, 20, 255]));
    const design = convertPixelSourceToDesign(source, "pixels.png", { ...BASE, boardWidth: 20, boardHeight: 10 }, MARD_PALETTE);
    expect(design.pixelated).toMatchObject({ width: 20, height: 10 });
    expect(design.pixelated!.data[3]).toBe(0);
    const firstOpaque = (2 * 20) * 4;
    expect(design.pixelated!.data[firstOpaque]).toBeGreaterThan(200);
    const mirrored = mirrorDesignHorizontally(design);
    expect(mirrored.pixelated!.data[firstOpaque]).toBeLessThan(60);
  });
});
