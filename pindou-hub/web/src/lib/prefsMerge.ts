// 共享偏好记录的合并决定（纯函数，不碰存储）：db.mergeRemote 在偏好“整条后写者胜”之后调用，
// 把两台设备各自改的 prefs.orders（每张订单后写者胜）和 prefs.sellers（每个卖家后写者胜 + 墓碑）补回来。
// 约定：合并与来源顺序无关（可交换）、重复执行不变（幂等）、没有差别就不写回；写回的结果再和原来源合并仍是它自己。
import { reconcileOrders, stableStringify } from "./orders";
import { MAX_SELLERS, normalizeSeller, type Seller } from "./sellers";

/** 卖家被删除的记录：删除时间 at。之后没有比它更新的编辑，这个卖家就保持已删除。 */
export type SellerTomb = { id: string; at: number };
/** 墓碑保留多久、最多几条；过期后旧设备再同步回来的同 id 卖家会重新出现，这是可接受的代价。 */
export const TOMB_KEEP_DAYS = 60;
export const MAX_TOMBS = 40;
const DAY = 86_400_000;

type SellerFields = { sellers?: unknown; sellersDeleted?: unknown };
export type SellerState = { sellers: Seller[]; tombs: SellerTomb[] };

export function normalizeTombs(raw: unknown): SellerTomb[] {
  const best = new Map<string, number>();
  for (const t of Array.isArray(raw) ? raw : []) {
    const id = typeof (t as SellerTomb)?.id === "string" ? (t as SellerTomb).id : "";
    const at = Number((t as SellerTomb)?.at);
    if (!id || !Number.isFinite(at) || at <= 0) continue;
    best.set(id, Math.max(best.get(id) ?? 0, at));
  }
  return [...best].map(([id, at]) => ({ id, at })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function pruneTombs(tombs: SellerTomb[], now: number): SellerTomb[] {
  return tombs.filter((t) => now - t.at <= TOMB_KEEP_DAYS * DAY).sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)).slice(0, MAX_TOMBS).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** 多份来源里的卖家合并：同 id 取 updatedAt 大的（相同时按内容定），被更晚的墓碑盖住的卖家删掉；结果按 id 排序。 */
export function mergeSellerState(sources: SellerFields[]): SellerState {
  const tombById = new Map<string, number>();
  for (const src of sources) for (const t of normalizeTombs(src?.sellersDeleted)) tombById.set(t.id, Math.max(tombById.get(t.id) ?? 0, t.at));
  const byId = new Map<string, Seller>();
  for (const src of sources) {
    for (const raw of Array.isArray(src?.sellers) ? src.sellers : []) {
      const s = normalizeSeller(raw);
      if (!s) continue;
      const cur = byId.get(s.id);
      const sWins = !cur || ((s.updatedAt ?? 0) !== (cur.updatedAt ?? 0) ? (s.updatedAt ?? 0) > (cur.updatedAt ?? 0) : stableStringify(s) > stableStringify(cur));
      if (sWins) byId.set(s.id, s);
    }
  }
  let alive = [...byId.values()].filter((s) => (s.updatedAt ?? 0) > (tombById.get(s.id) ?? -1));
  if (alive.length > MAX_SELLERS) alive = alive.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || (a.id < b.id ? -1 : 1)).slice(0, MAX_SELLERS);
  alive.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const aliveIds = new Set(alive.map((s) => s.id));
  // 已经被更新的编辑盖过的墓碑没有用了
  const tombs = [...tombById].filter(([id, at]) => !aliveIds.has(id) || (byId.get(id)!.updatedAt ?? 0) <= at).map(([id, at]) => ({ id, at }));
  return { sellers: alive, tombs: tombs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}

/** 保留下来的那条偏好 kept 与其他来源合并后，卖家或墓碑和 kept 不同才返回要写回的结果（墓碑过期清理本身不算差别）。 */
export function reconcileSellers(kept: SellerFields | undefined, others: Array<SellerFields | undefined>, now: number): SellerState | null {
  const own = mergeSellerState([kept ?? {}]);
  const full = mergeSellerState([kept ?? {}, ...others.map((o) => o ?? {})]);
  const same = (a: SellerState, b: SellerState) => stableStringify(a) === stableStringify(b);
  if (same(full, own)) return null;
  const result = { sellers: full.sellers, tombs: pruneTombs(full.tombs, now) };
  return same(result, { sellers: own.sellers, tombs: pruneTombs(own.tombs, now) }) ? null : result;
}

/**
 * 偏好记录的合并决定：返回要写回的整条记录（只改 orders / sellers / sellersDeleted），没有差别返回 null。
 * 选中的卖家 sellerId 等其它字段不动，仍按整条记录后写者胜。
 */
export function reconcilePrefsRecord<T extends { orders?: unknown; sellers?: unknown; sellersDeleted?: unknown }>(kept: T, others: Array<Partial<T> | null | undefined>, now: number): T | null {
  const list = others.filter((o): o is Partial<T> => !!o && typeof o === "object");
  const orders = reconcileOrders(kept, list, now);
  const sellers = reconcileSellers(kept, list, now);
  if (!orders && !sellers) return null;
  const next: T = { ...kept };
  if (orders) next.orders = orders;
  if (sellers) {
    next.sellers = sellers.sellers;
    if (sellers.tombs.length) next.sellersDeleted = sellers.tombs;
    else delete next.sellersDeleted;
  }
  return next;
}
