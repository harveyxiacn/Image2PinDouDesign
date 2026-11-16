// 在途订单的纯逻辑：不碰存储、不依赖 React，页面和测试共用。
// 存放位置：共享偏好里的 prefs.orders（随偏好同步，没有新增同步集合）。
// 每张订单带自己的 updatedAt，跨设备合并按“每张订单后写者胜”（见 mergeOrders），收货记录取并集。
// 旧版本的 prefs.lastOrder 读取时折成一张订单（id = lo-<下单时间>），见 migrateLastOrder / readOrders。
import type { Counts, LastOrder } from "./model";

export type OrderStatus = "placed" | "partial" | "received" | "cancelled";

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  placed: "已下单",
  partial: "部分到货",
  received: "已到货",
  cancelled: "已取消"
};

export type OrderItem = {
  code: string;
  qty: number;
  /** 这一行的预计金额（元，选填） */
  amount?: number;
};

/** 一次到货入库：对应库存流水里的一个 batchId。撤销入库后这条记录自动不再计数（见 live 参数）。 */
export type OrderReceipt = {
  batchId: string;
  at: number;
  lines: Array<{ code: string; qty: number }>;
  /** 这次实付（分，选填，仅用于显示） */
  paidFen?: number;
};

export type Order = {
  id: string;
  /** 下单时间 */
  at: number;
  seller?: string;
  note?: string;
  items: OrderItem[];
  /** 预计总价（元） */
  cost?: number;
  planId?: string;
  /** 存下来的状态，读取时一律用 statusOf 重新算 */
  status: OrderStatus;
  receipts?: OrderReceipt[];
  cancelledAt?: number;
  /** 变成已到货 / 已取消的时间，用来清理旧订单 */
  closedAt?: number;
  updatedAt: number;
};

/** live：仍然有效（没被撤销）的入库批次；不传表示全部有效。 */
export type LiveBatches = ReadonlySet<string> | undefined;

const DAY = 86_400_000;
/** 已到货 / 已取消的订单保留多少天，以及最多保留几张。 */
export const CLOSED_KEEP_DAYS = 30;
export const CLOSED_KEEP_MAX = 12;
/** 复制采购文本后，这么久之内再复制同样的清单算同一张订单。 */
export const DEDUPE_WINDOW_MS = 60 * 60_000;
/** 下单多久还没到就提醒一下。 */
export const STALE_DAYS = 30;

function cmpCode(a: string, b: string): number {
  const ma = /^([A-Za-z]+)(\d+)/.exec(a);
  const mb = /^([A-Za-z]+)(\d+)/.exec(b);
  if (ma && mb) return ma[1] === mb[1] ? Number(ma[2]) - Number(mb[2]) : ma[1] < mb[1] ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function cleanQty(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? Math.round(v) : 0;
}

/** 合并同色号、取整、去掉数量 ≤ 0 的行、按色号排序。 */
export function cleanItems(items: Array<{ code: string; qty: number; amount?: number }>): OrderItem[] {
  const merged = new Map<string, OrderItem>();
  for (const it of items ?? []) {
    const code = typeof it?.code === "string" ? it.code.trim() : "";
    const qty = cleanQty(it?.qty);
    if (!code || qty <= 0) continue;
    const cur = merged.get(code);
    const amount = typeof it.amount === "number" && Number.isFinite(it.amount) && it.amount > 0 ? Math.round(it.amount * 100) / 100 : undefined;
    if (cur) {
      cur.qty += qty;
      if (amount !== undefined) cur.amount = Math.round(((cur.amount ?? 0) + amount) * 100) / 100;
    } else merged.set(code, amount !== undefined ? { code, qty, amount } : { code, qty });
  }
  return [...merged.values()].sort((a, b) => cmpCode(a.code, b.code));
}

// ---------- 收货 / 欠货 ----------

function liveReceipts(order: Order, live: LiveBatches): OrderReceipt[] {
  return (order.receipts ?? []).filter((r) => !live || live.has(r.batchId));
}

/** 每个色号已经到了多少。 */
export function receivedByCode(order: Order, live?: LiveBatches): Counts {
  const out: Counts = {};
  for (const r of liveReceipts(order, live)) for (const l of r.lines) if (l.qty > 0) out[l.code] = (out[l.code] ?? 0) + l.qty;
  return out;
}

/** 每个色号还欠多少（> 0 的才出现）。已取消的订单也会算出“如果没取消还欠多少”，是否计入在途由 isOpen 决定。 */
export function outstandingByCode(order: Order, live?: LiveBatches): Counts {
  const got = receivedByCode(order, live);
  const out: Counts = {};
  for (const it of order.items) {
    const left = it.qty - (got[it.code] ?? 0);
    if (left > 0) out[it.code] = left;
  }
  return out;
}

export function sumCounts(c: Counts): number {
  let s = 0;
  for (const v of Object.values(c)) if (v > 0) s += v;
  return s;
}

export function statusOf(order: Order, live?: LiveBatches): OrderStatus {
  if (order.cancelledAt !== undefined) return "cancelled";
  const left = sumCounts(outstandingByCode(order, live));
  if (left <= 0) return "received";
  return sumCounts(receivedByCode(order, live)) > 0 ? "partial" : "placed";
}

/** 还在路上（已下单 / 部分到货）。 */
export function isOpen(status: OrderStatus): boolean {
  return status === "placed" || status === "partial";
}

export type OrderTotals = { colors: number; beads: number; leftColors: number; leftBeads: number; gotBeads: number };
export function orderTotals(order: Order, live?: LiveBatches): OrderTotals {
  const left = outstandingByCode(order, live);
  const got = receivedByCode(order, live);
  return {
    colors: order.items.length,
    beads: order.items.reduce((a, i) => a + i.qty, 0),
    leftColors: Object.keys(left).length,
    leftBeads: sumCounts(left),
    gotBeads: order.items.reduce((a, i) => a + Math.min(i.qty, got[i.code] ?? 0), 0)
  };
}

/** 下单多少天了。 */
export function ageDays(order: Order, now: number): number {
  return Math.max(0, Math.floor((now - order.at) / DAY));
}

// ---------- 创建 / 状态流转（都返回新对象，不改入参） ----------

function stamp(prev: number, now: number): number {
  return Math.max(now, (Number.isFinite(prev) ? prev : 0) + 1);
}

function restamp(order: Order, now: number, live?: LiveBatches): Order {
  const next: Order = { ...order, updatedAt: stamp(order.updatedAt, now) };
  next.status = statusOf(next, live);
  if (next.status === "received" || next.status === "cancelled") next.closedAt = next.closedAt ?? now;
  else delete next.closedAt;
  return next;
}

export type NewOrderInput = {
  items: Array<{ code: string; qty: number; amount?: number }>;
  now?: number;
  id?: string;
  seller?: string;
  note?: string;
  cost?: number;
  planId?: string;
};

let idSeq = 0;
function newId(now: number): string {
  idSeq += 1;
  return `o-${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}${idSeq.toString(36)}`;
}

/** 新订单；没有数量 > 0 的色号返回 null。 */
export function makeOrder(input: NewOrderInput): Order | null {
  const now = input.now ?? Date.now();
  const items = cleanItems(input.items);
  if (!items.length) return null;
  const order: Order = { id: input.id ?? newId(now), at: now, items, status: "placed", updatedAt: now };
  const seller = input.seller?.trim();
  const note = input.note?.trim();
  if (seller) order.seller = seller;
  if (note) order.note = note;
  if (input.cost !== undefined && Number.isFinite(input.cost) && input.cost > 0) order.cost = Math.round(input.cost * 100) / 100;
  if (input.planId) order.planId = input.planId;
  return order;
}

function signature(items: OrderItem[]): string {
  return items.map((i) => `${i.code}:${i.qty}`).join(",");
}

/**
 * 复制采购文本时登记订单：1 小时内、没有任何到货的同样清单只刷新那一张，不重复登记。
 * 返回新列表和这张订单。
 */
export function recordOrder(orders: Order[], input: NewOrderInput, live?: LiveBatches): { orders: Order[]; order: Order | null; refreshed: boolean } {
  const fresh = makeOrder(input);
  if (!fresh) return { orders, order: null, refreshed: false };
  const sig = signature(fresh.items);
  const dup = orders.find((o) => statusOf(o, live) === "placed" && !(o.receipts?.length) && Math.abs(fresh.at - o.at) < DEDUPE_WINDOW_MS && signature(o.items) === sig);
  if (!dup) return { orders: [fresh, ...orders], order: fresh, refreshed: false };
  const merged: Order = { ...dup, at: fresh.at, updatedAt: stamp(dup.updatedAt, fresh.at) };
  if (fresh.cost !== undefined) merged.cost = fresh.cost;
  if (fresh.planId) merged.planId = fresh.planId;
  return { orders: orders.map((o) => (o.id === dup.id ? merged : o)), order: merged, refreshed: true };
}

export type ReceiveLine = { code: string; qty: number };

/** 只保留订单里有的色号、数量 > 0 的行（可以超过还欠的数量：多寄的豆子照实入库）。 */
export function cleanReceiveLines(order: Order, lines: ReceiveLine[]): ReceiveLine[] {
  const known = new Set(order.items.map((i) => i.code));
  const merged = new Map<string, number>();
  for (const l of lines) {
    const qty = cleanQty(l.qty);
    if (qty > 0 && known.has(l.code)) merged.set(l.code, (merged.get(l.code) ?? 0) + qty);
  }
  return [...merged].map(([code, qty]) => ({ code, qty })).sort((a, b) => cmpCode(a.code, b.code));
}

/** 记一次到货：没有有效行则原样返回。 */
export function applyReceipt(order: Order, receipt: { batchId: string; lines: ReceiveLine[]; paidFen?: number }, now: number, live?: LiveBatches): Order {
  const lines = cleanReceiveLines(order, receipt.lines);
  if (!lines.length) return order;
  const rec: OrderReceipt = { batchId: receipt.batchId, at: now, lines };
  if (receipt.paidFen && receipt.paidFen > 0) rec.paidFen = receipt.paidFen;
  // 同一批次重复记录时覆盖，保证幂等
  const receipts = [...(order.receipts ?? []).filter((r) => r.batchId !== receipt.batchId), rec];
  const liveWith = live ? new Set([...live, receipt.batchId]) : undefined;
  return restamp({ ...order, receipts }, now, liveWith);
}

/** 撤销一次到货（入库被撤销时用）。 */
export function revertReceipt(order: Order, batchId: string, now: number, live?: LiveBatches): Order {
  if (!(order.receipts ?? []).some((r) => r.batchId === batchId)) return order;
  const receipts = (order.receipts ?? []).filter((r) => r.batchId !== batchId);
  const next: Order = { ...order, receipts: receipts.length ? receipts : undefined };
  if (!next.receipts) delete next.receipts;
  return restamp(next, now, live);
}

/** 一次性全部到货的默认行：每个还欠的色号带上还欠的数量。 */
export function outstandingLines(order: Order, live?: LiveBatches): ReceiveLine[] {
  return Object.entries(outstandingByCode(order, live)).map(([code, qty]) => ({ code, qty })).sort((a, b) => cmpCode(a.code, b.code));
}

/**
 * 修改数量 / 增删色号：每个色号的订购量不能低于已到的数量；数量为 0 且没到过货的行去掉。
 * 订单变空（且没有到货记录）时返回 null，调用方决定是取消还是删除。
 */
export function editItems(order: Order, items: Array<{ code: string; qty: number; amount?: number }>, now: number, live?: LiveBatches): Order {
  const got = receivedByCode(order, live);
  const wanted = new Map<string, OrderItem>();
  for (const it of cleanItems(items)) wanted.set(it.code, it);
  // 已经到过货的色号即使被清零也保留，数量不低于已到
  for (const [code, n] of Object.entries(got)) {
    const cur = wanted.get(code);
    if (!cur) wanted.set(code, { code, qty: n });
    else if (cur.qty < n) wanted.set(code, { ...cur, qty: n });
  }
  const list = [...wanted.values()].sort((a, b) => cmpCode(a.code, b.code));
  return restamp({ ...order, items: list }, now, live);
}

/** 改卖家 / 备注 / 预计总价（传空串清除）。 */
export function editMeta(order: Order, meta: { seller?: string; note?: string; cost?: number | null }, now: number, live?: LiveBatches): Order {
  const next: Order = { ...order };
  if (meta.seller !== undefined) { const s = meta.seller.trim(); if (s) next.seller = s; else delete next.seller; }
  if (meta.note !== undefined) { const s = meta.note.trim(); if (s) next.note = s; else delete next.note; }
  if (meta.cost !== undefined) {
    if (meta.cost !== null && Number.isFinite(meta.cost) && meta.cost > 0) next.cost = Math.round(meta.cost * 100) / 100;
    else delete next.cost;
  }
  return restamp(next, now, live);
}

/** 取消：已经到的货不动，只是剩下没到的不再算在途。已取消的再取消原样返回。 */
export function cancelOrder(order: Order, now: number, live?: LiveBatches): Order {
  if (order.cancelledAt !== undefined) return order;
  const next: Order = { ...order, cancelledAt: now };
  delete next.closedAt;
  return restamp(next, now, live);
}

/** 重新打开已取消的订单：回到已下单 / 部分到货（如果其实已经全部到了就是已到货）。 */
export function reopenOrder(order: Order, now: number, live?: LiveBatches): Order {
  if (order.cancelledAt === undefined) return order;
  const next: Order = { ...order };
  delete next.cancelledAt;
  delete next.closedAt;
  return restamp(next, now, live);
}

// ---------- 在途数量与需求 ----------

/** 所有在途订单里每个色号还欠多少。 */
export function transitByCode(orders: Order[], live?: LiveBatches): Counts {
  const out: Counts = {};
  for (const o of orders) {
    if (!isOpen(statusOf(o, live))) continue;
    for (const [code, n] of Object.entries(outstandingByCode(o, live))) out[code] = (out[code] ?? 0) + n;
  }
  return out;
}

export function openOrders(orders: Order[], live?: LiveBatches): Order[] {
  return orders.filter((o) => isOpen(statusOf(o, live)));
}

/**
 * 从需求里扣掉在途：remaining[code] = max(0, need − transit)，covered = 被在途抵掉的部分。
 * need 不变，不会出现负数。
 */
export function subtractTransit(need: Counts, transit: Counts): { remaining: Counts; covered: Counts; coveredTotal: number } {
  const remaining: Counts = {};
  const covered: Counts = {};
  let coveredTotal = 0;
  for (const [code, n] of Object.entries(need)) {
    const t = Math.max(0, transit[code] ?? 0);
    const take = Math.min(Math.max(0, n), t);
    remaining[code] = Math.max(0, n - take);
    if (take > 0) { covered[code] = take; coveredTotal += take; }
  }
  return { remaining, covered, coveredTotal };
}

// ---------- 迁移 / 清理 / 合并 ----------

/** 旧版 lastOrder → 一张订单。已入库、没有色号的返回 null。id 由下单时间决定，两台设备各自迁移得到同一张。 */
export function migrateLastOrder(last: LastOrder | undefined | null): Order | null {
  if (!last || last.receivedAt || !Array.isArray(last.items)) return null;
  const at = Number(last.at);
  const order = makeOrder({ items: last.items, now: Number.isFinite(at) && at > 0 ? at : 0, id: `lo-${Number.isFinite(at) ? Math.round(at) : 0}`, cost: last.cost, planId: last.planId });
  if (!order) return null;
  order.updatedAt = order.at;
  return order;
}

/** 同步来的数据不可信：补全缺失字段，丢弃坏订单。 */
export function normalizeOrder(raw: unknown): Order | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  const items = cleanItems(Array.isArray(r.items) ? (r.items as OrderItem[]) : []);
  const receiptsRaw = Array.isArray(r.receipts) ? r.receipts : [];
  const receipts: OrderReceipt[] = [];
  for (const x of receiptsRaw) {
    const rr = x as Partial<OrderReceipt> | null;
    if (!rr || typeof rr.batchId !== "string" || !Array.isArray(rr.lines)) continue;
    const lines = rr.lines.map((l) => ({ code: String(l?.code ?? ""), qty: cleanQty(l?.qty) })).filter((l) => l.code && l.qty > 0);
    if (!lines.length) continue;
    const rec: OrderReceipt = { batchId: rr.batchId, at: Number(rr.at) || 0, lines };
    if (typeof rr.paidFen === "number" && rr.paidFen > 0) rec.paidFen = rr.paidFen;
    receipts.push(rec);
  }
  if (!items.length && !receipts.length) return null;
  const at = Number(r.at);
  const updatedAt = Number(r.updatedAt);
  const order: Order = {
    id: r.id, at: Number.isFinite(at) ? at : 0, items, status: "placed",
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Number.isFinite(at) ? at : 0
  };
  if (typeof r.seller === "string" && r.seller.trim()) order.seller = r.seller.trim();
  if (typeof r.note === "string" && r.note.trim()) order.note = r.note.trim();
  if (typeof r.cost === "number" && Number.isFinite(r.cost) && r.cost > 0) order.cost = r.cost;
  if (typeof r.planId === "string" && r.planId) order.planId = r.planId;
  if (receipts.length) order.receipts = receipts;
  if (typeof r.cancelledAt === "number" && Number.isFinite(r.cancelledAt)) order.cancelledAt = r.cancelledAt;
  if (typeof r.closedAt === "number" && Number.isFinite(r.closedAt)) order.closedAt = r.closedAt;
  order.status = statusOf(order);
  return order;
}

/** 读取偏好里的订单：prefs.orders + 还没入库的旧 lastOrder（迁移）。按下单时间新到旧。 */
export function readOrders(prefs: { orders?: unknown; lastOrder?: LastOrder } | null | undefined): Order[] {
  const list: Order[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(prefs?.orders) ? (prefs!.orders as unknown[]) : []) {
    const o = normalizeOrder(raw);
    if (o && !seen.has(o.id)) { seen.add(o.id); list.push(o); }
  }
  const legacy = migrateLastOrder(prefs?.lastOrder);
  if (legacy && !seen.has(legacy.id)) list.push(legacy);
  return list.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

/** 清理：在途的全部保留；已到货 / 已取消的只留 30 天内最多 12 张。 */
export function pruneOrders(orders: Order[], now: number, live?: LiveBatches): Order[] {
  const closed: Order[] = [];
  const keep: Order[] = [];
  for (const o of orders) (isOpen(statusOf(o, live)) ? keep : closed).push(o);
  const when = (o: Order) => o.closedAt ?? o.updatedAt;
  const recent = closed.filter((o) => now - when(o) <= CLOSED_KEEP_DAYS * DAY).sort((a, b) => when(b) - when(a)).slice(0, CLOSED_KEEP_MAX);
  return [...keep, ...recent].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

/**
 * 两份订单列表合并（两台设备各改了偏好时用）：同 id 取 updatedAt 大的那张，
 * 但收货记录取并集——入库流水已经真实写进库存，订单上不能丢；撤销过的批次由 live 过滤掉。
 */
export function mergeOrders(a: Order[] | undefined, b: Order[] | undefined): Order[] {
  const byId = new Map<string, Order>();
  for (const o of [...(a ?? []), ...(b ?? [])]) {
    const cur = byId.get(o.id);
    if (!cur) { byId.set(o.id, o); continue; }
    const [win, lose] = o.updatedAt > cur.updatedAt ? [o, cur] : [cur, o];
    const receipts = new Map<string, OrderReceipt>();
    for (const r of [...(lose.receipts ?? []), ...(win.receipts ?? [])]) receipts.set(r.batchId, r);
    const merged: Order = { ...win };
    if (receipts.size) merged.receipts = [...receipts.values()].sort((x, y) => x.at - y.at); else delete merged.receipts;
    merged.status = statusOf(merged);
    byId.set(o.id, merged);
  }
  return [...byId.values()].sort((x, y) => y.at - x.at || (x.id < y.id ? -1 : 1));
}

/** 偏好记录合并用：本地与远端 prefs.orders 的并集（原始数据先规整）。 */
export function mergePrefsOrders(local: { orders?: unknown } | undefined, remote: { orders?: unknown } | undefined, now: number): Order[] {
  const norm = (p: { orders?: unknown } | undefined) => readOrders({ orders: p?.orders });
  return pruneOrders(mergeOrders(norm(local), norm(remote)), now);
}

// ---------- 入库默认值 ----------

export type ReceiveDefaults = {
  rows: Array<{ code: string; qty: number; amount?: number }>;
  /** 一次性全部到货、此前没到过货且填了预计总价时，用预计总价作为默认订单总价（元） */
  totalYuan?: number;
};

/** 到货入库的默认行：还欠多少填多少；有预计行金额的按比例带上。 */
export function receiveDefaults(order: Order, live?: LiveBatches): ReceiveDefaults {
  const left = outstandingByCode(order, live);
  const rows = order.items.filter((i) => (left[i.code] ?? 0) > 0).map((i) => {
    const qty = left[i.code];
    const row: { code: string; qty: number; amount?: number } = { code: i.code, qty };
    if (i.amount) row.amount = Math.round(((i.amount * qty) / i.qty) * 100) / 100;
    return row;
  });
  const out: ReceiveDefaults = { rows };
  const untouched = !liveReceipts(order, live).length;
  if (untouched && order.cost && !rows.some((r) => r.amount)) out.totalYuan = order.cost;
  return out;
}

/** 列表里一行订单的文字：日期 · 卖家。 */
export function orderTitle(order: Order): string {
  const d = new Date(order.at);
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return order.seller ? `${md} · ${order.seller}` : md;
}

/**
 * 仍然有效的入库批次：订单里记着的批次，除非库存流水里能找到它而且全被撤销了。
 * （找不到流水 = 可能还没同步过来，先当作有效，避免重复入库。）
 */
export function liveBatchesFor(orders: Order[], txns: Array<{ batchId?: string; deleted?: boolean }>): Set<string> {
  const state = new Map<string, boolean>(); // batchId → 是否还有未撤销的流水
  for (const t of txns) if (t.batchId) state.set(t.batchId, (state.get(t.batchId) ?? false) || !t.deleted);
  const live = new Set<string>();
  for (const o of orders) for (const r of o.receipts ?? []) if (state.get(r.batchId) !== false) live.add(r.batchId);
  return live;
}
