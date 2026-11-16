import { describe, expect, it } from "vitest";
import {
  axisLabels, boardLayout, displayBoardCol, displayColumns, heavyBoundaries, overviewLayout, pageCount, parseRange, planPrint, symbolMap, textColorFor
} from "../lib/printPlan";
import type { Matrix } from "../lib/matrix";

function grid(w: number, h: number, fill: (x: number, y: number) => string | null): Matrix {
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => fill(x, y)));
}

describe("planPrint", () => {
  it("splits into boards with per-board counts", () => {
    const m = grid(6, 4, (x) => (x < 3 ? "A1" : "B2"));
    const plan = planPrint(m, 6, 4, 3);
    expect(plan.boards.map((b) => b.number)).toEqual([1, 2, 3, 4]);
    expect(plan.boards[0].counts).toEqual([{ code: "A1", count: 9 }]);
    expect(plan.boards[1].label).toBe("1-2");
    expect(plan.total).toBe(24);
    expect(plan.totals[0].count).toBe(12);
    expect(plan.boardCols).toBe(2);
    expect(plan.boardRows).toBe(2);
  });
  it("skips empty boards but keeps their numbers", () => {
    const m = grid(6, 6, (x, y) => (x < 3 && y < 3 ? "A1" : null));
    const plan = planPrint(m, 6, 6, 3);
    expect(plan.boards.map((b) => b.number)).toEqual([1]);
    expect(plan.skippedEmpty).toEqual([2, 3, 4]);
    expect(pageCount(plan, true)).toBe(2);
  });
  it("whole image as one board when size is 0", () => {
    const plan = planPrint(grid(10, 8, () => "A1"), 10, 8, 0);
    expect(plan.boards).toHaveLength(1);
    expect(plan.boards[0].board.w).toBe(10);
  });
  it("applies a range", () => {
    const m = grid(6, 6, () => "A1");
    const plan = planPrint(m, 6, 6, 3, "2-3");
    expect(plan.boards.map((b) => b.number)).toEqual([2, 3]);
    expect(planPrint(m, 6, 6, 3, "9").boards).toHaveLength(0);
    expect(planPrint(m, 6, 6, 3, "9").rangeError).toBeTruthy();
  });
  it("handles 104x104 in 16 boards", () => {
    const plan = planPrint(grid(104, 104, () => "A1"), 104, 104, 29);
    expect(plan.allBoards).toHaveLength(16);
    expect(plan.boards).toHaveLength(16);
  });
});

describe("parseRange", () => {
  it("parses lists, open ranges and fullwidth separators", () => {
    expect(parseRange("1, 3-4，6-", 8).numbers).toEqual([1, 3, 4, 6, 7, 8]);
    expect(parseRange("-2", 8).numbers).toEqual([1, 2]);
    expect(parseRange("5-3", 8).numbers).toEqual([3, 4, 5]);
    expect(parseRange("", 8).numbers).toEqual([]);
  });
  it("reports junk and out-of-range", () => {
    expect(parseRange("a,2", 8)).toEqual({ numbers: [2], error: expect.any(String) });
    expect(parseRange("7-12", 8).error).toBeTruthy();
  });
});

describe("mirror", () => {
  it("reverses columns, labels and heavy lines", () => {
    expect(displayColumns(4, false)).toEqual([0, 1, 2, 3]);
    expect(displayColumns(4, true)).toEqual([3, 2, 1, 0]);
    expect(axisLabels(3, true)).toEqual([3, 2, 1]);
    expect(heavyBoundaries(12, false).flatMap((v, i) => (v ? [i] : []))).toEqual([5, 10]);
    expect(heavyBoundaries(12, true).flatMap((v, i) => (v ? [i] : []))).toEqual([2, 7]);
    expect(displayBoardCol(0, 4, true)).toBe(3);
    expect(displayBoardCol(1, 4, false)).toBe(1);
  });
});

describe("colour and layout", () => {
  it("chooses readable text colours", () => {
    expect(textColorFor("#000000", "fill")).toBe("#ffffff");
    expect(textColorFor("#ffffff", "fill")).toBe("#111827");
    expect(textColorFor("#000000", "code")).toBe("#111111");
    expect(textColorFor(undefined, "fill")).toBe("#111827");
  });
  it("assigns symbols by count", () => {
    const map = symbolMap([{ code: "A1", count: 5 }, { code: "B1", count: 2 }]);
    expect(map.get("A1")).not.toBe(map.get("B1"));
    expect(map.size).toBe(2);
  });
  it("fits a 29x29 board on A4 and Letter, both orientations", () => {
    for (const paper of ["a4", "letter"] as const) for (const o of ["portrait", "landscape"] as const) {
      const l = boardLayout(paper, o, 29, 29);
      expect(l.cellMm).toBeGreaterThan(4);
      expect(l.gridW).toBeLessThanOrEqual(l.pageW - 2 * l.margin);
      expect(l.gridH).toBeLessThanOrEqual(l.pageH - 2 * l.margin);
      expect(l.side).toBe(o === "landscape");
    }
    expect(overviewLayout("a4", "portrait", 104, 104).gridW).toBeLessThanOrEqual(190);
  });
});
