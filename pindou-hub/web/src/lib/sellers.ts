// 卖家资料：每个卖家有自己的包规格/价格、套装、运费和包邮门槛。
// 内置的“默认报价”就是用户 2026-11-06 确认的那份报价，数字不变；自定义卖家只存在共享偏好里
// （prefs.sellers / prefs.sellerId），随偏好一起同步，不新增同步集合。
// 并发编辑：偏好整条记录“后写者胜”（与其他偏好一致）。保存时总是基于本机当下最新的偏好改，
// 所以只会在“两台设备在同一次同步间隔里都改了卖家”时丢掉先写的那一次。
import { getSnapshot } from "./db";
import type { SharedPrefs } from "./model";

export const DEFAULT_SELLER_ID = "default";
export const BASE_PRICE_1200 = 1.26;
/** 已知套装的色数；套装每色 1200 颗。 */
export const KNOWN_KIT_COLORS = [221, 265, 295] as const;
export const MAX_SELLERS = 12;
export const MAX_PACKS = 5;
export const MAX_KITS = 6;

export type SellerPack = {
  id: string;
  /** 单包颗数 */
  beads: number;
  /** 单包价格（元） */
  price: number;
  /** 整单这种包至少买多少包才能备注色号；空 = 没有限制 */
  minPacks?: number;
  /** 只能用于 A–M 色系；空 = 任意色号 */
  scope?: "any" | "A-M";
};

export type SellerKit = { id: string; colors: number; price: number };

export type Seller = {
  id: string;
  name: string;
  /** 备注 / 链接文字 */
  note?: string;
  packs: SellerPack[];
  kits: SellerKit[];
  /** 运费（元），0 = 包邮 */
  shipping: number;
  /** 商品金额达到多少元免运费；空 = 没有包邮门槛 */
  freeShipping?: number;
  /** 内置默认卖家 */
  builtin?: boolean;
  updatedAt?: number;
};

/** 内置默认卖家（用户 2026-11-06 确认的报价）。price1200 是 1200 颗装的单价（1.26 / 1.5）。 */
export function builtinSeller(price1200: number = BASE_PRICE_1200): Seller {
  return {
    id: DEFAULT_SELLER_ID,
    name: "默认报价",
    note: "2026-11-06 确认的报价：单色包 4000 / 1200 / 500 颗，221 / 265 / 295 色套装。",
    builtin: true,
    shipping: 0,
    packs: [
      { id: "p4000", beads: 4000, price: 2.17, scope: "A-M" },
      { id: "p1200", beads: 1200, price: price1200 },
      { id: "p500", beads: 500, price: 1, minPacks: 10 }
    ],
    kits: [
      { id: "set-221-185", colors: 221, price: 185 },
      { id: "set-221-210", colors: 221, price: 210 },
      { id: "set-265-257", colors: 265, price: 257 },
      { id: "set-295-352", colors: 295, price: 352 }
    ]
  };
}

/** 内置卖家改用别的 1200 颗装单价（保持 prefs.price1200 有效）。 */
export function withPrice1200(seller: Seller, price1200: number): Seller {
  if (!seller.builtin) return seller;
  return { ...seller, packs: seller.packs.map((p) => (p.id === "p1200" ? { ...p, price: price1200 } : p)) };
}

function num(v: unknown, fallback = NaN): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}
const money = (v: number) => Math.round(v * 100) / 100;

/** 把任意存储内容整理成合法卖家；不合法返回 null（同步来的脏数据不会让页面崩）。 */
export function normalizeSeller(raw: unknown): Seller | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id && r.id !== DEFAULT_SELLER_ID ? r.id.slice(0, 40) : "";
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 30) : "";
  if (!id || !name) return null;
  const packs: SellerPack[] = [];
  for (const p of Array.isArray(r.packs) ? r.packs : []) {
    if (!p || typeof p !== "object" || packs.length >= MAX_PACKS) continue;
    const beads = Math.round(num((p as SellerPack).beads));
    const price = money(num((p as SellerPack).price));
    if (!(beads >= 50 && beads <= 100000) || !(price > 0)) continue;
    const min = Math.round(num((p as SellerPack).minPacks, 0));
    const pid = typeof (p as SellerPack).id === "string" && (p as SellerPack).id ? (p as SellerPack).id.slice(0, 20) : `p${beads}`;
    packs.push({ id: pid, beads, price, ...(min > 1 ? { minPacks: Math.min(min, 999) } : {}), ...((p as SellerPack).scope === "A-M" ? { scope: "A-M" as const } : {}) });
  }
  if (!packs.length) return null;
  const kits: SellerKit[] = [];
  for (const k of Array.isArray(r.kits) ? r.kits : []) {
    if (!k || typeof k !== "object" || kits.length >= MAX_KITS) continue;
    const colors = Math.round(num((k as SellerKit).colors));
    const price = money(num((k as SellerKit).price));
    if (!(colors >= 1 && colors <= 500) || !(price > 0)) continue;
    const kid = typeof (k as SellerKit).id === "string" && (k as SellerKit).id ? (k as SellerKit).id.slice(0, 20) : `k${kits.length + 1}`;
    kits.push({ id: kid, colors, price });
  }
  const shipping = Math.max(0, money(num(r.shipping, 0)));
  const free = num(r.freeShipping);
  const note = typeof r.note === "string" ? r.note.trim().slice(0, 200) : "";
  const stamp = num(r.updatedAt);
  return {
    id, name, packs, kits, shipping,
    ...(note ? { note } : {}),
    ...(free > 0 ? { freeShipping: money(free) } : {}),
    ...(stamp > 0 ? { updatedAt: stamp } : {})
  };
}

/** 保存前的检查，返回给用户看的一句话；通过返回 null。 */
export function validateSeller(seller: Seller): string | null {
  if (!seller.name.trim()) return "请填写卖家名称";
  if (!seller.packs.length) return "至少要有一种单色包";
  const sizes = new Set<number>();
  for (const p of seller.packs) {
    if (!(p.beads >= 50) || !Number.isFinite(p.beads)) return "单色包颗数至少 50";
    if (!(p.price > 0) || !Number.isFinite(p.price)) return "单色包价格要大于 0";
    if (p.minPacks != null && !(p.minPacks >= 1)) return "最少包数要大于 0";
    if (sizes.has(p.beads)) return `${p.beads} 颗的包重复了`;
    sizes.add(p.beads);
  }
  for (const k of seller.kits) {
    if (!(k.colors >= 1) || !(k.price > 0)) return "套装的色数和价格要大于 0";
  }
  if (!(seller.shipping >= 0) || !Number.isFinite(seller.shipping)) return "运费不能为负";
  if (seller.freeShipping != null && !(seller.freeShipping > 0)) return "包邮门槛要大于 0，不设请留空";
  return null;
}

type SellerFields = Pick<SharedPrefs, "sellers" | "sellerId" | "sellerDefaultHidden">;

/** 偏好里的自定义卖家（已清洗、去重、限量）。 */
export function customSellers(prefs: SellerFields | null | undefined): Seller[] {
  const seen = new Set<string>();
  const out: Seller[] = [];
  for (const raw of prefs?.sellers ?? []) {
    const s = normalizeSeller(raw);
    if (!s || seen.has(s.id) || out.length >= MAX_SELLERS) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** 列表里能看到、能选的卖家：默认卖家（没被隐藏，或没有别的卖家时）+ 自定义卖家。 */
export function listSellers(prefs: (SellerFields & { price1200?: number }) | null | undefined): Seller[] {
  const custom = customSellers(prefs);
  const builtin = builtinSeller(prefs?.price1200 === 1.5 ? 1.5 : BASE_PRICE_1200);
  return prefs?.sellerDefaultHidden && custom.length ? custom : [builtin, ...custom];
}

/** 当前选中的卖家；没选、选中的已被删除或隐藏时回到第一个可见卖家。 */
export function currentSeller(prefs: (SellerFields & { price1200?: number }) | null | undefined): Seller {
  const all = listSellers(prefs);
  return all.find((s) => s.id === prefs?.sellerId) ?? all[0];
}

/** 页面之外（成本函数的默认参数）取当前卖家：读本机最新的偏好快照。 */
export function activeSeller(): Seller {
  try { return currentSeller(getSnapshot().prefs); } catch { return builtinSeller(); }
}

export type SellerPatch = Partial<Pick<SharedPrefs, "sellers" | "sellerId" | "sellerDefaultHidden">>;

function patchFor(prefs: SellerFields, customs: Seller[], sellerId: string | undefined, hidden: boolean | undefined): SellerPatch {
  return { sellers: customs, sellerId, sellerDefaultHidden: hidden && customs.length ? true : undefined };
}

export function newSellerId(now = Date.now(), rand = Math.random()): string {
  return `s${now.toString(36)}${Math.floor(rand * 36 ** 4).toString(36).padStart(4, "0")}`;
}

/** 一个空白的新卖家草稿（带常见的一种包）。 */
export function blankSeller(id: string): Seller {
  return { id, name: "", packs: [{ id: "p1200", beads: 1200, price: 1.26 }], kits: [], shipping: 0 };
}

/** 复制：新 id，名字加“（副本）”；内置卖家复制出来的是可编辑的自定义卖家。 */
export function duplicateSeller(seller: Seller, id: string, now = Date.now()): Seller {
  const { builtin: _b, ...rest } = seller;
  return { ...rest, id, name: `${seller.name}（副本）`.slice(0, 30), packs: seller.packs.map((p) => ({ ...p })), kits: seller.kits.map((k) => ({ ...k })), updatedAt: now };
}

/** 新增或更新一个自定义卖家，并返回要写回偏好的字段。 */
export function upsertSeller(prefs: SellerFields, seller: Seller, now = Date.now(), select = false): SellerPatch {
  const clean = normalizeSeller({ ...seller, updatedAt: now });
  const customs = customSellers(prefs);
  if (!clean) return patchFor(prefs, customs, prefs.sellerId, prefs.sellerDefaultHidden);
  const i = customs.findIndex((s) => s.id === clean.id);
  if (i >= 0) customs[i] = clean;
  else if (customs.length < MAX_SELLERS) customs.push(clean);
  return patchFor(prefs, customs, select ? clean.id : prefs.sellerId, prefs.sellerDefaultHidden);
}

/** 删除自定义卖家（内置不可删）；删掉当前选中的就回到默认。 */
export function removeSeller(prefs: SellerFields, id: string): SellerPatch {
  const customs = customSellers(prefs).filter((s) => s.id !== id);
  return patchFor(prefs, customs, prefs.sellerId === id ? undefined : prefs.sellerId, prefs.sellerDefaultHidden);
}

export function selectSeller(prefs: SellerFields, id: string | undefined): SellerPatch {
  return patchFor(prefs, customSellers(prefs), id && id !== DEFAULT_SELLER_ID ? id : undefined, prefs.sellerDefaultHidden);
}

/** 隐藏 / 恢复内置默认卖家；隐藏时若当前选的是它，就改选第一个自定义卖家。 */
export function setDefaultHidden(prefs: SellerFields, hidden: boolean): SellerPatch {
  const customs = customSellers(prefs);
  if (hidden && !customs.length) return patchFor(prefs, customs, prefs.sellerId, false);
  const sellerId = hidden && (!prefs.sellerId || prefs.sellerId === DEFAULT_SELLER_ID) ? customs[0].id : prefs.sellerId;
  return patchFor(prefs, customs, sellerId, hidden);
}

/** 恢复默认：显示内置卖家并选中它（自定义卖家保留）。 */
export function resetToDefaultSeller(prefs: SellerFields): SellerPatch {
  return patchFor(prefs, customSellers(prefs), undefined, false);
}

/** 运费：没有门槛就是固定运费；商品金额达到门槛免运费；商品为 0 不收运费。 */
export function shippingFor(seller: Pick<Seller, "shipping" | "freeShipping">, goods: number): number {
  if (!(goods > 0) || !(seller.shipping > 0)) return 0;
  if (seller.freeShipping != null && goods + 1e-9 >= seller.freeShipping) return 0;
  return seller.shipping;
}

/** 还差多少元免运费；已免或没有门槛返回 0。 */
export function freeShippingGap(seller: Pick<Seller, "shipping" | "freeShipping">, goods: number): number {
  if (!(goods > 0) || !(seller.shipping > 0) || seller.freeShipping == null) return 0;
  return Math.max(0, Math.round((seller.freeShipping - goods) * 100) / 100);
}
