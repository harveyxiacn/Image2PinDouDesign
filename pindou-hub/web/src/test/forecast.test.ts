import { describe, expect, it } from "vitest";
import type { LastOrder, Pattern, Txn } from "../lib/model";
import { MONTH_MS, consumeRates, forecastCopyText, forecastNeeds, roundToPacks } from "../lib/forecast";
import { packBeads } from "../lib/purchase";
import { applyReceipt, cancelOrder, makeOrder } from "../lib/orders";

const NOW = Date.UTC(2026, 10, 15, 12);
const DAY = 86_400_000;
const prefs = (extra: Record<string, unknown> = {}) => ({ lossRate: 0, ...extra });

function pat(id: string, counts: Record<string, number>, extra: Partial<Pattern> = {}): Pattern {
  return { id, name: id, kind: "manual", method: "manual", counts, status: "planned", copies: 1, tags: [], notes: "", createdAt: 1, updatedAt: 1, ...extra };
}
let seq = 0;
function buy(code: string, qty: number, ago = 100): Txn {
  const at = NOW - ago * DAY;
  return { id: `p${seq++}`, code, delta: qty, kind: "purchase", at, updatedAt: at };
}
function use(code: string, qty: number, agoDays: number, batch = `b${seq++}`): Txn {
  const at = NOW - agoDays * DAY;
  return { id: `c${seq++}`, code, delta: -qty, kind: "consume", batchId: batch, at, updatedAt: at };
}

describe("consumeRates", () => {
  it("is thin with fewer than 3 consume events and gives no rate", () => {
    const r = consumeRates([use("A1", 100, 5), use("A1", 100, 6)], NOW);
    expect(r.thin).toBe(true);
    expect(r.perMonth).toEqual({});
    expect(r.events).toBe(2);
  });
  it("counts events by batch, not by row", () => {
    const rows = [use("A1", 10, 5, "x"), use("A2", 10, 5, "x"), use("A3", 10, 5, "x")];
    expect(consumeRates(rows, NOW).events).toBe(1);
  });
  it("averages over the months since the first record, not over empty months before it", () => {
    // 首条记录 10 天前 → 1 个窗口，三次共 300 颗 → 月均 300
    const r = consumeRates([use("A1", 100, 2), use("A1", 100, 5), use("A1", 100, 10)], NOW);
    expect(r.thin).toBe(false);
    expect(r.months).toBe(1);
    expect(r.perMonth.A1).toBeCloseTo(300);
  });
  it("weights recent months more", () => {
    // 3 个窗口，权重 3/2/1，合计 6。最近 600 颗、中间 0、最早 0 → 600*3/6 = 300；反过来 → 600*1/6 = 100
    const recent = consumeRates([use("A1", 600, 5), use("B1", 1, 40), use("B1", 1, 75)], NOW);
    const old = consumeRates([use("A1", 600, 75), use("B1", 1, 5), use("B1", 1, 40)], NOW);
    expect(recent.months).toBe(3);
    expect(recent.perMonth.A1).toBeCloseTo(300);
    expect(old.perMonth.A1).toBeCloseTo(100);
  });
  it("ignores deleted rows, non-consume rows and anything older than 6 windows", () => {
    const rows = [
      { ...use("A1", 999, 3), deleted: true },
      { ...use("A1", 999, 3), kind: "adjust" as const },
      use("A1", 600, 400), use("A1", 60, 3), use("A1", 60, 4), use("A1", 60, 5)
    ];
    const r = consumeRates(rows, NOW);
    expect(r.months).toBe(6);
    // 只有 3 次 60 在最近窗口：权重 6/21 → 180*6/21
    expect(r.perMonth.A1).toBeCloseTo((180 * 6) / 21);
    expect(MONTH_MS).toBe(30 * DAY);
  });
});

describe("forecastNeeds", () => {
  it("says nothing when inventory was never entered", () => {
    const f = forecastNeeds({ patterns: [pat("a", { A1: 100 })], txns: [], prefs: prefs(), now: NOW });
    expect(f.inventoryReady).toBe(false);
    expect(f.rows).toEqual([]);
  });

  it("thin data: only committed need, no run-out guess, and the basis line says so", () => {
    const txns = [buy("A1", 300), buy("B1", 5000), use("B1", 100, 3)];
    const f = forecastNeeds({ patterns: [pat("a", { A1: 400 })], txns, prefs: prefs(), horizon: 3, now: NOW });
    expect(f.thin).toBe(true);
    expect(f.basis).toContain("消耗记录还少");
    expect(f.rows.map((r) => r.code)).toEqual(["A1"]);
    const a1 = f.rows[0];
    expect(a1.perMonth).toBe(0);
    expect(a1.runOutAt).toBeNull();
    expect(a1.status).toBe("plan");
    expect(a1.wanted).toBe(100);
  });

  it("includes loss rate in committed need and multiplies by copies", () => {
    const f = forecastNeeds({ patterns: [pat("a", { A1: 100 }, { copies: 2 })], txns: [buy("A1", 150)], prefs: prefs({ lossRate: 0.1 }), now: NOW });
    expect(f.rows[0]).toMatchObject({ committed: 220, shortfall: 70, projected: -70, status: "plan" });
  });

  it("ignores done/idea/consumed/deleted patterns", () => {
    const ps = [pat("d", { A1: 500 }, { status: "done" }), pat("i", { A1: 500 }, { status: "idea" }), pat("c", { A1: 500 }, { consumed: true }), pat("x", { A1: 500 }, { deleted: true })];
    const f = forecastNeeds({ patterns: ps, txns: [buy("A1", 10)], prefs: prefs(), now: NOW });
    expect(f.rows).toEqual([]);
  });

  it("subtracts a pending order, and ignores a received one", () => {
    const order: LastOrder = { at: NOW - DAY, items: [{ code: "A1", qty: 600 }] };
    const base = { patterns: [pat("a", { A1: 500 })], txns: [buy("A1", 100)], now: NOW };
    const pending = forecastNeeds({ ...base, prefs: prefs({ lastOrder: order }) });
    expect(pending.rows).toEqual([]); // 100 + 600 ≥ 500
    const partly = forecastNeeds({ ...base, prefs: prefs({ lastOrder: { ...order, items: [{ code: "A1", qty: 200 }] } }) });
    expect(partly.rows[0]).toMatchObject({ incoming: 200, shortfall: 200, wanted: 200 });
    const received = forecastNeeds({ ...base, prefs: prefs({ lastOrder: { ...order, receivedAt: NOW } }) });
    expect(received.rows[0]).toMatchObject({ incoming: 0, shortfall: 400 });
  });

  it("adds up several open orders, skips cancelled / fully received ones, and counts only what is still outstanding", () => {
    const o = (id: string, items: Array<{ code: string; qty: number }>) => makeOrder({ items, now: NOW - DAY, id })!;
    const a = o("a", [{ code: "A1", qty: 100 }]);
    const b = applyReceipt(o("b", [{ code: "A1", qty: 300 }, { code: "B2", qty: 50 }]), { batchId: "bb", lines: [{ code: "A1", qty: 200 }] }, NOW);
    const c = cancelOrder(o("c", [{ code: "A1", qty: 900 }]), NOW);
    const d = applyReceipt(o("d", [{ code: "A1", qty: 70 }]), { batchId: "dd", lines: [{ code: "A1", qty: 70 }] }, NOW);
    const f = forecastNeeds({ patterns: [pat("a", { A1: 600, B2: 80 })], txns: [buy("A1", 0), buy("B2", 10)], prefs: prefs(), orders: [a, b, c, d], now: NOW });
    const a1 = f.rows.find((r) => r.code === "A1")!;
    expect(a1).toMatchObject({ incoming: 200, shortfall: 400 }); // 100 + (300 - 200 已到)
    expect(f.rows.find((r) => r.code === "B2")).toMatchObject({ incoming: 50, shortfall: 20 });
  });

  it("a stock-in that was undone no longer counts as arrived", () => {
    const o = applyReceipt(makeOrder({ items: [{ code: "A1", qty: 300 }], now: NOW - DAY, id: "x" })!, { batchId: "gone", lines: [{ code: "A1", qty: 300 }] }, NOW);
    const input = { patterns: [pat("a", { A1: 300 })], txns: [buy("A1", 0)], prefs: prefs(), orders: [o], now: NOW };
    expect(forecastNeeds(input).rows.find((r) => r.code === "A1")?.incoming ?? 0).toBe(0);
    expect(forecastNeeds({ ...input, liveBatches: new Set<string>() }).rows).toEqual([]); // 在途 300 抵掉需求
  });

  it("reads prefs.orders and a legacy lastOrder together when no orders are passed", () => {
    const o = makeOrder({ items: [{ code: "A1", qty: 100 }], now: NOW - DAY, id: "n1" })!;
    const last: LastOrder = { at: NOW - 2 * DAY, items: [{ code: "A1", qty: 150 }] };
    const f = forecastNeeds({ patterns: [pat("a", { A1: 500 })], txns: [buy("A1", 0)], prefs: prefs({ orders: [o], lastOrder: last }), now: NOW });
    expect(f.rows[0]).toMatchObject({ incoming: 250, shortfall: 250 });
  });

  it("status boundaries: now / plan / soon / ok", () => {
    // 稳定速度：A1 三次共 600 颗，首条记录 20 天前 → 1 个窗口，月均 600
    const hist = [use("Z9", 200, 2), use("Z9", 200, 8), use("Z9", 200, 20)];
    const mk = (stock: number, plan = 0, horizon: 1 | 2 | 3 = 1, code = "Z9") =>
      forecastNeeds({ patterns: plan ? [pat("p", { [code]: plan })] : [], txns: [buy(code, stock + 600), ...hist], prefs: prefs(), horizon, now: NOW }).rows[0];
    expect(mk(0)).toMatchObject({ status: "now", label: "现在就缺" });
    expect(mk(300, 500)).toMatchObject({ status: "plan", label: "拼完计划后不够" });
    // 库存 300、月均 600 → 15 天用完 → 约 2 周
    expect(mk(300)).toMatchObject({ status: "soon", label: "约 2 周后用完" });
    // 库存 600 → 30 天：horizon 1 个月 → 边界内算 soon；库存 601 → 不算
    expect(mk(600)?.status).toBe("soon");
    expect(mk(601)).toBeUndefined();
    // 更长周期会把同一库存也纳入
    expect(mk(1000, 0, 3)?.status).toBe("soon");
    expect(mk(1000, 0, 1)).toBeUndefined();
  });

  it("never flags colours that were never stocked or used, nor idle ones with no rate", () => {
    const hist = [use("Z9", 200, 2), use("Z9", 200, 8), use("Z9", 200, 20)];
    const f = forecastNeeds({ patterns: [], txns: [buy("Z9", 5000), buy("Q1", 0), ...hist], prefs: prefs({ inventoryStartedAt: 1 }), now: NOW });
    expect(f.rows.find((r) => r.code === "Q1")).toBeUndefined();
    expect(f.rows.find((r) => r.code === "ZG9")).toBeUndefined();
    expect(f.okCount).toBeGreaterThan(0);
  });

  it("suggested quantity covers plan + horizon consumption and is rounded into whole packs", () => {
    const hist = [use("H1", 100, 2), use("H1", 100, 8), use("H1", 100, 20)]; // 月均 300
    const f = forecastNeeds({ patterns: [pat("p", { H1: 1000 })], txns: [buy("H1", 400 + 300), ...hist], prefs: prefs(), horizon: 2, now: NOW });
    const r = f.rows[0];
    // 库存 400，计划 1000，两个月 600 → 需要 1000 + 600 − 400 = 1200
    expect(r.wanted).toBe(1200);
    expect(r.buyBeads).toBeGreaterThanOrEqual(1200);
    expect(packBeads(r.packs)).toBe(r.buyBeads);
    expect(f.totals.beads).toBe(r.buyBeads);
    expect(f.totals.cost).toBeGreaterThan(0);
  });

  it("sorts by urgency: now, plan, then soonest run-out", () => {
    const hist = [use("A1", 100, 2), use("A2", 100, 8), use("A3", 100, 20), use("A4", 100, 3)];
    const txns = [buy("A1", 400), buy("A2", 130), buy("A3", 5000), buy("A4", 100), buy("A5", 10), ...hist];
    const f = forecastNeeds({ patterns: [pat("p", { A5: 50 })], txns, prefs: prefs(), horizon: 3, now: NOW });
    expect(f.rows.map((r) => r.status)).toEqual([...f.rows.map((r) => r.status)].sort((a, b) => ["now", "plan", "soon"].indexOf(a) - ["now", "plan", "soon"].indexOf(b)));
    expect(f.rows[0].code).toBe("A4");
  });
});

describe("pack rounding and copy text", () => {
  it("rounds a quantity into real packs with small leftovers", () => {
    // T 系没有 4000 颗装：2400 刚好 2 包 1200，没有剩余
    const [exact] = roundToPacks([{ code: "T1", qty: 2400 }]);
    expect(exact.packs).toEqual({ p4000: 0, p1200: 2, p500: 0 });
    // A–M 色号可用 4000 颗装，按现有优化器取整：够数、包数与颗数自洽
    const [r] = roundToPacks([{ code: "H1", qty: 1300 }]);
    expect(r.beads).toBeGreaterThanOrEqual(1300);
    expect(packBeads(r.packs)).toBe(r.beads);
  });
  it("enforces the 500-pack minimum (never an odd 1–9 pack order)", () => {
    const rows = roundToPacks([{ code: "H1", qty: 200 }]);
    const p500 = rows.reduce((s, r) => s + r.packs.p500, 0);
    expect(p500 === 0 || p500 >= 10).toBe(true);
  });
  it("produces seller-readable text, empty when nothing to buy", () => {
    const hist = [use("H1", 100, 2), use("H1", 100, 8), use("H1", 100, 20)];
    const f = forecastNeeds({ patterns: [pat("p", { H1: 2500 })], txns: [buy("H1", 100), ...hist], prefs: prefs(), horizon: 1, now: NOW });
    const text = forecastCopyText(f);
    expect(text).toContain("补货清单");
    expect(text).toMatch(/\d+颗装/);
    expect(text).toContain("H1×");
    expect(forecastCopyText(forecastNeeds({ patterns: [], txns: [buy("H1", 10)], prefs: prefs(), now: NOW }))).toBe("");
  });
});
