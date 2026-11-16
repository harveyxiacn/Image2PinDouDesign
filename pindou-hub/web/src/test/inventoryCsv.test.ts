import { describe, expect, it } from "vitest";
import { inventoryExportCsv } from "../lib/inventory";

const palette = [
  { code: "B1", nameZh: "蓝", hex: "#0000FF" },
  { code: "A2", nameZh: "红,深", hex: "#FF0000" },
  { code: "A1", nameZh: "白", hex: "#FFFFFF" },
  { code: "C1", nameZh: "绿", hex: "#00FF00" }
];

describe("inventoryExportCsv", () => {
  it("BOM、表头、只含库存大于 0 的色号、按色号排序", () => {
    const csv = inventoryExportCsv({ A1: 100, A2: 5, B1: 0, C1: -3 }, palette);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe("\uFEFF色号,颜色,HEX,颗数\nA1,白,#FFFFFF,100\nA2,\"红,深\",#FF0000,5\n");
  });
  it("空库存只有表头", () => {
    expect(inventoryExportCsv({}, palette)).toBe("\uFEFF色号,颜色,HEX,颗数\n\n");
  });
});
