import { describe, expect, it } from "vitest";
import {
  applyReceipt, cancelOrder, cleanReceiveLines, editItems, editMeta, isOpen, liveBatchesFor, makeOrder, mergeOrders, migrateLastOrder,
  orderTotals, outstandingByCode, outstandingLines, pruneOrders, readOrders, receiveDefaults, recordOrder, reopenOrder, revertReceipt,
  statusOf, subtractTransit, transitByCode, type Order
} from "../lib/orders";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const mk = (items: Array<{ code: string; qty: number; amount?: number }>, extra: Partial<Parameters<typeof makeOrder>[0]> = {}) => makeOrder({ items, now: T0, id: "o1", ...extra })!;

describe("makeOrder", () => {
  it("merges, rounds, drops empty rows and sorts", () => {
    const o = mk([{ code: "B2", qty: 100 }, { code: "A10", qty: 50.4 }, { code: "A2", qty: 20 }, { code: "A10", qty: 50 }, { code: "Z1", qty: 0 }, { code: "Y1", qty: -5 }]);
    expect(o.items).toEqual([{ code: "A2", qty: 20 }, { code: "A10", qty: 100 }, { code: "B2", qty: 100 }]);
    expect(o.status).toBe("placed");
  });
  it("returns null when nothing is left", () => {
    expect(makeOrder({ items: [{ code: "A1", qty: 0 }], now: T0 })).toBeNull();
  });
  it("keeps optional seller / note / cost only when given", () => {
    const o = mk([{ code: "A1", qty: 10 }], { seller: " 小店 ", note: "", cost: 12.346 });
    expect(o).toMatchObject({ seller: "小店", cost: 12.35 });
    expect("note" in o).toBe(false);
  });
});

describe("partial receive and status", () => {
  const base = mk([{ code: "A1", qty: 500 }, { code: "B2", qty: 300 }]);
  it("starts as placed with everything outstanding", () => {
    expect(statusOf(base)).toBe("placed");
    expect(outstandingByCode(base)).toEqual({ A1: 500, B2: 300 });
  });
  it("partial then complete", () => {
    const p = applyReceipt(base, { batchId: "b1", lines: [{ code: "A1", qty: 200 }] }, T0 + 1000);
    expect(p.status).toBe("partial");
    expect(outstandingByCode(p)).toEqual({ A1: 300, B2: 300 });
    expect(orderTotals(p)).toMatchObject({ beads: 800, leftBeads: 600, gotBeads: 200, leftColors: 2 });
    const q = applyReceipt(p, { batchId: "b2", lines: [{ code: "A1", qty: 300 }, { code: "B2", qty: 300 }] }, T0 + 2000);
    expect(q.status).toBe("received");
    expect(outstandingByCode(q)).toEqual({});
    expect(q.closedAt).toBe(T0 + 2000);
    expect(isOpen(q.status)).toBe(false);
  });
  it("over-delivery clamps outstanding at 0 and is still received", () => {
    const q = applyReceipt(base, { batchId: "b1", lines: [{ code: "A1", qty: 700 }, { code: "B2", qty: 300 }] }, T0 + 1);
    expect(q.status).toBe("received");
    expect(outstandingByCode(q)).toEqual({});
  });
  it("ignores lines for unknown colours and empty receipts", () => {
    expect(cleanReceiveLines(base, [{ code: "Q9", qty: 5 }, { code: "A1", qty: 0 }, { code: "A1", qty: 7.4 }])).toEqual([{ code: "A1", qty: 7 }]);
    expect(applyReceipt(base, { batchId: "b", lines: [{ code: "Q9", qty: 5 }] }, T0 + 1)).toBe(base);
  });
  it("same batch twice is idempotent", () => {
    const a = applyReceipt(base, { batchId: "b1", lines: [{ code: "A1", qty: 100 }] }, T0 + 1);
    const b = applyReceipt(a, { batchId: "b1", lines: [{ code: "A1", qty: 100 }] }, T0 + 2);
    expect(outstandingByCode(b).A1).toBe(400);
  });
  it("undoing the stock-in (batch not live) reopens the quantity", () => {
    const a = applyReceipt(base, { batchId: "b1", lines: [{ code: "A1", qty: 500 }, { code: "B2", qty: 300 }] }, T0 + 1);
    expect(statusOf(a)).toBe("received");
    expect(statusOf(a, new Set())).toBe("placed");
    expect(outstandingByCode(a, new Set())).toEqual({ A1: 500, B2: 300 });
    const r = revertReceipt(a, "b1", T0 + 5);
    expect(r.status).toBe("placed");
    expect(r.closedAt).toBeUndefined();
    expect(r.receipts).toBeUndefined();
  });
  it("liveBatchesFor: only batches whose txns are all deleted are dead; unknown batches stay live", () => {
    const a = applyReceipt(applyReceipt(applyReceipt(base, { batchId: "x", lines: [{ code: "A1", qty: 1 }] }, 1), { batchId: "y", lines: [{ code: "A1", qty: 1 }] }, 2), { batchId: "z", lines: [{ code: "A1", qty: 1 }] }, 3);
    const live = liveBatchesFor([a], [{ batchId: "x", deleted: true }, { batchId: "x", deleted: true }, { batchId: "y", deleted: true }, { batchId: "y" }]);
    expect([...live].sort()).toEqual(["y", "z"]);
  });
});

describe("edit, cancel, reopen", () => {
  const base = mk([{ code: "A1", qty: 500 }, { code: "B2", qty: 300 }]);
  it("edit quantities and add / remove colours", () => {
    const e = editItems(base, [{ code: "A1", qty: 400 }, { code: "C3", qty: 100 }], T0 + 10);
    expect(e.items).toEqual([{ code: "A1", qty: 400 }, { code: "C3", qty: 100 }]);
    expect(e.updatedAt).toBeGreaterThan(base.updatedAt);
  });
  it("cannot go below what already arrived, and arrived colours are never dropped", () => {
    const p = applyReceipt(base, { batchId: "b1", lines: [{ code: "A1", qty: 200 }, { code: "B2", qty: 300 }] }, T0 + 1);
    const e = editItems(p, [{ code: "A1", qty: 50 }], T0 + 2);
    expect(e.items).toEqual([{ code: "A1", qty: 200 }, { code: "B2", qty: 300 }]);
    expect(e.status).toBe("received");
  });
  it("lowering a quantity to what arrived completes the order", () => {
    const p = applyReceipt(base, { batchId: "b1", lines: [{ code: "A1", qty: 200 }] }, T0 + 1);
    const e = editItems(p, [{ code: "A1", qty: 200 }, { code: "B2", qty: 300 }], T0 + 2);
    expect(statusOf(e)).toBe("partial");
    const e2 = editItems(p, [{ code: "A1", qty: 200 }], T0 + 3);
    expect(e2.status).toBe("received");
  });
  it("cancel keeps received stock, stops counting the rest, and can be reopened", () => {
    const p = applyReceipt(base, { batchId: "b1", lines: [{ code: "A1", qty: 200 }] }, T0 + 1);
    const c = cancelOrder(p, T0 + 2);
    expect(c.status).toBe("cancelled");
    expect(transitByCode([c])).toEqual({});
    expect(cancelOrder(c, T0 + 3)).toBe(c);
    const r = reopenOrder(c, T0 + 4);
    expect(r.status).toBe("partial");
    expect(r.cancelledAt).toBeUndefined();
    expect(transitByCode([r])).toEqual({ A1: 300, B2: 300 });
    expect(reopenOrder(r, T0 + 5)).toBe(r);
  });
  it("reopening a cancelled order whose goods all arrived gives received", () => {
    const p = applyReceipt(base, { batchId: "b1", lines: [{ code: "A1", qty: 500 }, { code: "B2", qty: 300 }] }, T0 + 1);
    expect(reopenOrder(cancelOrder(p, T0 + 2), T0 + 3).status).toBe("received");
  });
  it("editMeta sets and clears seller / note / cost", () => {
    const e = editMeta(base, { seller: "店A", note: "顺丰", cost: 30 }, T0 + 1);
    expect(e).toMatchObject({ seller: "店A", note: "顺丰", cost: 30 });
    const f = editMeta(e, { seller: "", cost: null }, T0 + 2);
    expect("seller" in f).toBe(false);
    expect("cost" in f).toBe(false);
    expect(f.note).toBe("顺丰");
  });
  it("outstandingLines lists what is still due", () => {
    const p = applyReceipt(base, { batchId: "b1", lines: [{ code: "A1", qty: 500 }] }, T0 + 1);
    expect(outstandingLines(p)).toEqual([{ code: "B2", qty: 300 }]);
  });
});

describe("transit and subtraction from need", () => {
  it("sums outstanding over open orders only", () => {
    const a = mk([{ code: "A1", qty: 500 }]);
    const b = makeOrder({ items: [{ code: "A1", qty: 200 }, { code: "B2", qty: 100 }], now: T0, id: "o2" })!;
    const c = cancelOrder(makeOrder({ items: [{ code: "A1", qty: 999 }], now: T0, id: "o3" })!, T0 + 1);
    const d = applyReceipt(makeOrder({ items: [{ code: "A1", qty: 50 }], now: T0, id: "o4" })!, { batchId: "bb", lines: [{ code: "A1", qty: 50 }] }, T0 + 1);
    expect(transitByCode([a, b, c, d])).toEqual({ A1: 700, B2: 100 });
  });
  it("subtractTransit never goes negative and reports what was covered", () => {
    const r = subtractTransit({ A1: 500, B2: 100, C3: 80 }, { A1: 700, B2: 40 });
    expect(r.remaining).toEqual({ A1: 0, B2: 60, C3: 80 });
    expect(r.covered).toEqual({ A1: 500, B2: 40 });
    expect(r.coveredTotal).toBe(540);
  });
  it("subtractTransit ignores transit for colours nobody needs", () => {
    expect(subtractTransit({}, { A1: 9 })).toEqual({ remaining: {}, covered: {}, coveredTotal: 0 });
  });
});

describe("migration of prefs.lastOrder", () => {
  const last = { at: T0, items: [{ code: "A1", qty: 100 }, { code: "B2", qty: 50 }], cost: 20, planId: "plan-x" };
  it("pending lastOrder becomes an open order with a stable id", () => {
    const o = migrateLastOrder(last)!;
    expect(o).toMatchObject({ id: `lo-${T0}`, at: T0, status: "placed", cost: 20, planId: "plan-x" });
    expect(migrateLastOrder(last)!.id).toBe(o.id);
    expect(o.items).toEqual([{ code: "A1", qty: 100 }, { code: "B2", qty: 50 }]);
  });
  it("received / empty lastOrder gives nothing", () => {
    expect(migrateLastOrder({ ...last, receivedAt: T0 + 5 })).toBeNull();
    expect(migrateLastOrder({ at: T0, items: [] })).toBeNull();
    expect(migrateLastOrder(undefined)).toBeNull();
  });
  it("readOrders merges stored orders and the legacy one without duplicating", () => {
    const stored = mk([{ code: "Z1", qty: 5 }]);
    expect(readOrders({ orders: [stored], lastOrder: last }).map((o) => o.id)).toEqual([`lo-${T0}`, "o1"]);
    const mig = migrateLastOrder(last)!;
    expect(readOrders({ orders: [mig], lastOrder: last })).toHaveLength(1);
    expect(readOrders({ lastOrder: last })).toHaveLength(1);
    expect(readOrders({})).toEqual([]);
  });
  it("survives garbage from sync", () => {
    expect(readOrders({ orders: [null, 5, { id: "" }, { id: "x" }, { id: "y", items: [{ code: "A1", qty: "30" }], at: "7" }] as unknown[] })).toHaveLength(1);
  });
});

describe("recordOrder (copy action)", () => {
  it("adds a new order, refreshes an identical recent one, adds when different or old", () => {
    const first = recordOrder([], { items: [{ code: "A1", qty: 100 }], now: T0, id: "p1", cost: 10 });
    expect(first.orders).toHaveLength(1);
    const again = recordOrder(first.orders, { items: [{ code: "A1", qty: 100 }], now: T0 + 60_000, cost: 11 });
    expect(again.refreshed).toBe(true);
    expect(again.orders).toHaveLength(1);
    expect(again.orders[0]).toMatchObject({ id: "p1", cost: 11, at: T0 + 60_000 });
    expect(recordOrder(first.orders, { items: [{ code: "A1", qty: 200 }], now: T0 + 60_000 }).orders).toHaveLength(2);
    expect(recordOrder(first.orders, { items: [{ code: "A1", qty: 100 }], now: T0 + 2 * 3_600_000 }).orders).toHaveLength(2);
    expect(recordOrder(first.orders, { items: [], now: T0 }).order).toBeNull();
  });
  it("does not refresh an order that already has a delivery", () => {
    const first = recordOrder([], { items: [{ code: "A1", qty: 100 }], now: T0, id: "p1" }).orders;
    const got = [applyReceipt(first[0], { batchId: "b", lines: [{ code: "A1", qty: 10 }] }, T0 + 1)];
    expect(recordOrder(got, { items: [{ code: "A1", qty: 100 }], now: T0 + 5 }).orders).toHaveLength(2);
  });
});

describe("prune and merge", () => {
  it("keeps every open order and prunes old / excess closed ones", () => {
    const open = mk([{ code: "A1", qty: 5 }], { id: "open" });
    const oldCancelled = cancelOrder(makeOrder({ items: [{ code: "A1", qty: 5 }], now: T0 - 90 * DAY, id: "old" })!, T0 - 60 * DAY);
    const many: Order[] = Array.from({ length: 20 }, (_, i) => cancelOrder(makeOrder({ items: [{ code: "A1", qty: 5 }], now: T0 - i * 1000, id: `c${i}` })!, T0 - i * 1000));
    const out = pruneOrders([open, oldCancelled, ...many], T0);
    expect(out.map((o) => o.id)).toContain("open");
    expect(out.map((o) => o.id)).not.toContain("old");
    expect(out.filter((o) => o.status === "cancelled")).toHaveLength(12);
    expect(out.map((o) => o.id)).toContain("c0");
    expect(out.map((o) => o.id)).not.toContain("c19");
  });
  it("merge: newer updatedAt wins per order, other orders survive from both sides", () => {
    const a1 = mk([{ code: "A1", qty: 5 }], { id: "a" });
    const a2 = editMeta(a1, { note: "新备注" }, T0 + 100);
    const bOnly = makeOrder({ items: [{ code: "B2", qty: 5 }], now: T0, id: "b" })!;
    const m = mergeOrders([a1], [a2, bOnly]);
    expect(m.map((o) => o.id).sort()).toEqual(["a", "b"]);
    expect(m.find((o) => o.id === "a")!.note).toBe("新备注");
    const m2 = mergeOrders([a2], [a1]);
    expect(m2[0].note).toBe("新备注");
  });
  it("merge: receipts from both devices are unioned even when one side loses", () => {
    const base = mk([{ code: "A1", qty: 500 }], { id: "a" });
    const devA = applyReceipt(base, { batchId: "bA", lines: [{ code: "A1", qty: 100 }] }, T0 + 10);
    const devB = editMeta(applyReceipt(base, { batchId: "bB", lines: [{ code: "A1", qty: 50 }] }, T0 + 5), { note: "x" }, T0 + 50);
    const m = mergeOrders([devA], [devB])[0];
    expect(m.receipts?.map((r) => r.batchId).sort()).toEqual(["bA", "bB"]);
    expect(outstandingByCode(m)).toEqual({ A1: 350 });
    expect(m.note).toBe("x");
  });
});

describe("receiveDefaults", () => {
  it("fills outstanding quantities and scales row amounts", () => {
    const o = mk([{ code: "A1", qty: 500, amount: 10 }, { code: "B2", qty: 300 }]);
    const p = applyReceipt(o, { batchId: "b", lines: [{ code: "A1", qty: 250 }] }, T0 + 1);
    const d = receiveDefaults(p);
    expect(d.rows).toEqual([{ code: "A1", qty: 250, amount: 5 }, { code: "B2", qty: 300 }]);
    expect(d.totalYuan).toBeUndefined();
  });
  it("offers the expected cost as total only for a first, complete receive without row amounts", () => {
    const o = mk([{ code: "A1", qty: 500 }], { cost: 18.5 });
    expect(receiveDefaults(o).totalYuan).toBe(18.5);
    const p = applyReceipt(o, { batchId: "b", lines: [{ code: "A1", qty: 100 }] }, T0 + 1);
    expect(receiveDefaults(p).totalYuan).toBeUndefined();
  });
});
