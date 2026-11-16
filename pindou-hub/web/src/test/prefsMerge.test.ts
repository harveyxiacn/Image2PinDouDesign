import { describe, expect, it } from "vitest";
import { applyReceipt, editMeta, makeOrder, mergeOrders, readOrders, reconcileOrders, stableStringify, type Order } from "../lib/orders";
import { mergeSellerState, reconcilePrefsRecord, reconcileSellers } from "../lib/prefsMerge";
import { removeSeller, upsertSeller, type Seller } from "../lib/sellers";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const ord = (id: string, qty = 100, now = T0) => makeOrder({ items: [{ code: "A1", qty }], now, id })!;
const seller = (id: string, name: string, updatedAt?: number, extra: Partial<Seller> = {}): Seller => ({ id, name, packs: [{ id: "p1200", beads: 1200, price: 1.2 }], kits: [], shipping: 0, ...(updatedAt ? { updatedAt } : {}), ...extra });
const byId = (xs: Array<{ id: string }>) => [...xs].sort((a, b) => (a.id < b.id ? -1 : 1));
const canon = (v: unknown) => stableStringify(v);

describe("reconcileOrders", () => {
  it("does nothing when nothing differs, even if keys are ordered differently or the field is missing on both", () => {
    const a = ord("a");
    const reordered = JSON.parse(JSON.stringify({ updatedAt: a.updatedAt, status: a.status, items: a.items, at: a.at, id: a.id })) as Order;
    expect(reconcileOrders({ orders: [a] }, [{ orders: [reordered] }], T0)).toBeNull();
    expect(reconcileOrders({}, [{}], T0)).toBeNull();
    expect(reconcileOrders({ orders: [a] }, [], T0)).toBeNull();
  });

  it("brings back orders that the winning record lacks, from either side (commutative)", () => {
    const a = ord("a"), b = ord("b", 50);
    const one = reconcileOrders({ orders: [a] }, [{ orders: [b] }], T0)!;
    const two = reconcileOrders({ orders: [b] }, [{ orders: [a] }], T0)!;
    expect(byId(one).map((o) => o.id)).toEqual(["a", "b"]);
    expect(canon(byId(one))).toBe(canon(byId(two)));
  });

  it("is idempotent and a rewritten record converges in one extra round", () => {
    const base = ord("a", 500);
    const devA = applyReceipt(base, { batchId: "bA", lines: [{ code: "A1", qty: 100 }] }, T0 + 10);
    const devB = editMeta(applyReceipt(base, { batchId: "bB", lines: [{ code: "A1", qty: 50 }] }, T0 + 5), { note: "x" }, T0 + 50);
    const extra = ord("c", 7);
    const A = { orders: [devA, extra] }, B = { orders: [devB] };
    // 设备 A 收到 B 的记录（B 的整条记录更新，胜出）：缺的订单 / 收货补回来
    const rewriteA = reconcileOrders(B, [A], T0 + 100)!;
    expect(rewriteA).not.toBeNull();
    const merged = { orders: rewriteA };
    expect(reconcileOrders(merged, [A, B], T0 + 100)).toBeNull();
    // 对方（B）收到合并后的记录：已经包含 B 自己的一切，不再改写 → 不会来回改
    expect(reconcileOrders(merged, [B], T0 + 100)).toBeNull();
    expect(reconcileOrders(B, [merged], T0 + 100)).not.toBeNull();
    const o = rewriteA.find((x) => x.id === "a")!;
    expect(o.receipts?.map((r) => r.batchId).sort()).toEqual(["bA", "bB"]);
    expect(rewriteA.map((x) => x.id).sort()).toEqual(["a", "c"]);
  });

  it("restores orders for a winner written by an old client that dropped the field, and never rewrites the other way", () => {
    const a = ord("a");
    expect(reconcileOrders({}, [{ orders: [a] }], T0)!.map((o) => o.id)).toEqual(["a"]);
    expect(reconcileOrders({ orders: [a] }, [{}], T0)).toBeNull();
    expect(reconcileOrders({ orders: [a] }, [{ orders: undefined }, undefined], T0)).toBeNull();
  });

  it("an order only the other side kept past the pruning window is not a difference", () => {
    const old = { ...applyReceipt(ord("old", 10), { batchId: "b", lines: [{ code: "A1", qty: 10 }] }, T0 + 5), closedAt: T0 + 5 };
    const now = T0 + 90 * DAY;
    expect(reconcileOrders({ orders: [old] }, [{ orders: [] }], now)).toBeNull();
    // 对方没有它：胜出方保留，不因为时钟差一点来回改写
    expect(reconcileOrders({ orders: [] }, [{ orders: [old] }], now)).toBeNull();
  });

  it("equal updatedAt with different content picks the same winner either way", () => {
    const a = { ...ord("a"), note: "甲" }, b = { ...ord("a"), note: "乙" };
    expect(canon(mergeOrders([a], [b]))).toBe(canon(mergeOrders([b], [a])));
    expect(canon(reconcileOrders({ orders: [a] }, [{ orders: [b] }], T0) ?? readOrders({ orders: [a] }))).toBe(canon(reconcileOrders({ orders: [b] }, [{ orders: [a] }], T0) ?? readOrders({ orders: [b] })));
  });

  it("garbage in the other record is dropped, not copied", () => {
    const a = ord("a");
    expect(reconcileOrders({ orders: [a] }, [{ orders: [null, 5, { id: "" }] }], T0)).toBeNull();
  });
});

describe("mergeSellerState / reconcileSellers", () => {
  it("two devices editing different sellers keep both edits", () => {
    const base = [seller("s1", "甲", 100), seller("s2", "乙", 100)];
    const devA = { sellers: [seller("s1", "甲甲", 200), seller("s2", "乙", 100)] };
    const devB = { sellers: [seller("s1", "甲", 100), seller("s2", "乙乙", 300)] };
    expect(base.length).toBe(2);
    const r1 = reconcileSellers(devB, [devA], T0)!;
    const r2 = reconcileSellers(devA, [devB], T0)!;
    expect(r1.sellers.map((s) => s.name)).toEqual(["甲甲", "乙乙"]);
    expect(canon(r1)).toBe(canon(r2));
    expect(reconcileSellers({ sellers: r1.sellers }, [devA, devB], T0)).toBeNull();
  });

  it("the newer edit of the same seller wins; equal stamps resolve identically from both sides", () => {
    const a = { sellers: [seller("s1", "旧", 100)] }, b = { sellers: [seller("s1", "新", 101)] };
    expect(mergeSellerState([a, b]).sellers[0].name).toBe("新");
    expect(mergeSellerState([b, a]).sellers[0].name).toBe("新");
    const t1 = { sellers: [seller("s1", "甲", 5)] }, t2 = { sellers: [seller("s1", "乙", 5)] };
    expect(canon(mergeSellerState([t1, t2]))).toBe(canon(mergeSellerState([t2, t1])));
  });

  it("a deletion is a tombstone: it beats an older edit and loses to a later one", () => {
    const withS1 = { sellers: [seller("s1", "甲", 100), seller("s2", "乙", 100)] };
    const afterDelete = { ...withS1, ...removeSeller(withS1, "s1", T0) };
    expect(afterDelete.sellers!.map((s) => s.id)).toEqual(["s2"]);
    expect(afterDelete.sellersDeleted).toEqual([{ id: "s1", at: T0 }]);
    // 另一台设备还带着没删的 s1：合并后仍然是已删除
    const r = reconcileSellers(afterDelete, [withS1], T0 + 1000);
    expect(r).toBeNull();
    // 另一台设备的 s1 在删除之后又被编辑过：保留
    const edited = { sellers: [seller("s1", "甲改", T0 + 5000)] };
    const back = reconcileSellers(afterDelete, [edited], T0 + 6000)!;
    expect(back.sellers.map((s) => s.name).sort()).toEqual(["乙", "甲改"]);
    expect(back.tombs).toEqual([]);
    // 反过来：删除的一方是被丢掉整条记录的那一方，也能把删除带过去
    const r2 = reconcileSellers(withS1, [afterDelete], T0 + 1000)!;
    expect(r2.sellers.map((s) => s.id)).toEqual(["s2"]);
    expect(r2.tombs).toEqual([{ id: "s1", at: T0 }]);
  });

  it("removeSeller after a clock skew still deletes (tombstone is later than the seller's stamp)", () => {
    const prefs = { sellers: [seller("s1", "甲", T0 + 99_000)] };
    const p = removeSeller(prefs, "s1", T0);
    expect(p.sellersDeleted![0].at).toBeGreaterThan(T0 + 99_000);
  });

  it("re-adding a deleted seller id clears its tombstone", () => {
    const deleted = { sellers: [] as Seller[], sellersDeleted: [{ id: "s1", at: T0 }] };
    const p = upsertSeller(deleted, seller("s1", "回来了"), T0 + 10);
    expect(p.sellersDeleted).toBeUndefined();
    expect(p.sellers!.map((s) => s.id)).toEqual(["s1"]);
  });

  it("old tombstones are pruned without causing a rewrite; fresh ones are kept", () => {
    const rec = { sellers: [] as Seller[], sellersDeleted: [{ id: "s1", at: T0 }, { id: "s9", at: T0 + 100 * DAY }] };
    const now = T0 + 120 * DAY;
    expect(reconcileSellers(rec, [{ sellers: [] as Seller[], sellersDeleted: [] }], now)).toBeNull();
    // 墓碑只在对方有的时候：补进来；过期的补进来也马上被清理，不算差别
    expect(reconcileSellers({ sellers: [] as Seller[] }, [rec], now)!.tombs).toEqual([{ id: "s9", at: T0 + 100 * DAY }]);
    expect(reconcileSellers({ sellers: [] as Seller[] }, [{ sellers: [] as Seller[], sellersDeleted: [{ id: "s1", at: T0 }] }], now)).toBeNull();
  });

  it("reads records written before per-seller stamps and tombstones existed", () => {
    const legacy = { sellers: [seller("s1", "老卖家"), seller("s2", "老卖家二")] };
    expect(reconcileSellers(legacy, [], T0)).toBeNull();
    const m = reconcileSellers(legacy, [{ sellers: [seller("s2", "新改的", 50), seller("s3", "第三个", 60)] }], T0)!;
    expect(m.sellers.map((s) => s.name)).toEqual(["老卖家", "新改的", "第三个"]);
  });

  it("caps the merged list at the maximum and keeps the newest", () => {
    const many = Array.from({ length: 10 }, (_, i) => seller(`a${String(i).padStart(2, "0")}`, `A${i}`, 100 + i));
    const more = Array.from({ length: 10 }, (_, i) => seller(`b${String(i).padStart(2, "0")}`, `B${i}`, 200 + i));
    const m = mergeSellerState([{ sellers: many }, { sellers: more }]);
    expect(m.sellers).toHaveLength(12);
    expect(m.sellers.filter((s) => s.id.startsWith("b"))).toHaveLength(10);
  });
});

describe("reconcilePrefsRecord", () => {
  it("returns null when orders and sellers agree, keeps sellerId and other fields, rewrites the whole record otherwise", () => {
    const kept = { id: "shared", sellerId: "s2", lowStock: 7, orders: [ord("a")], sellers: [seller("s1", "甲", 10)] };
    expect(reconcilePrefsRecord(kept, [{ ...kept }], T0)).toBeNull();
    const other = { orders: [ord("b")], sellers: [seller("s2", "乙", 20)], sellerId: "s1" };
    const next = reconcilePrefsRecord(kept, [other], T0)!;
    expect(next.sellerId).toBe("s2");
    expect(next.lowStock).toBe(7);
    expect(next.orders!.map((o) => o.id).sort()).toEqual(["a", "b"]);
    expect(next.sellers!.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(reconcilePrefsRecord(next, [kept, other], T0)).toBeNull();
  });
  it("drops the tombstone key when none remain", () => {
    const kept = { sellers: [] as Seller[], sellersDeleted: [{ id: "x", at: T0 }] };
    const next = reconcilePrefsRecord(kept, [{ sellers: [seller("x", "新", T0 + 9)] }], T0 + 10)!;
    expect("sellersDeleted" in next).toBe(false);
    expect(next.sellers!.map((s) => s.id)).toEqual(["x"]);
  });
});
