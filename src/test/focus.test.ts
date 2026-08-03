import { describe, expect, it } from "vitest";
import { resampleToGrid } from "../domain/conversion";
import { computeCropRect, estimateFocus } from "../domain/focus";
import type { PixelSource } from "../domain/types";

function solidSource(width: number, height: number, rgba: [number, number, number, number]): PixelSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data.set(rgba, index * 4);
  }
  return { width, height, data };
}

describe("computeCropRect", () => {
  it("keeps the whole source for contain and equal aspect ratios", () => {
    expect(computeCropRect({ width: 200, height: 100 }, { x: 20, y: 20 }, "contain", 1)).toEqual({
      x: 0, y: 0, width: 200, height: 100
    });
    expect(computeCropRect({ width: 100, height: 100 }, { x: 10, y: 90 }, "cover", 1)).toEqual({
      x: 0, y: 0, width: 100, height: 100
    });
  });

  it("places a left-side focus near the golden line of a cover crop", () => {
    const rect = computeCropRect({ width: 200, height: 100 }, { x: 50, y: 50 }, "cover", 1);
    expect(rect).toEqual({ x: 12, y: 0, width: 100, height: 100 });
    expect((50 - rect.x) / rect.width).toBeCloseTo(0.38, 2);
  });

  it("places right and vertical focal points without leaving source bounds", () => {
    expect(computeCropRect({ width: 200, height: 100 }, { x: 150, y: 50 }, "cover", 1)).toEqual({
      x: 88, y: 0, width: 100, height: 100
    });
    expect(computeCropRect({ width: 100, height: 200 }, { x: 50, y: 50 }, "cover", 1)).toEqual({
      x: 0, y: 12, width: 100, height: 100
    });
    expect(computeCropRect({ width: 200, height: 100 }, { x: -999, y: 999 }, "cover", 1)).toEqual({
      x: 0, y: 0, width: 100, height: 100
    });
  });

  it("falls back safely for invalid focus and target aspect values", () => {
    expect(computeCropRect({ width: 120, height: 80 }, { x: Number.NaN, y: Number.POSITIVE_INFINITY }, "cover", 0)).toEqual({
      x: 0, y: 0, width: 120, height: 80
    });
  });
});

describe("estimateFocus", () => {
  it("falls back to geometric center for a flat source", () => {
    expect(estimateFocus(solidSource(20, 10, [128, 128, 128, 255]))).toEqual({ x: 9.5, y: 4.5 });
  });

  it("finds a saturated high-contrast subject away from center", () => {
    const source = solidSource(20, 10, [128, 128, 128, 255]);
    for (let y = 2; y <= 7; y += 1) {
      for (let x = 1; x <= 5; x += 1) {
        source.data.set([255, 0, 0, 255], (y * source.width + x) * 4);
      }
    }
    const focus = estimateFocus(source);
    expect(focus.x).toBeLessThan(7);
    expect(focus.y).toBeGreaterThan(3);
    expect(focus.y).toBeLessThan(7);
  });

  it("uses automatic focus for cover resampling instead of geometric center", () => {
    const source = solidSource(6, 2, [128, 128, 128, 255]);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        source.data.set([255, 0, 0, 255], (y * source.width + x) * 4);
      }
    }
    const grid = resampleToGrid(source, {
      boardWidth: 2,
      boardHeight: 2,
      maxColors: "all",
      keepTransparent: true,
      transparentThreshold: 10,
      dither: false,
      fit: "cover",
      sampling: "nearest"
    });
    expect(grid.cells.every((cell) => cell?.r === 255 && cell.g === 0 && cell.b === 0)).toBe(true);
  });
});
