import { describe, expect, it } from "vitest";
import { consumeTxns, demandByCode, planReopen, refundTxns, refundedIds, reopenedPattern, stockByCode } from "../lib/inventory";
import { consumeRates, forecastNeeds, normalizePrice1200, price1200Of } from "../lib/forecast";
import type { Pattern, Txn } from "../lib/model";

const NOW = Date.UTC(2026, 10, 16, 12);
function pat(extra: Partial<Pattern> = {}): Pattern {
  return { id: "p1", name: "小熊", kind: "manual", method: "manual", counts: { A1: 100, B2: 40 }, status: "done", copies: 1, tags: [], notes: "", consumed: true, createdAt: 1, updatedAt: 10, ...extra };
}
function buy(code: string, qty: number): Txn {
  return { id: `buy-${code}`, code, delta: qty, kind: "purchase", at: 1, updatedAt: 1 };
}

describe("reopening a finished pattern", () => {
  it("asks only when the pattern was done AND its stock was deducted", () => {
    const p = pat();
    const txns = [buy("A1", 1000), ...consumeTxns(p, "d", 100)];
    expect(planReopen(p, txns).ask).toBe(true);
    expect(planReopen(pat({ consumed: false }), txns).ask).toBe(false);
    expect(planReopen(pat({ status: "making" }), txns).ask).toBe(false);
    expect(planReopen(p, [buy("A1", 1000)]).ask).toBe(false);
  });

  it("refunds exactly what was deducted, including copies, and nets stock back", () => {
    const p = pat({ copies: 3 });
    const txns = [buy("A1", 1000), buy("B2", 1000), ...consumeTxns(p, "d", 100)];
    const plan = planReopen(p, txns);
    expect(plan.beads).toBe(420);
    expect(plan.colors).toBe(2);
    const refunds = refundTxns(plan.originals, p, "计划拼", "d", 200);
    expect(stockByCode([...txns, ...refunds])).toEqual({ A1: 1000, B2: 1000 });
    expect(refunds.every((r) => r.kind === "adjust" && r.delta > 0 && r.refundOf && r.patternId === "p1")).toBe(true);
    expect(refunds[0].note).toContain("小熊");
  });

  it("uses the recorded deductions, not the counts edited after completion", () => {
    const p = pat();
    const txns = [buy("A1", 1000), ...consumeTxns(p, "d", 100)];
    const edited = { ...p, counts: { A1: 7 }, copies: 5 };
    const plan = planReopen(edited, txns);
    expect(plan.originals.map((t) => [t.code, t.delta]).sort()).toEqual([["A1", -100], ["B2", -40]]);
    expect(stockByCode([...txns, ...refundTxns(plan.originals, edited, "制作中", "d", 200)]).A1).toBe(1000);
  });

  it("never refunds twice, and an undone refund can be done again", () => {
    const p = pat();
    const txns = [buy("A1", 1000), ...consumeTxns(p, "d", 100)];
    const refunds = refundTxns(planReopen(p, txns).originals, p, "计划拼", "d", 200);
    const after = [...txns, ...refunds];
    expect(refundedIds(after).size).toBe(2);
    expect(planReopen(p, after).ask).toBe(false);
    // 撤销（软删除）退回记录后，又可以重新退
    const undone = after.map((t) => (t.refundOf ? { ...t, deleted: true } : t));
    expect(planReopen(p, undone).ask).toBe(true);
  });

  it("two devices refunding the same deduction write the same record ids", () => {
    const p = pat();
    const txns = consumeTxns(p, "d", 100);
    const a = refundTxns(planReopen(p, txns).originals, p, "计划拼", "phone", 200);
    const b = refundTxns(planReopen(p, txns).originals, p, "计划拼", "pc", 300);
    expect(a.map((t) => t.id).sort()).toEqual(b.map((t) => t.id).sort());
  });

  it("only the latest completion is refunded; deleted deductions are ignored", () => {
    const p = pat();
    const first = consumeTxns(p, "d", 100);
    const second = consumeTxns(p, "d", 500);
    const plan = planReopen(p, [...first, ...second]);
    expect(plan.originals.every((t) => t.at === 500)).toBe(true);
    expect(planReopen(p, [...first, ...second.map((t) => ({ ...t, deleted: true }))]).originals.every((t) => t.at === 100)).toBe(true);
  });

  it("reopened pattern drops the consumed flag so it counts as demand again", () => {
    const p = pat();
    const r = reopenedPattern(p, "planned", 5);
    expect(r.status).toBe("planned");
    expect(r.consumed).toBe(false);
    expect(r.updatedAt).toBe(11);
    expect(demandByCode([r])).toEqual({ A1: 100, B2: 40 });
    expect(demandByCode([p])).toEqual({});
  });

  it("a refunded deduction no longer counts as everyday usage in the forecast", () => {
    const p = pat();
    const txns: Txn[] = [];
    for (let i = 0; i < 4; i++) txns.push(...consumeTxns({ ...p, id: `q${i}` }, "d", NOW - (i + 1) * 86_400_000));
    expect(consumeRates(txns, NOW).events).toBe(4);
    const mine = txns.filter((t) => t.patternId === "q0");
    const refunds = refundTxns(mine, { ...p, id: "q0" }, "计划拼", "d", NOW);
    expect(consumeRates([...txns, ...refunds], NOW).events).toBe(3);
  });
});

describe("shared 1200-pack price", () => {
  it("only the two offered prices are accepted", () => {
    expect(normalizePrice1200(1.5)).toBe(1.5);
    expect(normalizePrice1200("1.5")).toBe(1.5);
    expect(normalizePrice1200(1.26)).toBe(1.26);
    expect(normalizePrice1200(2)).toBe(1.26);
    expect(normalizePrice1200(undefined)).toBe(1.26);
    expect(price1200Of({ price1200: 1.5 })).toBe(1.5);
    expect(price1200Of({})).toBe(1.26);
    expect(price1200Of(undefined)).toBe(1.26);
  });

  it("the forecast prices packs with the saved price and reports it", () => {
    const patterns = [pat({ status: "planned", consumed: false, counts: { A1: 1200 } })];
    const base = { patterns, txns: [buy("A1", 10)], now: NOW };
    const cheap = forecastNeeds({ ...base, prefs: { lossRate: 0 } });
    const dear = forecastNeeds({ ...base, prefs: { lossRate: 0, price1200: 1.5 } });
    expect(cheap.price1200).toBe(1.26);
    expect(dear.price1200).toBe(1.5);
    expect(dear.totals.cost).toBeGreaterThan(cheap.totals.cost);
    expect(forecastNeeds({ ...base, prefs: { lossRate: 0 }, price1200: 1.5 }).totals.cost).toBe(dear.totals.cost);
  });
});
