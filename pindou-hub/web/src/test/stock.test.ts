import { describe, expect, it } from "vitest";
import type { Pattern, Txn } from "../lib/model";
import { collectionsByTag, excludeForTag, planCandidates, rangeIds, topUsage, withStatus, withTag, dayLabel, groupLedger, limitGroups, levelOf, matchesQuery, parseBackup, parseBatchText, purchaseTxns, seriesOf, shareText } from "../lib/stockview";

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


const pat = (id: string, tags: string[], counts: Record<string, number>, over: Partial<Pattern> = {}): Pattern => ({
  id, name: id, kind: "manual", method: "manual", counts, status: "idea", copies: 1, tags, notes: "", createdAt: 1, updatedAt: 1, ...over
});

describe("collections by tag", () => {
  const ps = [
    pat("a", ["游戏王"], { A1: 1000, B3: 500 }),
    pat("b", ["游戏王", "高达"], { A1: 500 }, { status: "planned", copies: 2 }),
    pat("c", ["高达"], { C29: 300 }, { status: "done" }),
    pat("d", [], { H7: 100 }),
    pat("x", ["游戏王"], { A1: 99999 }, { deleted: true })
  ];
  const stock = { A1: 1200, B3: 100 };
  it("sums beads, colors and shortages per tag", () => {
    const cols = collectionsByTag(ps, stock);
    expect(cols.map((c) => c.tag).sort()).toEqual(["游戏王", "高达"].sort());
    const g = cols.find((c) => c.tag === "游戏王")!;
    expect(g.count).toBe(2);
    expect(g.totalBeads).toBe(1500 + 1000);
    expect(g.colors).toBe(2);
    // A1 需要 1000+1000=2000 > 1200，B3 需要 500 > 100
    expect(g.missingColors).toBe(2);
    expect(g.shortBeads).toBe(800 + 400);
    expect(g.plannedCount).toBe(1);
  });
  it("ignores finished patterns for shortage and can include untagged last", () => {
    const cols = collectionsByTag(ps, stock, true);
    const gd = cols.find((c) => c.tag === "高达")!;
    expect(gd.missingColors).toBe(0); // b 的 A1 够用；c 已完成，缺的 C29 不算
    expect(cols[cols.length - 1].tag).toBe("");
  });
  it("lists plan candidates and tag exclusions", () => {
    expect(planCandidates(ps).map((p) => p.id)).toEqual(["a", "d"]);
    expect([...excludeForTag(ps.filter((p) => !p.deleted), "高达")].sort()).toEqual(["a", "d"]);
    expect(excludeForTag(ps, "").size).toBe(0);
  });
});

describe("topUsage", () => {
  it("ranks by demand, computes shortage and folds the rest", () => {
    const u = topUsage({ A1: 500, B3: 3000, C29: 100, H7: 0 }, { A1: 800, B3: 1000, C29: 50 }, 2);
    expect(u.rows.map((r) => r.code)).toEqual(["B3", "A1"]);
    expect(u.rows[0]).toMatchObject({ need: 3000, have: 1000, short: 2000, covered: 1000 });
    expect(u.rows[1]).toMatchObject({ short: 0, covered: 500 });
    expect(u.rest).toEqual({ codes: 1, need: 100, short: 50 });
    expect(u.max).toBe(3000);
    expect(u.totalCodes).toBe(3);
  });
  it("handles empty demand and negative stock", () => {
    expect(topUsage({}, {}, 5).rows).toHaveLength(0);
    expect(topUsage({ A1: 10 }, { A1: -5 }).rows[0]).toMatchObject({ have: 0, short: 10 });
  });
});

describe("bulk helpers", () => {
  it("withStatus / withTag are idempotent and bump updatedAt", () => {
    const p = pat("a", ["x"], { A1: 1 }, { updatedAt: 10 });
    expect(withStatus(p, "idea")).toBe(p);
    expect(withStatus(p, "planned", 5).updatedAt).toBe(11);
    expect(withTag(p, "x")).toBe(p);
    expect(withTag(p, " y ", 100).tags).toEqual(["x", "y"]);
    expect(withTag(p, "  ")).toBe(p);
  });
  it("rangeIds spans both directions", () => {
    const order = ["a", "b", "c", "d"];
    expect(rangeIds(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeIds(order, "c", "a")).toEqual(["a", "b", "c"]);
    expect(rangeIds(order, "zz", "b")).toEqual(["b"]);
  });
  it("groupLedger can reveal undone batches in place", () => {
    const t1 = txn({ id: "u1", batchId: "bb", deleted: true, at: 1_700_000_100_000 });
    const t2 = txn({ id: "u2", at: 1_700_000_000_000 });
    expect(groupLedger([t1, t2], [], {}, 1_700_000_200_000).flatMap((d) => d.groups)).toHaveLength(1);
    const gs = groupLedger([t1, t2], [], { reveal: new Set(["u1"]) }, 1_700_000_200_000).flatMap((d) => d.groups);
    expect(gs).toHaveLength(2);
    expect(gs[0]).toMatchObject({ type: "txns", undone: true });
  });
});
