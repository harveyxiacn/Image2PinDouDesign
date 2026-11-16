import { describe, expect, it } from "vitest";
import {
  MIN_READABLE_SCREEN_CELL, compareColorCodes, computeSheetLayout, gridLineKind, gridLineStyle,
  isEmphasisedIndex, labelFontSize, labelsReadableOnScreen, lineStart, shouldDrawLabels, sheetPixels,
  zoomForReadableLabels
} from "./sheetLayout";

describe("label layout", () => {
  it("fits 3-char codes inside the cell and keeps a floor", () => {
    for (const cell of [16, 22, 32]) {
      const size = labelFontSize(cell, 3);
      expect(size * 0.62 * 3).toBeLessThanOrEqual(cell);
      expect(size).toBeGreaterThanOrEqual(8);
    }
    expect(labelFontSize(32, 2)).toBe(16);
    expect(labelFontSize(32, 3)).toBeLessThan(labelFontSize(32, 2));
  });
  it("skips labels below the minimum cell", () => {
    expect(shouldDrawLabels(12)).toBe(false);
    expect(shouldDrawLabels(13)).toBe(true);
  });
  it("judges screen readability and the zoom that fixes it", () => {
    expect(labelsReadableOnScreen(22, 0.35)).toBe(false);
    expect(labelsReadableOnScreen(22, 1)).toBe(true);
    const z = zoomForReadableLabels(16);
    expect(16 * z).toBeGreaterThanOrEqual(MIN_READABLE_SCREEN_CELL);
    expect(zoomForReadableLabels(22)).toBe(1);
    expect(zoomForReadableLabels(0)).toBe(1);
  });
});

describe("grid lines", () => {
  it("classifies frame, board, ten, five and thin lines", () => {
    expect(gridLineKind(0, 40, 52)).toBe("frame");
    expect(gridLineKind(40, 40, 52)).toBe("frame");
    expect(gridLineKind(26, 104, 26)).toBe("board");
    expect(gridLineKind(52, 104, 26)).toBe("board");
    expect(gridLineKind(10, 104, 52)).toBe("ten");
    expect(gridLineKind(15, 104, 52)).toBe("five");
    expect(gridLineKind(7, 104, 52)).toBe("thin");
  });
  it("makes heavier lines thicker, only thin ones light", () => {
    const w = (k: Parameters<typeof gridLineStyle>[0]) => gridLineStyle(k, 32).width;
    expect(w("thin")).toBeLessThan(w("five"));
    expect(w("five")).toBeLessThan(w("ten"));
    expect(w("ten")).toBeLessThan(w("frame"));
    expect(gridLineStyle("five", 32).color).toBe("#000000");
    expect(gridLineStyle("thin", 32).color).not.toBe("#000000");
    for (const kind of ["thin", "five", "ten", "board", "frame"] as const) {
      expect(Number.isInteger(gridLineStyle(kind, 21).width)).toBe(true);
    }
  });
  it("aligns lines to whole pixels", () => {
    expect(Number.isInteger(lineStart(96, 3))).toBe(true);
    expect(lineStart(96, 2)).toBe(95);
  });
  it("emphasises 1 and multiples of 5", () => {
    expect([1, 2, 5, 10, 11].map(isEmphasisedIndex)).toEqual([true, false, true, true, false]);
  });
});

describe("colour code ordering", () => {
  it("sorts by series then number", () => {
    expect(["B1", "A10", "A2", "H7", "ZG3", "A1"].sort(compareColorCodes)).toEqual(["A1", "A2", "A10", "B1", "H7", "ZG3"]);
  });
});

describe("sheet layout", () => {
  const base = { boardWidth: 104, boardHeight: 104, cell: 24, colorCount: 60 };
  it("wraps the legend into columns and rows that hold every colour", () => {
    const l = computeSheetLayout(base);
    expect(l.legend.columns * l.legend.entryWidth).toBeLessThanOrEqual(l.width - l.margin * 2);
    expect(l.legend.columns * l.legend.rows).toBeGreaterThanOrEqual(60);
    expect(l.legend.columns).toBeGreaterThan(1);
  });
  it("stacks title, grid, legend and total without overlap", () => {
    const l = computeSheetLayout(base);
    expect(l.gridTop).toBeGreaterThan(l.header);
    expect(l.legend.top).toBeGreaterThan(l.gridTop + l.gridHeight);
    expect(l.legend.entriesTop).toBeGreaterThan(l.legend.top);
    expect(l.legend.totalTop).toBeGreaterThanOrEqual(l.legend.entriesTop + l.legend.rows * l.legend.entryHeight);
    expect(l.height).toBeGreaterThan(l.legend.totalTop);
  });
  it("scales the legend font with the sheet and has a minimum width", () => {
    const small = computeSheetLayout({ ...base, boardWidth: 10, boardHeight: 10, cell: 20 });
    const big = computeSheetLayout({ ...base, cell: 32 });
    expect(big.legend.font).toBeGreaterThan(small.legend.font);
    expect(small.width).toBeGreaterThanOrEqual(520);
  });
  it("handles zero colours and grows with colour count", () => {
    expect(computeSheetLayout({ ...base, colorCount: 0 }).legend.rows).toBe(0);
    expect(sheetPixels({ ...base, colorCount: 200 })).toBeGreaterThan(sheetPixels(base));
  });
});
