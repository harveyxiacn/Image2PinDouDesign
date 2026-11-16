import { describe, expect, it } from "vitest";
import {
  MIN_CODE_CELL_MM, SYMBOL_CAPACITY, SYMBOL_FILLS, SYMBOL_MARKS, SYMBOL_SHAPES, axisLabels, boardLayout, cellMmFor, legendCapacity, paginateLegend, suggestBoardSize, symbolSpec, displayBoardCol, displayColumns, heavyBoundaries, overviewLayout, pageCount, parseRange, planPrint, symbolMap, textColorFor
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
  it("gives every colour a distinct symbol, deterministic per pattern", () => {
    const totals = Array.from({ length: 240 }, (_, i) => ({ code: `C${i}`, count: 1000 - i }));
    const a = symbolMap(totals);
    expect(a.size).toBe(240);
    const keys = new Set([...a.values()].map((id) => JSON.stringify(symbolSpec(Number(id)))));
    expect(keys.size).toBe(240);
    expect(symbolMap(totals)).toEqual(a);
    // 颗数最多的拿到最清楚的（无角标的实心图形）
    expect(symbolSpec(Number(a.get("C0")))).toMatchObject({ fill: "solid", mark: 0 });
  });
  it("symbol capacity covers a full kit and stops cleanly past it", () => {
    expect(SYMBOL_CAPACITY).toBe(SYMBOL_SHAPES.length * SYMBOL_FILLS.length * SYMBOL_MARKS.length);
    expect(SYMBOL_CAPACITY).toBeGreaterThanOrEqual(291);
    expect(symbolSpec(SYMBOL_CAPACITY)).toBeUndefined();
    expect(symbolSpec(-1)).toBeUndefined();
    const over = symbolMap(Array.from({ length: SYMBOL_CAPACITY + 3 }, (_, i) => ({ code: `X${i}`, count: 5 })));
    expect(over.size).toBe(SYMBOL_CAPACITY);
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

describe("legend pagination", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ code: `C${i}`, count: n - i }));
  it("keeps everything on the overview page when it fits", () => {
    const cap = legendCapacity("a4", "portrait", 100);
    expect(cap.first).toBeGreaterThan(30);
    const pages = paginateLegend(items(20), cap);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(20);
  });
  it("continues on following pages without losing or repeating entries", () => {
    const cap = legendCapacity("a4", "portrait", 156);
    const all = items(221);
    const pages = paginateLegend(all, cap);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[0].length).toBeLessThanOrEqual(cap.first);
    for (const p of pages.slice(1)) expect(p.length).toBeLessThanOrEqual(cap.rest);
    expect(pages.flat().map((c) => c.code)).toEqual(all.map((c) => c.code));
  });
  it("a tall drawing leaves no room on page 1: legend starts on the next page", () => {
    const cap = legendCapacity("a4", "landscape", 400);
    expect(cap.first).toBe(0);
    const pages = paginateLegend(items(10), cap);
    expect(pages[0]).toEqual([]);
    expect(pages.flat()).toHaveLength(10);
  });
  it("capacity rows fit inside the paper", () => {
    for (const paper of ["a4", "letter"] as const) for (const o of ["portrait", "landscape"] as const) {
      const g = overviewLayout(paper, o, 104, 104).gridH;
      const cap = legendCapacity(paper, o, g);
      expect(cap.cols).toBeGreaterThanOrEqual(1);
      expect(cap.restRows).toBeGreaterThan(5);
      expect(g + cap.firstRows * 5.4).toBeLessThan(pageCountH(paper, o));
    }
  });
});

function pageCountH(paper: "a4" | "letter", o: "portrait" | "landscape"): number {
  const h = paper === "a4" ? 297 : 279.4;
  const w = paper === "a4" ? 210 : 215.9;
  return o === "landscape" ? w : h;
}

describe("small cells: suggest a smaller board", () => {
  it("whole-image board of a big chart is too small, a smaller board fixes it", () => {
    expect(cellMmFor("a4", "portrait", 104, 104, 0)).toBeLessThan(MIN_CODE_CELL_MM);
    const fix = suggestBoardSize("a4", "portrait", 104, 104, 0)!;
    expect(fix.size).toBeGreaterThan(0);
    expect(fix.cellMm).toBeGreaterThanOrEqual(MIN_CODE_CELL_MM);
    expect(fix.fromMm).toBeLessThan(MIN_CODE_CELL_MM);
    // 挑的是够大的里面最大的那块
    const bigger = [58, 52, 36, 29, 20, 15].filter((s) => s > fix.size);
    for (const s of bigger) expect(cellMmFor("a4", "portrait", 104, 104, s)).toBeLessThan(MIN_CODE_CELL_MM);
  });
  it("no suggestion when cells are already big enough or the image is small", () => {
    expect(suggestBoardSize("a4", "portrait", 29, 29, 29)).toBeNull();
    expect(suggestBoardSize("a4", "portrait", 20, 20, 0)).toBeNull();
  });
  it("a smaller threshold (symbols) accepts bigger boards", () => {
    const code = suggestBoardSize("a4", "portrait", 104, 104, 58);
    const sym = suggestBoardSize("a4", "portrait", 104, 104, 58, 2.2);
    expect(code).not.toBeNull();
    expect(sym).toBeNull();
  });
});
