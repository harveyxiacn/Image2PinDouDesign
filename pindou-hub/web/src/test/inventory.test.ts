import { describe, expect, it } from "vitest";
import { compareCodes, consumeTxns, demandByCode, readiness, shoppingList, stockByCode, stocktakeTxn } from "../lib/inventory";
import { DEFAULT_PREFS, type Pattern, type Txn } from "../lib/model";
import { sha256Fallback } from "../lib/images";

function txn(code: string, delta: number, extra: Partial<Txn> = {}): Txn {
  return { id: `${code}${delta}${Math.random()}`, code, delta, kind: "purchase", at: 1, updatedAt: 1, ...extra };
}
function pattern(counts: Record<string, number>, extra: Partial<Pattern> = {}): Pattern {
  return { id: "p", name: "测试", kind: "manual", method: "manual", counts, status: "planned", copies: 1, tags: [], notes: "", createdAt: 1, updatedAt: 1, ...extra };
}

describe("inventory ledger", () => {
  it("sums deltas and ignores tombstones", () => {
    const stock = stockByCode([txn("A1", 1000), txn("A1", -120), txn("H7", 500), txn("H7", 500, { deleted: true })]);
    expect(stock).toEqual({ A1: 880, H7: 500 });
  });

  it("demand counts only active, unconsumed patterns, scaled by copies", () => {
    const demand = demandByCode([
      pattern({ A1: 100, H7: 20 }, { copies: 2 }),
      pattern({ A1: 50 }, { status: "idea" }),
      pattern({ A1: 70 }, { status: "making", consumed: true }),
      pattern({ B3: 10 }, { status: "making" })
    ]);
    expect(demand).toEqual({ A1: 200, H7: 40, B3: 10 });
  });

  it("shopping list applies loss rate and rounds to pack size", () => {
    const prefs = { ...DEFAULT_PREFS, lossRate: 0.1, packSize: 1000, lowStock: 0 };
    const rows = shoppingList({ A1: 100 }, { A1: 1000, H7: 50 }, prefs, false);
    const a1 = rows.find((r) => r.code === "A1")!;
    expect(a1.needWithLoss).toBe(1100);
    expect(a1.shortfall).toBe(1000);
    expect(a1.buy).toBe(1000);
    expect(rows.find((r) => r.code === "H7")!.buy).toBe(1000);
  });

  it("shopping list adds low-stock refills after planned use", () => {
    const prefs = { ...DEFAULT_PREFS, lossRate: 0, packSize: 500, lowStock: 200 };
    const rows = shoppingList({ A1: 300, B3: 5000 }, { A1: 200 }, prefs, true);
    expect(rows).toEqual([expect.objectContaining({ code: "A1", reason: "low", buy: 500 })]);
  });

  it("readiness reports makeable copies and missing colors", () => {
    const r = readiness(pattern({ A1: 100, H7: 50 }, { copies: 2 }), { A1: 250, H7: 60 });
    expect(r.makeable).toBe(1);
    expect(r.missing.map((m) => m.code)).toEqual(["H7"]);
    expect(r.coverage).toBeCloseTo((200 + 60) / 300);
  });

  it("consume and stocktake produce balanced ledger entries", () => {
    const txns = consumeTxns(pattern({ A1: 10, H7: 0, B3: 5 }, { copies: 3 }), "dev");
    expect(txns.map((t) => [t.code, t.delta])).toEqual([["A1", -30], ["B3", -15]]);
    expect(new Set(txns.map((t) => t.batchId)).size).toBe(1);
    expect(stocktakeTxn("A1", 950, 1000, "dev")!.delta).toBe(-50);
    expect(stocktakeTxn("A1", 1000, 1000, "dev")).toBeNull();
  });

  it("sorts codes by series then number", () => {
    expect(["H7", "A10", "ZG1", "A2", "M3", "B1"].sort(compareCodes)).toEqual(["A2", "A10", "B1", "H7", "M3", "ZG1"]);
  });
});

describe("sha256 fallback (LAN http pages have no crypto.subtle)", () => {
  it("matches known vectors", () => {
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    expect(hex(sha256Fallback(new TextEncoder().encode("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(sha256Fallback(new TextEncoder().encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const long = new Uint8Array(1000).fill(97);
    expect(hex(sha256Fallback(long))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  });
});
