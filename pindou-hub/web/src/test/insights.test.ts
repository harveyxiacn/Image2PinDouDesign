import { describe, expect, it } from "vitest";
import type { Pattern, Txn } from "../lib/model";
import { demandRanking, familyBreakdown, monthlyActivity, readiness, recognitionQuality, stockHealth, substitutes } from "../lib/insights";

function pat(id: string, counts: Record<string, number>, extra: Partial<Pattern> = {}): Pattern {
  return { id, name: id, kind: "manual", method: "manual", counts, status: "planned", copies: 1, tags: [], notes: "", createdAt: 1, updatedAt: 1, ...extra };
}
function txn(code: string, delta: number, at: number, extra: Partial<Txn> = {}): Txn {
  return { id: `${code}${at}${delta}`, code, delta, kind: delta > 0 ? "purchase" : "consume", at, updatedAt: at, ...extra };
}

describe("readiness", () => {
  it("sorts most ready first and counts missing", () => {
    const stock = { A1: 100, A2: 10 };
    const rows = readiness([pat("far", { A1: 100, B1: 100 }), pat("ready", { A1: 50 }), pat("near", { A1: 50, A2: 20 })], stock, 0);
    expect(rows.map((r) => r.id)).toEqual(["ready", "near", "far"]);
    expect(rows[0]).toMatchObject({ complete: true, coverage: 1, missingColors: 0 });
    expect(rows[1]).toMatchObject({ missingColors: 1, missingBeads: 10, covered: 60, needed: 70 });
    expect(rows[2].missing[0].code).toBe("B1");
  });
  it("handles no stock, zero-count patterns and inactive ones", () => {
    const rows = readiness([pat("a", { A1: 10 }), pat("zero", { A1: 0 }), pat("empty", {}), pat("done", { A1: 5 }, { status: "done" })], {}, 0);
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(rows[0].coverage).toBe(0);
    expect(rows[0].missingBeads).toBe(10);
  });
  it("multiplies by copies and applies loss", () => {
    const [r] = readiness([pat("c", { A1: 100 }, { copies: 2 })], { A1: 200 }, 0.05);
    expect(r.needed).toBe(210);
    expect(r.missingBeads).toBe(10);
  });
  it("ignores negative stock", () => {
    const [r] = readiness([pat("a", { A1: 10 })], { A1: -5 }, 0);
    expect(r.covered).toBe(0);
  });
});

describe("substitutes", () => {
  it("never suggests itself and labels by deltaE", () => {
    const stock = { A1: 5000, A2: 5000, H7: 5000 };
    const s = substitutes("A1", stock);
    expect(s.find((x) => x.code === "A1")).toBeUndefined();
    for (const x of s) {
      expect(x.deltaE).toBeLessThanOrEqual(6);
      expect(x.label).toBe(x.deltaE <= 2 ? "几乎一样" : x.deltaE <= 4 ? "很接近" : "可替代");
    }
    expect(s.length).toBeLessThanOrEqual(3);
  });
  it("requires enough beads and respects limit", () => {
    const stock: Record<string, number> = { A2: 10, A3: 10, A4: 10, A5: 10, A6: 10 };
    const all = substitutes("A1", stock, { need: 1, limit: 99 });
    expect(all.length).toBeGreaterThan(0);
    expect(substitutes("A1", stock, { need: 11 })).toEqual([]);
    expect(substitutes("A1", stock, { need: 1, limit: 1 }).length).toBeLessThanOrEqual(1);
    const sorted = [...all].sort((a, b) => a.deltaE - b.deltaE);
    expect(all.map((x) => x.code)).toEqual(sorted.map((x) => x.code));
  });
  it("returns nothing for unknown codes or far colours", () => {
    expect(substitutes("NOPE", { A1: 100 })).toEqual([]);
    expect(substitutes("A1", { A1: 100 })).toEqual([]);
  });
});

describe("demandRanking", () => {
  it("orders by gap then need then code order", () => {
    const rows = demandRanking([pat("p", { A10: 100, A2: 100, B1: 100, C1: 50 })], { C1: 0 });
    expect(rows.map((r) => r.code)).toEqual(["A2", "A10", "B1", "C1"]);
  });
  it("computes gap, pattern count and limit", () => {
    const rows = demandRanking([pat("p", { A1: 100 }), pat("q", { A1: 50 }, { copies: 2 })], { A1: 120 }, { limit: 1, lossRate: 0 });
    expect(rows).toEqual([{ code: "A1", demand: 200, need: 200, stock: 120, gap: 80, patterns: 2 }]);
  });
});

describe("familyBreakdown", () => {
  it("groups by leading letters", () => {
    const rows = familyBreakdown([pat("p", { A1: 10, A2: 10, H7: 5, ZG1: 3 })], { A1: 4, B3: 7 }, 0);
    expect(rows.map((r) => r.family)).toEqual(["A", "B", "H", "ZG"]);
    expect(rows[0]).toMatchObject({ demand: 20, stock: 4, gap: 16, colors: 2 });
    expect(rows[1]).toMatchObject({ demand: 0, stock: 7 });
  });
});

describe("stockHealth", () => {
  it("buckets enough / tight / idle", () => {
    const h = stockHealth({ A1: 500, A2: 50, B1: 3200, C1: 0 }, { A1: 400, A2: 100, C1: 10 }, { lossRate: 0 });
    expect(h.enough).toEqual({ colors: 1, beads: 500 });
    expect(h.tight).toEqual({ colors: 2, beads: 50 });
    expect(h.idle).toEqual({ colors: 1, beads: 3200 });
    expect(h.idleList).toEqual([{ code: "B1", beads: 3200 }]);
  });
  it("loss rate can tip a colour into tight", () => {
    expect(stockHealth({ A1: 100 }, { A1: 100 }, { lossRate: 0.05 }).tight.colors).toBe(1);
  });
});

describe("monthlyActivity", () => {
  it("buckets by local month across a year boundary and fills empty months", () => {
    const now = new Date(2026, 1, 15).getTime();
    const dec = new Date(2025, 11, 31, 23, 30).getTime();
    const jan = new Date(2026, 0, 1, 0, 30).getTime();
    const a = monthlyActivity([
      txn("A1", 1000, dec, { unitPrice: 0.05 }), txn("A1", -200, jan, { patternId: "p1" }), txn("A2", -100, jan, { patternId: "p1" }),
      txn("A1", -50, jan, { patternId: "p2" }), txn("A1", 10, jan, { kind: "adjust" }), txn("A1", 500, jan, { deleted: true })
    ], { months: 4, now });
    expect(a.months.map((m) => m.key)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(a.months[1]).toMatchObject({ purchased: 1000, consumed: 0, spent: 50 });
    expect(a.months[2]).toMatchObject({ purchased: 0, consumed: 350, completed: 2 });
    expect(a.months[0].purchased).toBe(0);
    expect(a.hasPrice).toBe(true);
    expect(a.totalSpent).toBe(50);
  });
  it("reports empty", () => {
    const a = monthlyActivity([], { months: 3, now: Date.now() });
    expect(a.hasTxns).toBe(false);
    expect(a.months).toHaveLength(3);
  });
});

describe("recognitionQuality", () => {
  it("counts verified and confidence buckets", () => {
    const q = recognitionQuality([
      pat("a", {}, { verifiedAt: 1, confidence: 0.95 }), pat("b", {}, { confidence: 0.6 }), pat("c", {}, { status: "idea" }),
      pat("d", {}, { deleted: true, confidence: 0.1 })
    ]);
    expect(q).toMatchObject({ total: 3, verified: 1, unverified: 2, activeUnverified: 1, noConfidence: 1 });
    expect(q.buckets.map((b) => b.count)).toEqual([0, 1, 0, 1]);
  });
});
