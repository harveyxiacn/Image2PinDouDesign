import { describe, expect, it } from "vitest";
import fixture from "./purchase-demand.json";
import type { Counts } from "../lib/model";
import {
  buildPurchasePlans, compareSellers, enforce500Min, estimateCostForRows, formatPurchaseText, groupSupplements, isAM, optimizePacks,
  optimizeWithOffers, enforceMinPacks, packBeads, packCost, planAllSingles, planWithSet, kitOffer, PURCHASE_OFFERS, type PackCounts
} from "../lib/purchase";
import {
  blankSeller, builtinSeller, currentSeller, customSellers, duplicateSeller, freeShippingGap, listSellers, normalizeSeller, removeSeller,
  resetToDefaultSeller, selectSeller, setDefaultHidden, shippingFor, upsertSeller, validateSeller, type Seller
} from "../lib/sellers";

const demand = fixture.demand as Counts;
const need = fixture.need as Counts;

// ---- 老算法的冻结副本（逐字抄自泛化之前的 purchase.ts），用来证明默认卖家数字不变 ----
function legacyOptimize(x: number, code: string, price1200 = 1.26, options: { allow500?: boolean; tolerance?: number } = {}) {
  const n = Math.max(0, Math.round(x));
  if (n <= 0) return { cost: 0, beads: 0, packs: { p4000: 0, p1200: 0, p500: 0 } as PackCounts };
  const allow500 = options.allow500 !== false;
  const max4000 = isAM(code) ? Math.ceil(n / 4000) : 0;
  const max1200 = Math.ceil(n / 1200);
  const cands: Array<{ packs: PackCounts; cost: number; beads: number; count: number }> = [];
  for (let a = 0; a <= max4000; a++) {
    for (let b = 0; b <= max1200; b++) {
      const rest = n - a * 4000 - b * 1200;
      const c = rest > 0 ? (allow500 ? Math.ceil(rest / 500) : -1) : 0;
      if (c < 0) continue;
      const packs: PackCounts = { p4000: a, p1200: b, p500: c };
      cands.push({ packs, cost: packCost(packs, price1200), beads: packBeads(packs), count: a + b + c });
    }
  }
  const minCost = Math.min(...cands.map((c) => c.cost));
  const tolerance = options.tolerance ?? Math.max(0.3, minCost * 0.03);
  const pool = cands.filter((c) => c.cost <= minCost + tolerance + 1e-9);
  pool.sort((p, q) => (p.beads - q.beads) || (p.count - q.count) || (p.cost - q.cost));
  return pool[0];
}
function legacyEnforce(slots: Array<{ code: string; need: number; packs: PackCounts }>, price1200 = 1.26): PackCounts[] {
  const out = slots.map((s) => ({ ...s.packs }));
  const total = out.reduce((sum, p) => sum + p.p500, 0);
  if (total === 0 || total >= 10) return out;
  const without = out.map((p, i) => (p.p500 > 0 ? legacyOptimize(slots[i].need, slots[i].code, price1200, { allow500: false }).packs : p));
  const costA = without.reduce((sum, p) => sum + packCost(p, price1200), 0);
  const costB = out.reduce((sum, p) => sum + packCost(p, price1200), 0) + (10 - total) * 1;
  if (costA <= costB + 1e-9) return without;
  const target = out.findIndex((p) => p.p500 > 0);
  out[target] = { ...out[target], p500: out[target].p500 + (10 - total) };
  return out;
}

describe("generalised optimiser keeps the default numbers", () => {
  it("matches the frozen legacy algorithm over a grid of needs, codes, prices and options", () => {
    const needs = [1, 80, 399, 400, 500, 501, 999, 1000, 1199, 1200, 1201, 1500, 2399, 2400, 3000, 4000, 4001, 5000, 6500, 9999, 12000, 20001];
    for (const code of ["A1", "H7", "M3", "N1", "P2", "ZG1"]) {
      for (const p of [1.26, 1.5]) {
        for (const x of needs) {
          for (const opt of [{}, { allow500: false }, { tolerance: 0 }]) {
            const got = optimizePacks(x, code, p, opt);
            const want = legacyOptimize(x, code, p, opt);
            expect([code, p, x, JSON.stringify(opt), got.packs, got.cost, got.beads]).toEqual([code, p, x, JSON.stringify(opt), want.packs, want.cost, want.beads]);
          }
        }
      }
    }
  });

  it("enforce500Min matches the legacy rule (including the top-up and drop branches)", () => {
    const cases: Array<Array<[string, number]>> = [
      [["P2", 400]], [["P2", 400], ["P3", 400]], [["P2", 400], ["P3", 1000], ["A1", 300]],
      [["A1", 450], ["B2", 450], ["C3", 450], ["D4", 450], ["E5", 450], ["F6", 450], ["G7", 450], ["H8", 450], ["I9", 450], ["J1", 450], ["K2", 450]],
      [["P2", 900], ["P3", 900]], [["P2", 1600], ["Q1", 100]]
    ];
    for (const p of [1.26, 1.5]) {
      for (const rows of cases) {
        const slots = rows.map(([code, n]) => ({ code, need: n, packs: legacyOptimize(n, code, p).packs }));
        expect(enforce500Min(slots, p)).toEqual(legacyEnforce(slots, p));
      }
    }
  });

  it("default seller plans: singles cost equals the sum of legacy per-colour optima plus the 500 rule", () => {
    const codes = Object.keys(need).filter((c) => need[c] > 0);
    const slots = codes.map((code) => ({ code, need: Math.round(need[code]), packs: legacyOptimize(need[code], code).packs }));
    const fixed = legacyEnforce(slots);
    const want = fixed.reduce((sum, p) => sum + packCost(p), 0);
    const plan = planAllSingles(need, demand, 1.26, builtinSeller());
    expect(plan.totalCost).toBeCloseTo(want, 9);
    expect(plan.shipping).toBe(0);
    expect(plan.totalCost).toBe(plan.goodsCost);
  });

  it("buildPurchasePlans for the built-in seller: same 6 plans, same ids, kits priced as before", () => {
    const plans = buildPurchasePlans(need, demand, 1.26, "balanced", builtinSeller());
    expect(plans.map((p) => p.id).sort()).toEqual(["plan-all-singles", "plan-app-current", "plan-set221-185", "plan-set221-210", "plan-set265-257", "plan-set295-352"]);
    for (const offer of PURCHASE_OFFERS.filter((o) => o.kind === "set")) {
      const viaKit = plans.find((p) => p.setOffer?.id === offer.id)!;
      const direct = planWithSet(offer, need, demand, 1.26);
      expect(viaKit.totalCost).toBe(direct.totalCost);
      expect(viaKit.setOffer).toEqual(offer);
    }
    // 不传 seller：当前卖家就是内置默认卖家，结果一样
    expect(buildPurchasePlans(need, demand).map((p) => [p.id, p.totalCost])).toEqual(buildPurchasePlans(need, demand, 1.26, "balanced", builtinSeller()).map((p) => [p.id, p.totalCost]));
    expect(estimateCostForRows([{ code: "A1", qty: 5000 }]).cost).toBeCloseTo(3.43);
  });

  it("price1200 still drives the built-in seller's 1200 pack", () => {
    const a = estimateCostForRows([{ code: "P2", qty: 1200 }], 1.26).cost;
    const b = estimateCostForRows([{ code: "P2", qty: 1200 }], 1.5).cost;
    expect([a, b]).toEqual([1.26, 1.5]);
  });
});

const shop = (over: Partial<Seller> = {}): Seller => ({ id: "x1", name: "小店", packs: [{ id: "k", beads: 1000, price: 1 }], kits: [], shipping: 0, ...over });

describe("generic pack optimiser", () => {
  it("handles arbitrary sizes and prices (least waste inside the cost tolerance)", () => {
    const offers = [{ id: "a", beads: 2000, price: 3 }, { id: "b", beads: 800, price: 1.5 }];
    const r = optimizeWithOffers(3000, "A1", offers);
    expect(r.lines.map((l) => [l.id, l.n])).toEqual([["b", 4]]);
    expect(r.cost).toBeCloseTo(6);
    expect(r.beads).toBe(3200);
  });

  it("buys exactly one pack size when only one exists", () => {
    const r = optimizeWithOffers(2500, "A1", [{ id: "k", beads: 1000, price: 1 }]);
    expect(r.lines).toEqual([{ id: "k", beads: 1000, price: 1, n: 3 }]);
  });

  it("respects the A-M scope and reports nothing when no pack is usable", () => {
    const onlyAM = [{ id: "big", beads: 4000, price: 2, scope: "A-M" as const }];
    expect(optimizeWithOffers(1000, "A1", onlyAM).lines).toHaveLength(1);
    expect(optimizeWithOffers(1000, "P1", onlyAM).lines).toEqual([]);
  });

  it("per-size minimum: total packs below the minimum are topped up or dropped, whichever is cheaper", () => {
    const offers = [{ id: "s", beads: 300, price: 0.2, minPacks: 8 }, { id: "m", beads: 1000, price: 1 }];
    // 两个色号各要 300：各 1 包 300 装（共 2 包 < 8）。补到 8 包 = 0.4 + 6×0.2 = 1.6；去掉 300 装各买 1000 装 = 2.0 → 补满更便宜
    const slots = [{ code: "A1", need: 300 }, { code: "B1", need: 300 }].map((s) => ({ ...s, lines: optimizeWithOffers(s.need, s.code, offers).lines }));
    expect(slots.every((s) => s.lines[0].id === "s")).toBe(true);
    const topped = enforceMinPacks(slots, offers);
    expect(topped.flat().filter((l) => l.id === "s").reduce((n, l) => n + l.n, 0)).toBe(8);
    // 贵的情况：300 装 0.9/包，补满 = 1.8 + 6×0.9 = 7.2，去掉 = 2.0 → 去掉
    const pricey = [{ id: "s", beads: 300, price: 0.9, minPacks: 8 }, { id: "m", beads: 1000, price: 1 }];
    const slots2 = [{ code: "A1", need: 300 }, { code: "B1", need: 300 }].map((s) => ({ ...s, lines: optimizeWithOffers(s.need, s.code, pricey).lines }));
    const dropped = enforceMinPacks(slots2, pricey);
    expect(dropped.flat().some((l) => l.id === "s")).toBe(false);
    expect(dropped.flat().reduce((n, l) => n + l.n, 0)).toBe(2);
  });

  it("an offer with a minimum is never used when allow500 is false", () => {
    const offers = [{ id: "s", beads: 300, price: 0.2, minPacks: 8 }, { id: "m", beads: 1000, price: 1 }];
    expect(optimizeWithOffers(300, "A1", offers, { allow500: false }).lines.map((l) => l.id)).toEqual(["m"]);
  });

  it("stays fast for a very large demand with five pack sizes", () => {
    const offers = [4000, 2000, 1200, 800, 500].map((b, i) => ({ id: `o${i}`, beads: b, price: b / 1000 }));
    const r = optimizeWithOffers(120000, "A1", offers);
    expect(r.beads).toBeGreaterThanOrEqual(120000);
  });
});

describe("shipping and free-shipping threshold", () => {
  const s = shop({ shipping: 8, freeShipping: 50 });
  it("charges the fee below the threshold and waives it at or above", () => {
    expect(shippingFor(s, 40)).toBe(8);
    expect(shippingFor(s, 49.99)).toBe(8);
    expect(shippingFor(s, 50)).toBe(0);
    expect(shippingFor(s, 80)).toBe(0);
    expect(shippingFor(s, 0)).toBe(0);
    expect(shippingFor(shop({ shipping: 8 }), 500)).toBe(8);
    expect(freeShippingGap(s, 42.5)).toBeCloseTo(7.5);
    expect(freeShippingGap(s, 60)).toBe(0);
  });

  it("is added to every plan's total, and the cheapest/recommended tags use the total", () => {
    const seller = shop({ shipping: 8, freeShipping: 50 });
    const plans = buildPurchasePlans({ A1: 3000 }, { A1: 3000 }, 1.26, "balanced", seller);
    const singles = plans.find((p) => p.id === "plan-all-singles")!;
    expect(singles.goodsCost).toBeCloseTo(3);
    expect(singles.shipping).toBe(8);
    expect(singles.totalCost).toBeCloseTo(11);
    expect(singles.freeShippingGap).toBeCloseTo(47);
    expect(plans.every((p) => p.sellerId === "x1" && p.sellerName === "小店")).toBe(true);
    expect(plans.filter((p) => p.cheapest)).toHaveLength(1);
  });

  it("a kit seller with free shipping over the kit price pays no shipping on the kit plan", () => {
    const seller = shop({ shipping: 10, freeShipping: 100, kits: [{ id: "k221", colors: 221, price: 120 }] });
    const plans = buildPurchasePlans({ A1: 1000, B2: 1000 }, { A1: 1000, B2: 1000 }, 1.26, "balanced", seller);
    const kit = plans.find((p) => p.id === "plan-kit-k221")!;
    expect(kit.shipping).toBe(0);
    expect(kit.totalCost).toBe(120);
    expect(kit.setOffer?.confirmed).toBe(false);
  });
});

describe("per-seller comparison", () => {
  const n = { A1: 1000, B2: 3000 };
  const X = shop({ id: "x", name: "X店", shipping: 10 });
  const Y = shop({ id: "y", name: "Y店", packs: [{ id: "k", beads: 1000, price: 1.5 }] });

  it("ranks sellers by their cheapest plan total including shipping", () => {
    const q = compareSellers(n, n, [X, Y]);
    expect(q.map((r) => [r.seller.id, r.total])).toEqual([["y", 6], ["x", 14]]);
  });

  it("flips when free shipping is reached", () => {
    const X2 = { ...X, freeShipping: 3 };
    const q = compareSellers(n, n, [X2, Y]);
    expect(q.map((r) => r.seller.id)).toEqual(["x", "y"]);
    expect(q[0].total).toBe(4);
    expect(q[0].best.shipping).toBe(0);
  });

  it("puts a seller that cannot supply some colours after the ones that can", () => {
    const AMonly = shop({ id: "am", name: "只有AM", packs: [{ id: "b", beads: 4000, price: 0.5, scope: "A-M" }] });
    const q = compareSellers({ A1: 1000, P1: 1000 }, { A1: 1000, P1: 1000 }, [AMonly, Y]);
    expect(q.map((r) => r.seller.id)).toEqual(["y", "am"]);
    expect(q[1].unfulfilled).toEqual(["P1"]);
  });

  it("the built-in seller plus a custom one compare on the fixture list", () => {
    const q = compareSellers(need, demand, [builtinSeller(), shop({ id: "cheap", name: "便宜店", packs: [{ id: "a", beads: 1000, price: 0.5 }] })]);
    expect(q[0].seller.id).toBe("cheap");
    expect(q.find((r) => r.seller.builtin)!.total).toBe(Math.min(...buildPurchasePlans(need, demand, 1.26, "balanced", builtinSeller()).map((p) => p.totalCost)));
  });
});

describe("copy text names the seller", () => {
  it("prefixes the seller name; the default call without a name is unchanged", () => {
    const plan = planAllSingles({ A1: 5000 }, { A1: 5000 }, 1.26, builtinSeller());
    const plain = formatPurchaseText(plan);
    expect(formatPurchaseText(plan, 1.26, "小店")).toBe(`卖家：小店\n${plain}`);
    expect(formatPurchaseText(planAllSingles({}), 1.26, "小店")).toBe("无需补充包");
  });

  it("groups custom pack sizes by size, largest first", () => {
    const seller = shop({ packs: [{ id: "a", beads: 2000, price: 1.8 }, { id: "b", beads: 700, price: 0.7 }] });
    const plan = planAllSingles({ A1: 2700, B1: 700 }, { A1: 2700, B1: 700 }, 1.26, seller);
    const groups = groupSupplements(plan);
    expect(groups.map((g) => [g.size, g.beadsPerPack])).toEqual([["a", 2000], ["b", 700]]);
    expect(formatPurchaseText(plan)).toBe("2000颗装：A1×1\n700颗装：A1×1、B1×1");
  });
});

describe("seller storage helpers", () => {
  const custom = (id: string, name = "店") => ({ ...blankSeller(id), name });
  it("starts with the built-in seller only, and selection falls back to it", () => {
    expect(listSellers({}).map((s) => s.id)).toEqual(["default"]);
    expect(currentSeller({ sellerId: "gone" }).builtin).toBe(true);
  });

  it("adds, edits, selects and deletes custom sellers; deleting the chosen one falls back", () => {
    let prefs: { sellers?: Seller[]; sellerId?: string; sellerDefaultHidden?: boolean } = {};
    prefs = { ...prefs, ...upsertSeller(prefs, custom("s1", "甲"), 10, true) };
    prefs = { ...prefs, ...upsertSeller(prefs, custom("s2", "乙"), 11) };
    expect(currentSeller(prefs).id).toBe("s1");
    prefs = { ...prefs, ...upsertSeller(prefs, { ...custom("s1", "甲甲"), shipping: 6 }, 12) };
    expect(customSellers(prefs).map((s) => [s.id, s.name, s.shipping])).toEqual([["s1", "甲甲", 6], ["s2", "乙", 0]]);
    prefs = { ...prefs, ...removeSeller(prefs, "s1") };
    expect(currentSeller(prefs).builtin).toBe(true);
    expect(customSellers(prefs).map((s) => s.id)).toEqual(["s2"]);
    prefs = { ...prefs, ...removeSeller(prefs, "default") };
    expect(listSellers(prefs).map((s) => s.id)).toEqual(["default", "s2"]);
  });

  it("duplicate makes an editable custom copy of the built-in seller with the same numbers", () => {
    const copy = duplicateSeller(builtinSeller(1.5), "s9", 5);
    expect(copy.builtin).toBeUndefined();
    expect(copy.name).toBe("默认报价（副本）");
    expect(copy.packs).toEqual(builtinSeller(1.5).packs);
    expect(normalizeSeller(copy)).not.toBeNull();
    const a = buildPurchasePlans(need, demand, 1.5, "balanced", builtinSeller(1.5));
    const b = buildPurchasePlans(need, demand, 1.5, "balanced", { ...copy, kits: copy.kits });
    expect(b.map((p) => p.totalCost)).toEqual(a.map((p) => p.totalCost));
  });

  it("hides and resets the built-in seller; it is never lost", () => {
    let prefs: { sellers?: Seller[]; sellerId?: string; sellerDefaultHidden?: boolean } = { ...upsertSeller({}, custom("s1"), 1) };
    prefs = { ...prefs, ...setDefaultHidden(prefs, true) };
    expect(listSellers(prefs).map((s) => s.id)).toEqual(["s1"]);
    expect(currentSeller(prefs).id).toBe("s1");
    prefs = { ...prefs, ...removeSeller(prefs, "s1") };
    expect(listSellers(prefs).map((s) => s.id)).toEqual(["default"]);
    prefs = { ...upsertSeller({}, custom("s1"), 1), ...{} };
    prefs = { ...prefs, ...setDefaultHidden(prefs, true), ...{} };
    prefs = { ...prefs, ...resetToDefaultSeller(prefs) };
    expect(listSellers(prefs).map((s) => s.id)).toEqual(["default", "s1"]);
    expect(currentSeller(prefs).builtin).toBe(true);
    expect({ ...prefs, ...selectSeller(prefs, "s1") }.sellerId).toBe("s1");
  });

  it("rejects or cleans bad stored data", () => {
    expect(normalizeSeller(null)).toBeNull();
    expect(normalizeSeller({ id: "default", name: "x", packs: [{ beads: 1000, price: 1 }] })).toBeNull();
    expect(normalizeSeller({ id: "a", name: "", packs: [{ beads: 1000, price: 1 }] })).toBeNull();
    expect(normalizeSeller({ id: "a", name: "x", packs: [{ beads: -5, price: 1 }] })).toBeNull();
    const ok = normalizeSeller({ id: "a", name: " x ", shipping: "6", freeShipping: 0, packs: [{ beads: "1000", price: "1.234" }, { beads: 10, price: 1 }], kits: [{ colors: 221, price: 100 }, { colors: 0, price: 1 }] })!;
    expect(ok.name).toBe("x");
    expect(ok.shipping).toBe(6);
    expect(ok.freeShipping).toBeUndefined();
    expect(ok.packs).toEqual([{ id: "p1000", beads: 1000, price: 1.23 }]);
    expect(ok.kits).toHaveLength(1);
    expect(validateSeller({ ...ok, name: "" })).not.toBeNull();
    expect(validateSeller(ok)).toBeNull();
    expect(validateSeller({ ...ok, packs: [ok.packs[0], { ...ok.packs[0], id: "z" }] })).toContain("重复");
  });

  it("kitOffer of the built-in kits equals the original offers", () => {
    for (const kit of builtinSeller().kits) expect(kitOffer(kit)).toEqual(PURCHASE_OFFERS.find((o) => o.id === kit.id));
  });
});
