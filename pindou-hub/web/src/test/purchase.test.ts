import { describe, expect, it } from "vitest";
import fixture from "./purchase-demand.json";
import type { Counts } from "../lib/model";
import {
  PURCHASE_OFFERS, applyPlanToEdits, buildPurchasePlans, estimateCostForRows, formatPacks, formatPurchaseText, groupSupplements,
  isAM, leftoverBreakdown, makeOrderSnapshot, nextStamp, optimizePacks, orderIsFresh, orderSummary, parsePrefer, pendingOrder,
  planAllSingles, recommendationReason, tagPlans, type PurchasePlan
} from "../lib/purchase";

const demand = fixture.demand as Counts;
const need = fixture.need as Counts;

describe("purchase optimizer", () => {
  it("uses the 1200 pack for a 1000-bead A–M gap", () => {
    const result = optimizePacks(1000, "A1");
    expect(result.packs).toEqual({ p4000: 0, p1200: 1, p500: 0 });
    expect(result.cost).toBeCloseTo(1.26);
  });

  it("uses 4000 + 1200 for a 5000-bead A–M gap", () => {
    const result = optimizePacks(5000, "H2");
    expect(result.packs).toEqual({ p4000: 1, p1200: 1, p500: 0 });
    expect(result.cost).toBeCloseTo(3.43);
  });

  it("does not use the 4000 pack outside A–M", () => {
    const result = optimizePacks(5000, "P2");
    expect(result.packs.p4000).toBe(0);
    expect(result.packs.p1200).toBe(4);
    expect(result.packs.p500).toBe(1);
    expect(result.cost).toBeCloseTo(6.04);
  });

  it("falls back to a 500 pack when it is cheaper than 1200", () => {
    const result = optimizePacks(400, "P2");
    expect(result.packs).toEqual({ p4000: 0, p1200: 0, p500: 1 });
    expect(result.cost).toBe(1);
  });

  it("breaks near-cost ties by least surplus (within max(¥0.30, 3%))", () => {
    // 纯最省钱：1×4000 = 2.17（剩 2500）；1200 + 500 = 2.26（多 ¥0.09，只剩 200）
    expect(optimizePacks(1500, "A1", 1.26, { tolerance: 0 }).packs).toEqual({ p4000: 1, p1200: 0, p500: 0 });
    const result = optimizePacks(1500, "A1");
    expect(result.packs).toEqual({ p4000: 0, p1200: 1, p500: 1 });
    expect(result.cost).toBeCloseTo(2.26);
    expect(result.beads - 1500).toBe(200);
  });

  it("still takes the clearly cheaper pack when the low-waste option costs far more", () => {
    // 2×500 刚好不剩，但 ¥2.00 比 1200 装的 ¥1.26 贵太多
    const result = optimizePacks(1000, "A1");
    expect(result.packs).toEqual({ p4000: 0, p1200: 1, p500: 0 });
    expect(result.cost).toBeCloseTo(1.26);
  });

  it("never uses 500 packs when allow500 is false", () => {
    const result = optimizePacks(400, "P2", 1.26, { allow500: false });
    expect(result.packs).toEqual({ p4000: 0, p1200: 1, p500: 0 });
  });

  it("recognises the A–M scope", () => {
    expect(isAM("A1")).toBe(true);
    expect(isAM("M12")).toBe(true);
    expect(isAM("N1")).toBe(false);
    expect(isAM("ZG2")).toBe(false);
    expect(PURCHASE_OFFERS).toHaveLength(8);
    expect(PURCHASE_OFFERS.every((offer) => offer.confirmed)).toBe(true);
  });
});

describe("purchase plans against the 2026-11-06 54-pattern fixture", () => {
  const plans = buildPurchasePlans(need, demand);
  const byId = Object.fromEntries(plans.map((plan) => [plan.id, plan]));

  it("has six plans sorted by total cost", () => {
    expect(plans).toHaveLength(6);
    for (let i = 1; i < plans.length; i++) expect(plans[i - 1].totalCost).toBeLessThanOrEqual(plans[i].totalCost);
  });

  it("reproduces the 221-set plan cost and bead count", () => {
    const plan = byId["plan-set221-185"];
    expect(plan.coverage).toBe(221);
    expect(plan.missing).toHaveLength(16);
    expect(plan.totalCost).toBeCloseTo(276.96, 2);
    expect(plan.totalBeads).toBe(405_600);
    expect(plan.surplus).toBe(203_730);
    expect(plan.setBeadsTotal).toBe(265_200);
    expect(plan.usableSetBeads).toBe(265_200);
    expect(plan.unusedSetBeads).toBe(0);
    expect(formatPacks(plan.packs)).toBe("32×4000 + 2×1200 + 20×500");
  });

  it("keeps the plan ids stable and the 210 yuan set labelled as the pricey twin", () => {
    expect(Object.keys(byId).sort()).toEqual(["plan-all-singles", "plan-app-current", "plan-set221-185", "plan-set221-210", "plan-set265-257", "plan-set295-352"]);
    expect(byId["plan-set221-210"].note).toContain("高价版");
  });

  it("tags exactly one cheapest / least-waste / recommended plan and keeps waste arithmetic consistent", () => {
    expect(plans.filter((p) => p.cheapest)).toHaveLength(1);
    expect(plans.filter((p) => p.leastWaste)).toHaveLength(1);
    expect(plans.filter((p) => p.recommended)).toHaveLength(1);
    const cheapest = plans.find((p) => p.cheapest)!;
    expect(cheapest.totalCost).toBe(Math.min(...plans.map((p) => p.totalCost)));
    const rec = plans.find((p) => p.recommended)!;
    expect(rec.totalCost).toBeLessThanOrEqual(cheapest.totalCost + Math.max(15, cheapest.totalCost * 0.05) + 1e-6);
    for (const p of plans) {
      expect(p.usefulBeads + p.wasteBeads).toBe(p.totalBeads);
      expect(p.wastePct).toBeCloseTo(p.wasteBeads / p.totalBeads);
      const sum500 = p.packs.p500;
      expect(sum500 === 0 || sum500 >= 10).toBe(true);
    }
  });

  it("reproduces the all-singles plan", () => {
    const plan = byId["plan-all-singles"];
    expect(plan.coverage).toBe(237);
    expect(plan.totalCost).toBeCloseTo(330.12, 2);
    expect(plan.totalBeads).toBe(297_100);
    expect(plan.surplus).toBe(95_230);
    expect(formatPacks(plan.packs)).toBe("32×4000 + 68×1200 + 175×500");
  });

  it("counts unused set colours for 265 and 295", () => {
    const set265 = byId["plan-set265-257"];
    expect(set265.totalCost).toBeCloseTo(340.77, 2);
    expect(set265.totalBeads).toBe(433_200);
    expect(set265.unusedSetBeads).toBe(33_600);
    expect(set265.coverage).toBe(237);

    const set295 = byId["plan-set295-352"];
    expect(set295.totalCost).toBeCloseTo(435.77, 2);
    expect(set295.totalBeads).toBe(469_200);
    expect(set295.unusedSetBeads).toBe(69_600);
  });

  it("reproduces the current 1000-pack plan", () => {
    const plan = byId["plan-app-current"];
    expect(plan.totalCost).toBeCloseTo(383.60, 2);
    expect(plan.totalBeads).toBe(473_600);
    expect(plan.items.reduce((sum, item) => sum + (item.appQty ?? 0), 0)).toBe(371_000);
  });

  it("applies the set plan back to shopping-list quantities", () => {
    const edits = applyPlanToEdits(byId["plan-set221-185"]);
    expect(Object.values(edits).reduce((sum, n) => sum + n, 0)).toBe(405_600);
    expect(edits.H2).toBeGreaterThan(0);
  });
});

function fakePlan(id: string, totalCost: number, wasteBeads: number): PurchasePlan {
  return { id, name: id, totalCost, wasteBeads, totalBeads: 100000, items: [], packs: { p4000: 0, p1200: 0, p500: 0 } } as unknown as PurchasePlan;
}

describe("plan tagging", () => {
  it("recommends the least-waste plan inside the cost window, not the cheapest outright", () => {
    const tagged = tagPlans([fakePlan("cheap", 100, 50_000), fakePlan("near", 110, 10_000), fakePlan("far", 130, 1_000)]);
    const by = Object.fromEntries(tagged.map((p) => [p.id, p]));
    expect(by.cheap.cheapest).toBe(true);
    expect(by.far.leastWaste).toBe(true);
    expect(by.near.recommended).toBe(true);
    expect(by.cheap.recommended).toBe(false);
    expect(by.far.recommended).toBe(false); // 贵出 ¥30 > max(¥15, 5%)
  });

  it("lets one plan hold several tags", () => {
    const tagged = tagPlans([fakePlan("a", 100, 1_000), fakePlan("b", 105, 9_000)]);
    expect(tagged[0]).toMatchObject({ cheapest: true, leastWaste: true, recommended: true });
    expect(tagged[1]).toMatchObject({ cheapest: false, leastWaste: false, recommended: false });
  });

  it("uses a 5% window for expensive baskets", () => {
    const tagged = tagPlans([fakePlan("a", 1000, 9_000), fakePlan("b", 1049, 1_000), fakePlan("c", 1060, 0)]);
    expect(tagged.find((p) => p.recommended)!.id).toBe("b");
  });
});

describe("recommendation preference", () => {
  const set = [fakePlan("cheap", 100, 50_000), fakePlan("near", 110, 10_000), fakePlan("far", 130, 1_000), fakePlan("far2", 130.5, 1_000)];
  it("最省钱 recommends the cheapest plan", () => {
    expect(tagPlans(set, "cheapest").find((p) => p.recommended)!.id).toBe("cheap");
  });
  it("最少剩余 recommends least waste, ties go to the cheaper plan", () => {
    expect(tagPlans(set, "leastWaste").find((p) => p.recommended)!.id).toBe("far");
  });
  it("综合 is the default and unchanged", () => {
    expect(tagPlans(set).find((p) => p.recommended)!.id).toBe("near");
    expect(tagPlans(set, "balanced").find((p) => p.recommended)!.id).toBe("near");
    expect(parsePrefer("nope")).toBe("balanced");
    expect(parsePrefer("leastWaste")).toBe("leastWaste");
  });
  it("buildPurchasePlans follows the preference and keeps exactly one recommended", () => {
    const cheapest = buildPurchasePlans(need, demand, 1.26, "cheapest");
    expect(cheapest.find((p) => p.recommended)!.cheapest).toBe(true);
    const least = buildPurchasePlans(need, demand, 1.26, "leastWaste");
    expect(least.filter((p) => p.recommended)).toHaveLength(1);
    const rec = least.find((p) => p.recommended)!;
    expect(rec.wasteBeads).toBe(Math.min(...least.map((p) => p.wasteBeads)));
  });
  it("words the reason by preference", () => {
    const tagged = tagPlans(set, "leastWaste");
    const text = recommendationReason(tagged, "leastWaste");
    expect(text.startsWith("剩余最少：比最省钱方案贵 ¥30.00，少剩 49,000 颗")).toBe(true);
    expect(recommendationReason(tagPlans(set, "cheapest"), "cheapest")).toContain("最省钱");
  });
  it("splits leftover into unused set colours and rounding", () => {
    const plan = buildPurchasePlans(need, demand).find((p) => p.id === "plan-set265-257")!;
    const b = leftoverBreakdown(plan);
    expect(b.unusedBeads).toBe(33_600);
    expect(b.unusedColors).toBe(28);
    expect(b.unusedBeads + b.roundingBeads).toBe(plan.wasteBeads);
    const singles = leftoverBreakdown(buildPurchasePlans(need, demand).find((p) => p.id === "plan-all-singles")!);
    expect(singles.unusedColors).toBe(0);
    expect(singles.unusedBeads).toBe(0);
  });
});

describe("order snapshot", () => {
  it("keeps positive quantities, merges duplicates, sorts by code", () => {
    const s = makeOrderSnapshot([{ code: "B2", qty: 1200 }, { code: "A1", qty: 500.4 }, { code: "C3", qty: 0 }, { code: "A1", qty: 500 }], { planId: "plan-x", cost: 12.345, now: 1000 });
    expect(s).toEqual({ at: 1000, items: [{ code: "A1", qty: 1000 }, { code: "B2", qty: 1200 }], planId: "plan-x", cost: 12.35 });
    expect(orderSummary(s)).toEqual({ colors: 2, beads: 2200 });
  });
  it("offers a snapshot only while pending and fresh", () => {
    const s = makeOrderSnapshot([{ code: "A1", qty: 100 }], { now: 0 });
    expect(pendingOrder(s)).toBe(s);
    expect(pendingOrder({ ...s, receivedAt: 5 })).toBeNull();
    expect(pendingOrder(makeOrderSnapshot([], { now: 0 }))).toBeNull();
    expect(pendingOrder(undefined)).toBeNull();
    expect(orderIsFresh(s, 59 * 86_400_000)).toBe(true);
    expect(orderIsFresh(s, 60 * 86_400_000)).toBe(false);
  });
  it("stamps updatedAt strictly after the previous value", () => {
    expect(nextStamp(5000, 1000)).toBe(5001);
    expect(nextStamp(100, 1000)).toBe(1000);
  });
});

describe("500-pack minimum", () => {
  const codes = (n: number, qty: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`P${i + 1}`, qty])) as Counts;

  it("drops 500 packs when only a few would be used and re-optimising is cheaper", () => {
    const plan = planAllSingles(codes(3, 400));
    expect(plan.packs.p500).toBe(0);
    expect(plan.packs.p1200).toBe(3);
    expect(plan.totalCost).toBeCloseTo(3.78);
  });

  it("tops up to 10 packs when that is cheaper than switching to 1200", () => {
    const plan = planAllSingles(codes(9, 400));
    expect(plan.packs.p500).toBe(10);
    expect(plan.totalCost).toBeCloseTo(10);
    expect(plan.items.every((item) => item.totalBeads >= item.need)).toBe(true);
    expect(plan.items.reduce((sum, item) => sum + item.packs.p500, 0)).toBe(10);
  });

  it("keeps 500 packs untouched at 10 or more", () => {
    const plan = planAllSingles(codes(10, 400));
    expect(plan.packs.p500).toBe(10);
    expect(plan.totalCost).toBeCloseTo(10);
  });

  it("applies the same rule to Shopping's cost estimate", () => {
    expect(estimateCostForRows([{ code: "P1", qty: 400 }, { code: "P2", qty: 400 }]).packs.p500).toBe(0);
  });
});

describe("supplement list and seller text", () => {
  it("groups by pack size and formats a copyable list", () => {
    const plan = planAllSingles({ A1: 4000, H7: 8000, B3: 1200, C12: 1200 });
    expect(formatPurchaseText(plan)).toBe("4000颗装：A1×1、H7×2\n1200颗装：B3×1、C12×1");
    const groups = groupSupplements(plan);
    expect(groups.map((g) => [g.size, g.packs])).toEqual([["p4000", 3], ["p1200", 2]]);
    expect(groups[0].cost).toBeCloseTo(6.51);
    expect(groups[0].rows[1]).toMatchObject({ code: "H7", packs: 2, bought: 8000, need: 8000, surplus: 0 });
  });

  it("shows the 500 total in its heading", () => {
    const need = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`P${i + 1}`, 400])) as Counts;
    const text = formatPurchaseText(planAllSingles(need));
    expect(text.startsWith("500颗装（共12包）：P1×1、P2×1")).toBe(true);
    expect(text.split("\n")).toHaveLength(1);
  });

  it("says so when nothing needs a supplement", () => {
    expect(formatPurchaseText(planAllSingles({}))).toBe("无需补充包");
  });
});
