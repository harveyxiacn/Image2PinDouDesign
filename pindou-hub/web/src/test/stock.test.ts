import { describe, expect, it } from "vitest";
import type { Pattern, Txn } from "../lib/model";
import { dayLabel, groupLedger, limitGroups, levelOf, matchesQuery, parseBackup, parseBatchText, purchaseTxns, seriesOf, shareText } from "../lib/stockview";

const known = new Set(["A1", "B3", "H7", "ZG3", "C29"]);
const norm = (s: string) => { const t = s.normalize("NFKC").toUpperCase().replace(/\s+/g, ""); return known.has(t) ? t : null; };

const txn = (p: Partial<Txn> & { id: string }): Txn => ({ code: "A1", delta: 100, kind: "purchase", at: 1_700_000_000_000, updatedAt: 1, ...p });

describe("parseBatchText", () => {
  it("parses mixed separators", () => {
    const r = parseBatchText("A1 1000, B3×500\nH7=2000；zg3 x 30", norm);
    expect(r.rows).toEqual([{ code: "A1", qty: 1000 }, { code: "B3", qty: 500 }, { code: "H7", qty: 2000 }, { code: "ZG3", qty: 30 }]);
    expect(r.errors).toEqual([]);
  });
  it("handles full-width chars, thousands separators and duplicates", () => {
    const r = parseBatchText("Ａ１　１,000、A1*500", norm);
    expect(r.rows).toEqual([{ code: "A1", qty: 1500 }]);
  });
  it("reports unknown codes and dangling tokens", () => {
    const r = parseBatchText("Z99 100, A1", norm);
    expect(r.rows).toEqual([]);
    expect(r.errors).toContain("Z99");
    expect(r.errors).toContain("A1");
  });
});

describe("purchaseTxns", () => {
  it("shares one batchId and spreads total price", () => {
    const t = purchaseTxns([{ code: "A1", qty: 600 }, { code: "B3", qty: 400 }, { code: "H7", qty: 0 }], { device: "d", totalPrice: 10, at: 5 });
    expect(t).toHaveLength(2);
    expect(new Set(t.map((x) => x.batchId)).size).toBe(1);
    expect(t[0].unitPrice).toBeCloseTo(0.01);
    expect(t.every((x) => x.kind === "purchase" && x.at === 5 && x.device === "d")).toBe(true);
  });
});

describe("shareText", () => {
  it("formats list with totals", () => {
    expect(shareText([{ code: "A1", qty: 1000 }, { code: "H7", qty: 2000 }, { code: "B3", qty: 0 }])).toBe("MARD 拼豆采购：A1×1000、H7×2000 共 2 色 3000 颗");
    expect(shareText([])).toContain("无");
  });
});

describe("groupLedger", () => {
  const now = new Date(2026, 10, 4, 12).getTime();
  const day = 86400000;
  const txns = [
    txn({ id: "1", code: "A1", batchId: "b1", at: now - 1000 }),
    txn({ id: "2", code: "B3", batchId: "b1", at: now - 2000, note: "淘宝" }),
    txn({ id: "3", code: "A1", delta: -50, kind: "consume", at: now - 3000 }),
    txn({ id: "4", code: "H7", kind: "stocktake", delta: -3, at: now - day }),
    txn({ id: "5", code: "H7", deleted: true, at: now }),
  ];
  const patterns = [{ id: "p1", name: "猫", createdAt: now - 5000, counts: {} } as unknown as Pattern];

  it("groups by day then batch, skipping deleted", () => {
    const days = groupLedger(txns, patterns, {}, now);
    expect(days.map((d) => d.label)).toEqual(["今天", "昨天"]);
    const today = days[0].groups;
    expect(today).toHaveLength(3);
    const batch = today.find((g) => g.type === "txns" && g.key === "b:b1");
    expect(batch && batch.type === "txns" && batch.txns).toHaveLength(2);
    expect(batch && batch.type === "txns" && batch.note).toBe("淘宝");
    expect(today.some((g) => g.type === "pattern")).toBe(true);
  });
  it("filters by kind and code", () => {
    expect(groupLedger(txns, patterns, { kinds: ["consume"] }, now).flatMap((d) => d.groups)).toHaveLength(1);
    expect(groupLedger(txns, patterns, { kinds: ["pattern"] }, now).flatMap((d) => d.groups)).toHaveLength(1);
    const byCode = groupLedger(txns, patterns, { code: "b3" }, now).flatMap((d) => d.groups);
    expect(byCode).toHaveLength(1);
  });
  it("limits groups across days", () => {
    const days = groupLedger(txns, patterns, {}, now);
    const lim = limitGroups(days, 2);
    expect(lim.shown).toBe(2);
    expect(lim.total).toBe(4);
  });
  it("labels days", () => {
    expect(dayLabel(now - 2 * day, now)).toMatch(/月.*日 周/);
  });
});

describe("misc helpers", () => {
  it("levels, series, search", () => {
    expect(levelOf(0, 200)).toBe("empty");
    expect(levelOf(100, 200)).toBe("low");
    expect(levelOf(300, 200)).toBe("ok");
    expect(seriesOf("ZG3")).toBe("ZG");
    expect(matchesQuery("A1", "浅粉", "粉")).toBe(true);
    expect(matchesQuery("A1", "浅粉", "b")).toBe(false);
  });
  it("parseBackup accepts arrays and wrapped records", () => {
    const rec = { collection: "txns", id: "x", data: { id: "x" }, updatedAt: 1 };
    expect(parseBackup(JSON.stringify([rec]))).toHaveLength(1);
    expect(parseBackup(JSON.stringify({ records: [rec, { bad: 1 }] }))).toHaveLength(1);
    expect(parseBackup("nope")).toBeNull();
  });
});
