import { describe, expect, it } from "vitest";
import fixture from "./purchase-demand.json";
import type { Counts } from "../lib/model";
import {
  PURCHASE_OFFERS, applyPlanToEdits, buildPurchasePlans, formatPacks, isAM, optimizePacks
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

  it("only calls the 185 yuan set the cheapest", () => {
    expect(byId["plan-set221-185"].note).toContain("最省钱");
    expect(byId["plan-set221-210"].note).toContain("高价版");
  });

  it("reproduces the all-singles plan", () => {
    const plan = byId["plan-all-singles"];
    expect(plan.coverage).toBe(237);
    expect(plan.totalCost).toBeCloseTo(328.95, 2);
    expect(plan.totalBeads).toBe(327_000);
    expect(plan.surplus).toBe(125_130);
    expect(formatPacks(plan.packs)).toBe("45×4000 + 55×1200 + 162×500");
  });

  it("counts unused set colours for 265 and 295", () => {
    const set265 = byId["plan-set265-257"];
    expect(set265.totalCost).toBeCloseTo(340.41, 2);
    expect(set265.totalBeads).toBe(442_400);
    expect(set265.unusedSetBeads).toBe(33_600);
    expect(set265.coverage).toBe(237);

    const set295 = byId["plan-set295-352"];
    expect(set295.totalCost).toBeCloseTo(435.41, 2);
    expect(set295.totalBeads).toBe(478_400);
    expect(set295.unusedSetBeads).toBe(69_600);
  });

  it("reproduces the current 1000-pack plan", () => {
    const plan = byId["plan-app-current"];
    expect(plan.totalCost).toBeCloseTo(383.25, 2);
    expect(plan.totalBeads).toBe(475_200);
    expect(plan.items.reduce((sum, item) => sum + (item.appQty ?? 0), 0)).toBe(371_000);
  });

  it("applies the set plan back to shopping-list quantities", () => {
    const edits = applyPlanToEdits(byId["plan-set221-185"]);
    expect(Object.values(edits).reduce((sum, n) => sum + n, 0)).toBe(405_600);
    expect(edits.H2).toBeGreaterThan(0);
  });
});
