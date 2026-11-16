import { describe, expect, it } from "vitest";
import { allocatePrices, parseFen, perThousandText, toFen, unitFromFen, yuanText } from "../lib/pricing";
import { parseBatchText, purchaseTxns, repriceTxns } from "../lib/stockview";

const known = new Set(["A1", "A12", "B3", "H7"]);
const norm = (s: string) => { const t = s.normalize("NFKC").toUpperCase().replace(/\s+/g, ""); return known.has(t) ? t : null; };

describe("money helpers", () => {
  it("converts without float drift", () => {
    expect(toFen(1.26)).toBe(126);
    expect(toFen(0.29)).toBe(29);
    expect(toFen(1.005)).toBe(101);
    expect(parseFen("")).toBeUndefined();
    expect(parseFen("0")).toBeUndefined();
    expect(parseFen("-3")).toBeUndefined();
    expect(parseFen("abc")).toBeUndefined();
    expect(parseFen("12.5")).toBe(1250);
    expect(yuanText(126)).toBe("¥1.26");
    expect(yuanText(5)).toBe("¥0.05");
    expect(yuanText(-250)).toBe("−¥2.50");
  });
  it("derives per-bead and per-thousand figures", () => {
    expect(unitFromFen(126, 1200)! * 1200).toBeCloseTo(1.26, 10);
    expect(unitFromFen(0, 100)).toBeUndefined();
    expect(perThousandText(126, 1200)).toBe("约 ¥1.05/千颗");
    expect(perThousandText(217, 4000)).toBe("约 ¥0.54/千颗");
    expect(perThousandText(100, 0)).toBeUndefined();
  });
});

describe("allocatePrices", () => {
  it("no prices at all", () => {
    const a = allocatePrices([{ qty: 100 }, { qty: 200 }]);
    expect(a.fen).toEqual([0, 0]);
    expect(a.status).toBe("none");
  });
  it("keeps own amounts without a total", () => {
    const a = allocatePrices([{ qty: 1200, fen: 126 }, { qty: 500 }]);
    expect(a.fen).toEqual([126, 0]);
    expect(a.status).toBe("ok");
  });
  it("splits a plain total by bead count and sums exactly", () => {
    const a = allocatePrices([{ qty: 1 }, { qty: 1 }, { qty: 1 }], 100);
    expect(a.fen.reduce((x, y) => x + y, 0)).toBe(100);
    expect(a.fen).toEqual([34, 33, 33]);
    const b = allocatePrices([{ qty: 600 }, { qty: 400 }], 1000);
    expect(b.fen).toEqual([600, 400]);
  });
  it("spreads the remainder over rows without their own amount", () => {
    const a = allocatePrices([{ qty: 1200, fen: 126 }, { qty: 500 }, { qty: 1500 }], 1000);
    expect(a.fen[0]).toBe(126);
    expect(a.remainderFen).toBe(874);
    expect(a.fen[1] + a.fen[2]).toBe(874);
    expect(a.fen[1]).toBe(Math.round((874 * 500) / 2000));
    expect(a.fen.reduce((x, y) => x + y, 0)).toBe(1000);
    expect(a.status).toBe("ok");
  });
  it("negative remainder: warns and leaves free rows unpriced", () => {
    const a = allocatePrices([{ qty: 1200, fen: 800 }, { qty: 500 }], 500);
    expect(a.status).toBe("over");
    expect(a.gapFen).toBe(300);
    expect(a.fen).toEqual([800, 0]);
  });
  it("total larger than all own amounts with no free row: leftover", () => {
    const a = allocatePrices([{ qty: 10, fen: 100 }], 250);
    expect(a.status).toBe("leftover");
    expect(a.gapFen).toBe(150);
    expect(a.fen).toEqual([100]);
  });
  it("ignores zero-quantity rows", () => {
    const a = allocatePrices([{ qty: 0, fen: 500 }, { qty: 10 }], 300);
    expect(a.fen).toEqual([0, 300]);
  });
  it("sum invariant over many shapes", () => {
    for (let n = 1; n < 9; n++) {
      const rows = Array.from({ length: n }, (_, i) => ({ qty: 137 * (i + 1) + 11 }));
      const a = allocatePrices(rows, 12345 + n);
      expect(a.fen.reduce((x, y) => x + y, 0)).toBe(12345 + n);
    }
  });
});

describe("per-line price in pasted text", () => {
  it("reads ¥ prefix and 元 suffix, keeping old formats", () => {
    const r = parseBatchText("A1 1200 ¥1.26, B3×500 1元\nH7 2000", norm);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([{ code: "A1", qty: 1200, amount: 1.26 }, { code: "B3", qty: 500, amount: 1 }, { code: "H7", qty: 2000 }]);
  });
  it("does not read A12 as A1×2 and sums repeated prices", () => {
    const r = parseBatchText("A12 100 ¥2, A12 50 ¥1", norm);
    expect(r.rows).toEqual([{ code: "A12", qty: 150, amount: 3 }]);
  });
  it("a bare number after the quantity is not a price", () => {
    const r = parseBatchText("A1 100 B3 200", norm);
    expect(r.rows).toEqual([{ code: "A1", qty: 100 }, { code: "B3", qty: 200 }]);
  });
});

describe("purchaseTxns with row amounts", () => {
  it("per-row amount + total remainder", () => {
    const t = purchaseTxns([{ code: "A1", qty: 1200, amount: 1.26 }, { code: "B3", qty: 500 }, { code: "H7", qty: 1500 }], { device: "d", totalPrice: 10, at: 1 });
    const money = t.map((x) => Math.round((x.unitPrice ?? 0) * x.delta * 100));
    expect(money[0]).toBe(126);
    expect(money.reduce((a, b) => a + b, 0)).toBe(1000);
  });
  it("amount only, no total", () => {
    const t = purchaseTxns([{ code: "A1", qty: 1200, amount: 1.26 }, { code: "B3", qty: 500 }], { device: "d", at: 1 });
    expect(t[0].unitPrice! * 1200).toBeCloseTo(1.26, 8);
    expect(t[1].unitPrice).toBeUndefined();
  });
});

describe("repriceTxns", () => {
  const mk = (id: string, delta: number, unitPrice?: number) => ({ id, code: "A1", delta, kind: "purchase" as const, unitPrice, at: 1, updatedAt: 5 });
  it("adds a total to a batch without price, summing exactly", () => {
    const out = repriceTxns([mk("a", 1200), mk("b", 500), mk("c", 777)], 1234, 100);
    expect(out.reduce((a, t) => a + Math.round(t.unitPrice! * t.delta * 100), 0)).toBe(1234);
    expect(out.every((t) => t.updatedAt >= 100)).toBe(true);
  });
  it("clears prices when no total is given", () => {
    const out = repriceTxns([mk("a", 100, 0.01)], undefined, 100);
    expect(out[0].unitPrice).toBeUndefined();
  });
  it("leaves non-purchase rows out", () => {
    const out = repriceTxns([mk("a", 100), { ...mk("b", -5), kind: "adjust" as const }], 500, 100);
    expect(out.map((t) => t.id)).toEqual(["a"]);
  });
});
