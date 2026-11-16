import { describe, expect, it } from "vitest";
import { applyReceipt, makeOrder, openOrderSummary, cancelOrder } from "../lib/orders";
import {
  estimateCostForRows, formatPackLines, formatPacks, mergePackLines, narrowedCodes, optimizePacks, planAllSingles, formatPlanPacks, searchNarrowed, shipNote, compareSellers
} from "../lib/purchase";
import { builtinSeller, withPrice1200, type Seller } from "../lib/sellers";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const shop: Seller = {
  id: "s1", name: "小店", shipping: 8, freeShipping: 30,
  packs: [{ id: "a", beads: 2000, price: 2.4 }, { id: "b", beads: 600, price: 0.9 }], kits: []
};

describe("pack text for arbitrary sizes", () => {
  it("matches the old text for the default seller", () => {
    for (const x of [30, 500, 1300, 5200, 9000]) {
      const o = optimizePacks(x, "A1", 1.26);
      expect(formatPackLines(o.lines)).toBe(formatPacks(o.packs));
    }
    const plan = planAllSingles({ A1: 5200, B2: 900 }, { A1: 5000, B2: 800 }, 1.26);
    expect(formatPlanPacks(plan)).toBe(formatPacks(plan.packs));
  });
  it("shows custom sizes and merges lines by size and price", () => {
    const o = optimizePacks(4700, "Z9", 1.26, { seller: shop });
    expect(o.lines.length).toBeGreaterThan(0);
    expect(formatPackLines(o.lines)).toMatch(/×2000/);
    const m = mergePackLines(o.lines, o.lines);
    expect(m[0].n).toBe(o.lines[0].n * 2);
    expect(formatPackLines([])).toBe("—");
  });
  it("row costs with the chosen seller add up to the list cost when no minimum-pack rule applies", () => {
    const rows = [{ code: "A1", qty: 2500 }, { code: "C3", qty: 700 }];
    const sum = rows.reduce((a, r) => a + optimizePacks(r.qty, r.code, 1.26, { seller: shop }).cost, 0);
    expect(estimateCostForRows(rows, 1.26, shop).cost).toBeCloseTo(sum, 6);
  });
  it("default seller row cost equals the legacy call", () => {
    const sel = withPrice1200(builtinSeller(), 1.5);
    for (const x of [100, 1000, 4200]) expect(optimizePacks(x, "B2", 1.5, { seller: sel }).cost).toBe(optimizePacks(x, "B2", 1.5).cost);
  });
});

describe("shipNote", () => {
  it("adds shipping below the threshold and says how much more to free it", () => {
    const n = shipNote(shop, 22.5);
    expect(n.shipping).toBe(8);
    expect(n.gap).toBe(7.5);
    expect(n.total).toBe(30.5);
    expect(n.text).toContain("再买 ¥7.50 包邮");
  });
  it("no shipping at or above the threshold, none for free sellers, none for an empty cart", () => {
    expect(shipNote(shop, 30)).toMatchObject({ shipping: 0, gap: 0, total: 30 });
    expect(shipNote(shop, 30).text).toContain("包邮");
    expect(shipNote(builtinSeller(), 50)).toEqual({ shipping: 0, gap: 0, total: 50, text: "" });
    expect(shipNote(shop, 0)).toMatchObject({ shipping: 0, total: 0, text: "" });
  });
});

describe("narrowed search warning", () => {
  it("flags only huge demands with several pack sizes", () => {
    const many: Seller = { ...shop, packs: [{ id: "a", beads: 100, price: 1 }, { id: "b", beads: 200, price: 1.8 }, { id: "c", beads: 300, price: 2.5 }, { id: "d", beads: 1000, price: 8 }] };
    expect(searchNarrowed(500, "A1", many.packs)).toBe(false);
    expect(searchNarrowed(5_000_000, "A1", many.packs)).toBe(true);
    expect(searchNarrowed(5_000_000, "A1", [many.packs[0]])).toBe(false);
    expect(narrowedCodes({ A1: 5_000_000, B2: 100, C3: 0 }, many)).toEqual(["A1"]);
  });
  it("is reported by the seller comparison", () => {
    const many: Seller = { ...shop, id: "m", packs: [{ id: "a", beads: 100, price: 1 }, { id: "b", beads: 200, price: 1.8 }, { id: "c", beads: 300, price: 2.5 }, { id: "d", beads: 1000, price: 8 }] };
    const q = compareSellers({ A1: 300 }, { A1: 300 }, [many, builtinSeller()]);
    expect(q.every((x) => !x.narrowed)).toBe(true);
  });
});

describe("openOrderSummary", () => {
  it("counts open orders, beads outstanding and the oldest age", () => {
    const a = makeOrder({ items: [{ code: "A1", qty: 500 }], now: T0, id: "a" })!;
    const b = applyReceipt(makeOrder({ items: [{ code: "B2", qty: 300 }], now: T0 + 3 * DAY, id: "b" })!, { batchId: "x", lines: [{ code: "B2", qty: 100 }] }, T0 + 4 * DAY);
    const c = cancelOrder(makeOrder({ items: [{ code: "C3", qty: 50 }], now: T0, id: "c" })!, T0 + 1);
    expect(openOrderSummary([a, b, c], T0 + 10 * DAY)).toEqual({ count: 2, leftBeads: 700, oldestDays: 10 });
    expect(openOrderSummary([], T0)).toEqual({ count: 0, leftBeads: 0, oldestDays: 0 });
  });
});
