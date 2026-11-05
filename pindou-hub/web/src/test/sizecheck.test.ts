import { describe, expect, it } from "vitest";
import { checkSize } from "../lib/recognize/sizecheck";
import type { AnalyzeResult } from "../lib/recognize/types";

function result(over: Partial<AnalyzeResult> = {}, cols = 64, rows = 60): AnalyzeResult {
  return {
    steps: [], legend: null,
    grid: { grid: { x0: 0, y0: 0, pitchX: 10, pitchY: 10, cols, rows, score: 1 }, matrix: [], counts: {}, colors: [], emptyCells: 0, backgroundHex: null },
    counts: { A1: 3000, B2: 800 }, method: "grid", confidence: 0.9, diff: [], source: { width: 100, height: 100 }, ...over
  };
}

describe("checkSize", () => {
  it("consistent result -> null", () => {
    expect(checkSize(result({ header: { cols: 64, rows: 60, colors: 2, total: 3800 } }))).toBeNull();
    expect(checkSize(result())).toBeNull();
  });
  it("header size differs -> suggestion", () => {
    const r = checkSize(result({ header: { cols: 64, rows: 59, colors: null, total: null } }));
    expect(r?.suggested).toEqual({ cols: 64, rows: 59 });
    expect(r?.detected).toEqual({ cols: 64, rows: 60 });
    expect(r?.reason).toContain("64×60");
    expect(r?.reason).toContain("64×59");
  });
  it("only one header dimension read and differing -> prompt without suggestion", () => {
    const r = checkSize(result({ header: { cols: 63, rows: null, colors: null, total: null } }));
    expect(r).not.toBeNull();
    expect(r?.suggested).toBeUndefined();
  });
  it("total mismatch from grid counts -> prompt without suggestion", () => {
    const r = checkSize(result({ header: { cols: 64, rows: 60, colors: null, total: 3500 } }));
    expect(r).not.toBeNull();
    expect(r?.suggested).toBeUndefined();
  });
  it("total within 1% or counts from legend -> null", () => {
    expect(checkSize(result({ header: { cols: null, rows: null, colors: null, total: 3820 } }))).toBeNull();
    expect(checkSize(result({ method: "legend+grid", header: { cols: null, rows: null, colors: null, total: 3500 } }))).toBeNull();
  });
  it("no grid but header size -> suggestion; nothing at all -> null", () => {
    const r = checkSize(result({ grid: null, method: "none", header: { cols: 55, rows: 61, colors: null, total: null } }));
    expect(r?.detected).toBeNull();
    expect(r?.suggested).toEqual({ cols: 55, rows: 61 });
    expect(checkSize(result({ grid: null, method: "none" }))).toBeNull();
  });
  it("very blurry image -> prompt without suggestion; low quality alone -> null", () => {
    const enh = (level: "good" | "low" | "very-low") => ({ applied: true, method: "chart-rebuild" as const, scale: 3, level, from: { width: 1, height: 1 }, to: { width: 3, height: 3 }, detail: "" });
    const r = checkSize(result({ enhance: enh("very-low") }));
    expect(r?.reason).toContain("64×60");
    expect(r?.suggested).toBeUndefined();
    expect(checkSize(result({ enhance: enh("low") }))).toBeNull();
  });
});
