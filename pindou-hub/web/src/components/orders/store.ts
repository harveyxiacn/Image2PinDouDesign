// 在途订单的读写：订单列表存在共享偏好 prefs.orders 里（没有新的同步集合）。
// 每次修改都先读“此刻最新的”偏好，只改动涉及的订单，再整条写回，缩小两台设备同时改的覆盖范围。
import { getSnapshot, putRecords, softDelete, useData } from "../../lib/db";
import { uid, type SharedPrefs } from "../../lib/model";
import { allocatePrices, parseFen } from "../../lib/pricing";
import { purchaseTxns } from "../../lib/stockview";
import {
  applyReceipt, cancelOrder, liveBatchesFor, makeOrder, orderTitle, pruneOrders, readOrders, recordOrder, reopenOrder, revertReceipt,
  editItems, editMeta, sumCounts, outstandingByCode, transitByCode, type NewOrderInput, type Order
} from "../../lib/orders";
import { deviceId } from "../stock/actions";
import { fmt, toast } from "../ui";
import { useMemo, useState } from "react";

/** 当前订单列表 + 仍然有效的入库批次（给页面渲染用）。 */
export function useOrders(): { orders: Order[]; live: Set<string> } {
  const { prefs, txns } = useData();
  return useMemo(() => {
    const orders = readOrders(prefs);
    return { orders, live: liveBatchesFor(orders, txns) };
  }, [prefs, txns]);
}

const SUBTRACT_KEY = "ph.shop.subtractTransit";

/**
 * 在途订单还欠的数量，和“扣掉在途订单”开关（采购清单、采购方案共用，只影响这台设备的显示）。
 * 开关记在本机 localStorage，不同步；读写失败时本次仍然生效。
 */
export function useTransit() {
  const { orders, live } = useOrders();
  const transit = useMemo(() => transitByCode(orders, live), [orders, live]);
  const [subtract, setSubtract] = useState(() => { try { return localStorage.getItem(SUBTRACT_KEY) !== "0"; } catch { return true; } });
  const pickSubtract = (on: boolean) => { setSubtract(on); try { localStorage.setItem(SUBTRACT_KEY, on ? "1" : "0"); } catch { /* 本次仍然生效 */ } };
  return { orders, live, transit, transitTotal: sumCounts(transit), subtract, pickSubtract };
}

/** 读取最新订单，用 fn 改写，清理后写回偏好。旧版 lastOrder 在这里一并折进 orders（并标记已迁移）。 */
export async function updateOrders(fn: (orders: Order[], live: Set<string>) => Order[], now = Date.now()): Promise<Order[]> {
  const snap = getSnapshot();
  const prefs: SharedPrefs = snap.prefs;
  const current = readOrders(prefs);
  const live = liveBatchesFor(current, snap.txns);
  const next = pruneOrders(fn(current, live), now, live);
  const record: SharedPrefs = { ...prefs, orders: next, updatedAt: Math.max(now, (prefs.updatedAt || 0) + 1) };
  // 旧设备仍会读 lastOrder：折进 orders 之后标成“已入库”，这台设备不会再把它迁移一遍；旧设备只是不再提示它
  if (prefs.lastOrder && !prefs.lastOrder.receivedAt) record.lastOrder = { ...prefs.lastOrder, receivedAt: now };
  await putRecords("prefs", [record]);
  return next;
}

const find = (orders: Order[], id: string) => orders.find((o) => o.id === id);
const mapOne = (id: string, f: (o: Order) => Order) => (orders: Order[]) => orders.map((o) => (o.id === id ? f(o) : o));

/** 复制采购文本后登记订单；撤销 = 取消这张订单。返回订单 id（没有可登记的色号则 undefined）。 */
export async function recordPlacedOrder(input: NewOrderInput): Promise<string | undefined> {
  let id: string | undefined;
  await updateOrders((orders, live) => {
    const r = recordOrder(orders, input, live);
    id = r.order?.id;
    return r.orders;
  });
  return id;
}

export async function addManualOrder(input: NewOrderInput): Promise<string | undefined> {
  const o = makeOrder(input);
  if (!o) return undefined;
  await updateOrders((orders) => [o, ...orders]);
  return o.id;
}

export async function saveOrderEdit(id: string, edit: { items: Array<{ code: string; qty: number; amount?: number }>; seller: string; note: string; cost: number | null }): Promise<void> {
  const now = Date.now();
  await updateOrders(mapOne(id, (o) => { const live = liveBatchesFor([o], getSnapshot().txns); return editMeta(editItems(o, edit.items, now, live), edit, now, live); }), now);
}

export async function cancelOne(id: string, quiet = false): Promise<void> {
  const now = Date.now();
  await updateOrders((orders, live) => mapOne(id, (o) => cancelOrder(o, now, live))(orders), now);
  if (!quiet) toast("订单已取消，没到的货不再算在途", { label: "撤销", run: () => { void reopenOne(id, false); } });
}

export async function reopenOne(id: string, say = true): Promise<void> {
  const now = Date.now();
  await updateOrders((orders, live) => mapOne(id, (o) => reopenOrder(o, now, live))(orders), now);
  if (say) toast("订单已重新打开");
}

export type ReceivePick = { code: string; qty: number; amount?: number };

/**
 * 到货入库：用现有入库路径（purchaseTxns：逐行金额 + 订单总价分摊）写库存流水，
 * 流水批次号记到订单上；撤销会冲掉这批流水并把数量还回订单。
 */
export async function receiveIntoOrder(id: string, picks: ReceivePick[], opts: { note?: string; totalYuan?: number }): Promise<{ txns: number; beads: number; left: number } | null> {
  const snap = getSnapshot();
  const order = find(readOrders(snap.prefs), id);
  if (!order) return null;
  const rows = picks.filter((p) => p.qty > 0).map((p) => ({ code: p.code, qty: Math.round(p.qty), amount: p.amount }));
  if (!rows.length) return null;
  const batchId = uid("b");
  const note = opts.note?.trim() || `订单 ${orderTitle(order)}`;
  const txns = purchaseTxns(rows, { device: deviceId(), note, totalPrice: opts.totalYuan, batchId });
  if (!txns.length) return null;
  const alloc = allocatePrices(rows.map((r) => ({ qty: r.qty, fen: parseFen(r.amount) })), parseFen(opts.totalYuan));
  const paidFen = alloc.fen.reduce((a, b) => a + b, 0);
  await putRecords("txns", txns);
  const now = Date.now();
  await updateOrders((orders) => mapOne(id, (o) => applyReceipt(o, { batchId, lines: rows, paidFen }, now, liveBatchesFor([o], getSnapshot().txns)))(orders), now);
  const after = find(readOrders(getSnapshot().prefs), id);
  const beads = txns.reduce((a, t) => a + t.delta, 0);
  const ids = txns.map((t) => t.id);
  toast(`已入库 ${txns.length} 色 ${fmt(beads)} 颗，已记到订单`, {
    label: "撤销",
    run: () => {
      void (async () => {
        await softDelete("txns", ids);
        await updateOrders((orders) => mapOne(id, (o) => revertReceipt(o, batchId, Date.now(), liveBatchesFor([o], getSnapshot().txns)))(orders));
      })();
    }
  });
  return { txns: txns.length, beads, left: after ? sumCounts(outstandingByCode(after, liveBatchesFor([after], getSnapshot().txns))) : 0 };
}
