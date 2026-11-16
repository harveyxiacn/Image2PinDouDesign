import { describe, expect, it } from "vitest";
import { LABEL_MIN_CELL, labelFontPx, labelMinCell, labelsFit, longestCodeLength } from "../lib/matrixLabels";

describe("色号能不能写进格子", () => {
  it("字越多需要的格子越大，且刚好到阈值时字号 >= 9", () => {
    expect(labelMinCell(2)).toBe(LABEL_MIN_CELL);
    expect(labelMinCell(3)).toBeGreaterThan(labelMinCell(2));
    expect(labelMinCell(4)).toBeGreaterThan(labelMinCell(3));
    for (const len of [2, 3, 4]) {
      const c = labelMinCell(len);
      expect(labelFontPx(c, len)).toBeGreaterThanOrEqual(9);
      expect(labelFontPx(c - 1, len)).toBeLessThan(9);
    }
  });
  it("labelsFit 默认按 2 字，也可以指定 3 字", () => {
    expect(labelsFit(LABEL_MIN_CELL - 1)).toBe(false);
    expect(labelsFit(LABEL_MIN_CELL)).toBe(true);
    expect(labelsFit(LABEL_MIN_CELL, 3)).toBe(false);
    expect(labelsFit(labelMinCell(3), 3)).toBe(true);
  });
  it("三字色号（H17、ZG3）在阈值格子里放得下", () => {
    const c = labelMinCell(3);
    expect(labelFontPx(c, 3) * 3 * 0.62).toBeLessThanOrEqual(c);
  });
  it("longestCodeLength 至少 2，忽略空格", () => {
    expect(longestCodeLength([[null, "A1"], [undefined, null]])).toBe(2);
    expect(longestCodeLength([["A1", "H17"], ["ZG3", null]])).toBe(3);
    expect(longestCodeLength([])).toBe(2);
  });
});
