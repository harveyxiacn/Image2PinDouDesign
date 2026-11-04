import { describe, expect, it } from "vitest";
import { buildConversionSettings, DEFAULT_GENERATE_OPTIONS, previewCellSize, runConversion } from "../lib/generate";
import type { PixelSource } from "@engine/types";

function synthetic(): PixelSource {
  const width = 16, height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const left = x < 8;
    data[i] = left ? 220 : 20; data[i + 1] = left ? 30 : 60; data[i + 2] = left ? 30 : 200; data[i + 3] = 255;
  }
  return { width, height, data };
}

describe("generate", () => {
  it("converts a tiny two-colour image into a bead design", () => {
    const settings = buildConversionSettings({ ...DEFAULT_GENERATE_OPTIONS, board: "29", maxColors: 8, ignoreWhiteBg: false });
    expect(settings.boardWidth).toBe(29);
    const design = runConversion(synthetic(), "t.png", settings);
    expect(design.matrix.length).toBe(design.boardHeight);
    const total = Object.values(design.colorCounts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(Object.keys(design.colorCounts).length).toBeGreaterThanOrEqual(2);
    expect(design.pixelated).toBeTruthy();
  });
  it("restricts to owned codes", () => {
    const settings = buildConversionSettings({ ...DEFAULT_GENERATE_OPTIONS, board: "29", ownedCodes: ["H7", "A1", "B1", "C1", "D1", "E1", "F1", "G1"] });
    const design = runConversion(synthetic(), "t.png", settings);
    for (const code of Object.keys(design.colorCounts)) expect(["H7", "A1", "B1", "C1", "D1", "E1", "F1", "G1"]).toContain(code);
  });
  it("keeps preview within 16MP", () => {
    const cell = previewCellSize({ boardWidth: 200, boardHeight: 200 }, 32);
    expect(200 * cell * 200 * cell).toBeLessThanOrEqual(16_000_000);
  });
});
