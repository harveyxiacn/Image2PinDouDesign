import { describe, expect, it } from "vitest";
import { labelFontPx, labelTextColor, labelsFit, LABEL_MIN_CELL } from "../lib/matrixLabels";
import { commitEdit, initEdit, MAX_EDIT_HISTORY, redoEdit, undoEdit } from "../lib/editHistory";
import { editedPatternPatch } from "../lib/patternEdit";
import { decodeMatrix } from "../lib/matrix";
import { paintCells } from "../lib/matrixEdit";

describe("色号标注", () => {
  it("小格子不画", () => {
    expect(labelsFit(LABEL_MIN_CELL - 1)).toBe(false);
    expect(labelsFit(LABEL_MIN_CELL)).toBe(true);
  });
  it("深底用白字，浅底用黑字，坏值兜底", () => {
    expect(labelTextColor("#000000")).toBe("#ffffff");
    expect(labelTextColor("#1d4ed8")).toBe("#ffffff");
    expect(labelTextColor("#ffffff")).toBe("#111827");
    expect(labelTextColor("#fde047")).toBe("#111827");
    expect(labelTextColor(undefined)).toBe("#111827");
  });
  it("字号随格子变大，三位色号更小，不超出范围", () => {
    expect(labelFontPx(28, 2)).toBeGreaterThan(labelFontPx(14, 2));
    expect(labelFontPx(20, 3)).toBeLessThanOrEqual(labelFontPx(20, 2));
    expect(labelFontPx(4, 3)).toBe(7);
    expect(labelFontPx(400, 2)).toBe(24);
  });
});

describe("编辑撤销 / 重做", () => {
  const m0 = [["A1", "A1"], ["A2", null]];
  const base = initEdit({ matrix: m0, counts: { A1: 2, A2: 1 } });
  const edit = paintCells(m0, base.counts, [{ r: 0, c: 0 }], null, 2, 2);
  it("提交 → 撤销 → 重做", () => {
    const a = commitEdit(base, edit);
    expect(a.matrix[0][0]).toBeNull();
    expect(a.past).toHaveLength(1);
    const b = undoEdit(a);
    expect(b.matrix).toBe(m0);
    expect(b.future).toHaveLength(1);
    expect(redoEdit(b).matrix).toBe(a.matrix);
    expect(undoEdit(base)).toBe(base);
    expect(redoEdit(base)).toBe(base);
  });
  it("没有变化不入栈；新改动清掉重做栈；栈有上限", () => {
    expect(commitEdit(base, { matrix: base.matrix, counts: base.counts })).toBe(base);
    let st = base;
    for (let i = 0; i < MAX_EDIT_HISTORY + 20; i += 1) st = commitEdit(st, { matrix: st.matrix, counts: { ...st.counts, X: i } });
    expect(st.past).toHaveLength(MAX_EDIT_HISTORY);
    const u = undoEdit(st);
    expect(commitEdit(u, edit).future).toHaveLength(0);
  });
});

describe("编辑后保存补丁", () => {
  const original = [["A1", "A1", "B2"], [null, "B2", "B2"]];
  const counts = { A1: 2, B2: 3 };
  const out = paintCells(original, counts, [{ r: 0, c: 0 }, { r: 0, c: 1 }], null, 3, 2);
  it("新记录写 matrixRle，用量按差值，取消核对并写原因", () => {
    const p = editedPatternPatch({ counts, reviewReasons: ["图例差 2 颗"], matrixRle: "x" }, original, out.matrix, out.counts)!;
    expect(decodeMatrix(p.matrixRle)).toEqual(out.matrix);
    expect(p.matrix).toBeUndefined();
    expect(p.counts).toEqual({ B2: 3 });
    expect(p.verifiedAt).toBeUndefined();
    expect("verifiedAt" in p).toBe(true);
    expect(p.reviewReasons).toEqual(["已手动修改 2 格", "图例差 2 颗"]);
  });
  it("老记录继续写 matrix；旧的“已手动修改”原因被替换", () => {
    const p = editedPatternPatch({ matrix: original, counts, reviewReasons: ["已手动修改 9 格"] }, original, out.matrix, out.counts)!;
    expect(p.matrix).toEqual(out.matrix);
    expect(p.matrixRle).toBeUndefined();
    expect(p.reviewReasons).toEqual(["已手动修改 2 格"]);
  });
  it("没改动返回 null；只改用量不加格数原因", () => {
    expect(editedPatternPatch({ counts }, original, original, counts)).toBeNull();
    const p = editedPatternPatch({ counts, reviewReasons: ["a"] }, original, original, { A1: 5, B2: 3 })!;
    expect(p.reviewReasons).toEqual(["a"]);
    expect(p.counts).toEqual({ A1: 5, B2: 3 });
  });
});
