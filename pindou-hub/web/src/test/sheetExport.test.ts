import { describe, expect, it } from "vitest";
import { encodeMatrix, matrixOf } from "../lib/matrix";
import { SHEET_LINE_EVERY, safeFileStem, sheetPlan } from "../lib/sheetExport";

const m = [["A1", "A1", null], ["B2", null, "A1"]];

describe("sheetPlan", () => {
  it("有格子：给出设计、文件名和 10 格一条粗线", () => {
    const p = sheetPlan({ id: "p1", name: "小熊 v2.1", width: 3, height: 2 }, m);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.fileName).toBe("小熊 v2.1-图纸.png");
    expect(p.design.fileName).toBe("小熊 v2.1.png");
    expect(p.design.colorCounts).toEqual({ A1: 3, B2: 1 });
    expect(p.design.boardWidth).toBe(3);
    expect(p.boardLineEvery).toBe(SHEET_LINE_EVERY);
  });
  it("压缩存储的格子也能用", () => {
    const p = sheetPlan({ id: "p1", name: "x", width: 3, height: 2 }, matrixOf({ matrixRle: encodeMatrix(m) }));
    expect(p.ok).toBe(true);
  });
  it("只有用量没有格子：不能导出并说明原因", () => {
    const p = sheetPlan({ id: "p1", name: "x", width: 3, height: 2 }, undefined);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toMatch(/没有每格/);
  });
  it("格子和宽高对不上：不能导出", () => {
    expect(sheetPlan({ id: "p1", name: "x", width: 3, height: 5 }, m).ok).toBe(false);
    expect(sheetPlan({ id: "p1", name: "x" }, m).ok).toBe(false);
  });
});

describe("safeFileStem", () => {
  it("去掉非法字符与首部的点，空名字用兜底", () => {
    expect(safeFileStem('a/b:c*d?"e<f>g|h')).toBe("a b c d e f g h");
    expect(safeFileStem("  ..hidden ")).toBe("hidden");
    expect(safeFileStem("///")).toBe("拼豆图纸");
    expect(safeFileStem("")).toBe("拼豆图纸");
  });
  it("太长的名字截断", () => {
    expect(safeFileStem("豆".repeat(200)).length).toBe(80);
  });
});
