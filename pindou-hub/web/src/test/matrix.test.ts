import { describe, expect, it } from "vitest";
import { decodeMatrix, encodeMatrix, matrixOf } from "../lib/matrix";

describe("matrix compression", () => {
  it("round-trips codes, nulls and runs", () => {
    const matrix = [
      ["A1", "A1", "A1", null, null, "B2"],
      [null, "B2", "B2", "B2", "B2", "B2"],
      [] as Array<string | null>
    ];
    const text = encodeMatrix(matrix);
    expect(text).toContain("A1 B2|");
    expect(text).toContain("~*2");
    expect(decodeMatrix(text)).toEqual(matrix);
  });
  it("is much smaller than JSON for large flat areas", () => {
    const row = Array.from({ length: 80 }, (_, i) => (i < 60 ? "A1" : i < 70 ? "B2" : null));
    const matrix = Array.from({ length: 80 }, () => [...row]);
    const raw = JSON.stringify(matrix).length;
    const packed = encodeMatrix(matrix);
    expect(packed.length).toBeLessThan(raw / 10);
    expect(decodeMatrix(packed)).toEqual(matrix);
  });
  it("rejects corrupt payloads and still reads legacy matrices", () => {
    expect(decodeMatrix(undefined)).toBeUndefined();
    expect(decodeMatrix("no separator")).toBeUndefined();
    expect(decodeMatrix("A1|0*999999")).toBeUndefined();
    expect(decodeMatrix("A1|9*2")).toBeUndefined();
    expect(matrixOf({ matrix: [["A1"]] })).toEqual([["A1"]]);
    expect(matrixOf({ matrixRle: "A1|0*2" })).toEqual([["A1", "A1"]]);
  });
});
