import { describe, expect, it } from "vitest";
import {
  applyChanges, applyCountDelta, brushCells, cellsOfCode, changesFor, countMatrixColors, countsEqual,
  matrixCellAtPoint, matrixDiffCount, matrixEqual, normalizeMatrix, paintCells, replaceCode, strokeCells
} from "../lib/matrixEdit";

describe("matrix editing helpers", () => {
  it("normalizes ragged matrices to the exact grid size", () => {
    expect(normalizeMatrix([["A1"], ["B2", "B2", "B2"]], 2, 2)).toEqual([["A1", null], ["B2", "B2"]]);
    expect(normalizeMatrix(undefined, 2, 2)).toEqual([[null, null], [null, null]]);
  });

  it("maps pointer coordinates to cells, including CSS scaling and gutter", () => {
    const rect = { left: 10, top: 20, width: 300, height: 200 };
    // 10×5 格，每格 20px；位图 200×100，CSS 放大到 300×200：x 比例 2/3，y 比例 1/2。
    expect(matrixCellAtPoint(10 + 30 / (2 / 3), 20 + 30 / 0.5, rect, 200, 100, 10, 5, 20)).toEqual({ r: 1, c: 1 });
    expect(matrixCellAtPoint(9, 20, rect, 200, 100, 10, 5, 20)).toBeNull();
    expect(matrixCellAtPoint(10 + 301, 20 + 201, rect, 200, 100, 10, 5, 20)).toBeNull();
    // gutter=16 时，前 16 个位图像素不是格子（位图 216×116 显示在 300×200 里）。
    const cssX = (bitmapX: number) => 10 + bitmapX * (300 / 216);
    const cssY = (bitmapY: number) => 20 + bitmapY * (200 / 116);
    expect(matrixCellAtPoint(cssX(8), cssY(24), rect, 216, 116, 10, 5, 20)).toBeNull();
    expect(matrixCellAtPoint(cssX(24), cssY(24), rect, 216, 116, 10, 5, 20)).toEqual({ r: 0, c: 0 });
  });

  it("builds 1/2/3 cell brushes and clips at the border", () => {
    expect(brushCells({ r: 2, c: 2 }, 1, 5, 5)).toEqual([{ r: 2, c: 2 }]);
    expect(brushCells({ r: 2, c: 2 }, 2, 5, 5)).toEqual([{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 3, c: 2 }, { r: 3, c: 3 }]);
    expect(brushCells({ r: 0, c: 0 }, 3, 5, 5)).toEqual([{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }, { r: 1, c: 1 }]);
  });

  it("interpolates fast drags and dedupes brush cells", () => {
    const cells = strokeCells({ r: 0, c: 0 }, { r: 0, c: 3 }, 1, 5, 5);
    expect(cells).toEqual([{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }, { r: 0, c: 3 }]);
    const wide = strokeCells({ r: 1, c: 1 }, { r: 1, c: 2 }, 3, 5, 5);
    expect(new Set(wide.map((cell) => `${cell.r},${cell.c}`)).size).toBe(wide.length);
  });

  it("paints and erases while adjusting counts by delta", () => {
    const matrix = [["A1", "A1"], ["B2", null]];
    const counts = { A1: 2, B2: 1, C3: 50 };
    const painted = paintCells(matrix, counts, [{ r: 0, c: 0 }, { r: 1, c: 1 }], "B2", 2, 2);
    expect(painted.matrix).toEqual([["B2", "A1"], ["B2", "B2"]]);
    expect(painted.counts).toEqual({ A1: 1, B2: 3, C3: 50 });
    expect(counts).toEqual({ A1: 2, B2: 1, C3: 50 }); // 原对象不变

    const erased = paintCells(painted.matrix, painted.counts, [{ r: 0, c: 1 }], null, 2, 2);
    expect(erased.matrix).toEqual([["B2", null], ["B2", "B2"]]);
    expect(erased.counts).toEqual({ B2: 3, C3: 50 });
  });

  it("keeps the original references when nothing changes", () => {
    const matrix = [["A1"]];
    const counts = { A1: 1 };
    const same = paintCells(matrix, counts, [{ r: 0, c: 0 }], "A1", 1, 1);
    expect(same.matrix).toBe(matrix);
    expect(same.counts).toBe(counts);
    expect(same.changes).toEqual([]);
    expect(applyChanges(matrix, [])).toBe(matrix);
    expect(applyCountDelta(counts, [])).toBe(counts);
  });

  it("replaces or deletes a whole color in one patch", () => {
    const matrix = [["A1", "B2"], ["A1", null]];
    const counts = { A1: 2, B2: 1 };
    const replaced = replaceCode(matrix, counts, "A1", "B2", 2, 2);
    expect(replaced.matrix).toEqual([["B2", "B2"], ["B2", null]]);
    expect(replaced.counts).toEqual({ B2: 3 });
    const deleted = replaceCode(replaced.matrix, replaced.counts, "B2", null, 2, 2);
    expect(deleted.matrix).toEqual([[null, null], [null, null]]);
    expect(deleted.counts).toEqual({});
  });

  it("recounts matrix colors and compares versions", () => {
    const matrix = [["A1", "A1"], ["B2", null]];
    expect(countMatrixColors(matrix)).toEqual({ A1: 2, B2: 1 });
    expect(cellsOfCode(matrix, "A1", 2, 2)).toEqual([{ r: 0, c: 0 }, { r: 0, c: 1 }]);
    expect(matrixEqual(matrix, normalizeMatrix(matrix, 2, 2))).toBe(true);
    expect(matrixDiffCount(matrix, [["A1", "B2"], ["B2", null]])).toBe(1);
    expect(countsEqual({ A1: 2, B2: 1 }, { B2: 1, A1: 2 })).toBe(true);
    expect(countsEqual({ A1: 2 }, { A1: 2, B2: 1 })).toBe(false);
  });

  it("ignores out-of-bounds and duplicate stroke cells", () => {
    const changes = changesFor([["A1"]], [{ r: 0, c: 0 }, { r: 0, c: 0 }, { r: 9, c: 9 }], "B2", 1, 1);
    expect(changes).toEqual([{ r: 0, c: 0, from: "A1", to: "B2" }]);
  });
});
