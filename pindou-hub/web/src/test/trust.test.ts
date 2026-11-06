import { describe, expect, it } from "vitest";
import { capOverallConfidence, comparableLegendDiffCount, countsNear, materialLegendDiffCount } from "../lib/recognize/trust";

const diff = [
  { code: "A1", legend: 1401, grid: 1407 },
  { code: "C7", legend: 28, grid: 22 },
  { code: "H7", legend: 500, grid: 500 },
  { code: "B2", legend: 0, grid: 50 }
];

describe("信任度：图例 / 网格差异的容差", () => {
  it("3%（至少 2 颗）以内算接近，超出才算实质差异", () => {
    expect(countsNear(1401, 1407)).toBe(true);
    expect(countsNear(100, 103)).toBe(true);
    expect(countsNear(100, 104)).toBe(false);
    expect(countsNear(28, 22)).toBe(false);
    expect(countsNear(0, 2)).toBe(true);
  });

  it("只统计双方都有数的可比差异；容差内的不计入实质差异", () => {
    expect(comparableLegendDiffCount(diff)).toBe(2);
    expect(materialLegendDiffCount(diff)).toBe(1);
  });

  it("只有容差内差异：不再封顶 69%，但仍不给 100%", () => {
    const out = capOverallConfidence({
      confidence: 1, capacityBad: false, headerBad: false, sizeBad: false,
      comparableDiffs: 1, materialDiffs: 0, cellCoverage: 0.95, legendUsed: true, reading: true
    });
    expect(out).toBe(0.99);
  });

  it("有实质差异 / 网格容量 / 抬头不符 / 调色板警告：封顶 69%", () => {
    const base = {
      confidence: 1, capacityBad: false, headerBad: false, sizeBad: false,
      comparableDiffs: 1, materialDiffs: 0, cellCoverage: 0.95, legendUsed: true, reading: true
    };
    expect(capOverallConfidence({ ...base, materialDiffs: 1 })).toBe(0.69);
    expect(capOverallConfidence({ ...base, capacityBad: true })).toBe(0.69);
    expect(capOverallConfidence({ ...base, headerBad: true })).toBe(0.69);
    expect(capOverallConfidence({ ...base, paletteWarning: "非 MARD" })).toBe(0.69);
  });

  it("无实质疑点且证据完整：允许 100%；缺图例 / 覆盖不足只到 99%", () => {
    const base = {
      confidence: 1, capacityBad: false, headerBad: false, sizeBad: false,
      comparableDiffs: 0, materialDiffs: 0, cellCoverage: 0.95, legendUsed: true, reading: true
    };
    expect(capOverallConfidence(base)).toBe(1);
    expect(capOverallConfidence({ ...base, cellCoverage: 0.5 })).toBe(0.99);
    expect(capOverallConfidence({ ...base, legendUsed: false })).toBe(0.99);
    expect(capOverallConfidence({ ...base, reading: false })).toBe(0.99);
  });
});
