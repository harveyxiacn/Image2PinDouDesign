// 采购方案：把用户 2026-11-06 确认过的套装/补充包报价，按当前缺口算到最小成本。
// 这里只有纯函数，页面和测试共用；数据来源是用户确认的固定报价，不依赖服务端。
import type { Counts, LastOrder } from "./model";
import { compareCodes } from "./inventory";
import { activeSeller, builtinSeller, freeShippingGap, shippingFor, withPrice1200, type Seller, type SellerKit, type SellerPack } from "./sellers";

export type PackId = "p4000" | "p1200" | "p500";
export type PackCounts = Record<PackId, number>;

export type PurchaseOffer = {
  id: string;
  kind: "set" | "single";
  name: string;
  price: number;
  currency: "CNY";
  /** 套装总色数；单色补充包为空 */
  colors?: number;
  /** 套装每色颗数；单色补充包为空 */
  beadsPerColor?: number;
  /** 套装整盒颗数 */
  totalBeads?: number;
  /** 单包颗数 */
  beads?: number;
  scope: "MARD" | "A-M" | "any";
  /** 500 颗包满多少包可备注色号 */
  minPacks?: number;
  /** 元/颗 */
  perBead: number;
  note: string;
  /** 用户已确认（2026-11-06） */
  confirmed: boolean;
};

export const PACK_BEADS: Record<PackId, number> = { p4000: 4000, p1200: 1200, p500: 500 };
export const DEFAULT_PRICE_1200 = 1.26;

function setOffer(id: string, name: string, price: number, colors: number): PurchaseOffer {
  const totalBeads = colors * 1200;
  return {
    id, kind: "set", name, price, currency: "CNY", colors, beadsPerColor: 1200, totalBeads,
    scope: "MARD", perBead: price / totalBeads, confirmed: true,
    note: `${colors} 色，每色 1200 颗；已确认色号可对 MARD。`
  };
}

function singleOffer(id: string, name: string, price: number, beads: number, scope: PurchaseOffer["scope"], note: string, minPacks?: number): PurchaseOffer {
  return {
    id, kind: "single", name, price, currency: "CNY", beads, scope, minPacks,
    perBead: price / beads, confirmed: true, note
  };
}

/** 用户 2026-11-06 确认的 8 条报价。 */
export const PURCHASE_OFFERS: PurchaseOffer[] = [
  setOffer("set-221-185", "221 色套装（185 元）", 185, 221),
  setOffer("set-221-210", "221 色套装（210 元）", 210, 221),
  setOffer("set-265-257", "265 色套装（257 元）", 257, 265),
  setOffer("set-295-352", "295 色套装（352 元）", 352, 295),
  singleOffer("single-4000-217-AM", "单色补充包 4000 颗（A–M）", 2.17, 4000, "A-M", "2.17 元/4000 颗，仅 A–M 色系；可备注详细色号。"),
  singleOffer("single-1200-126", "单色补充包 1200 颗（1.26 元）", 1.26, 1200, "any", "1.26 元/包，任意色号。"),
  singleOffer("single-1200-150", "单色补充包 1200 颗（1.5 元）", 1.5, 1200, "any", "1.5 元/包，任意色号；作为 1.26 的敏感性。"),
  singleOffer("single-500-1", "单色补充包 500 颗（1 元）", 1, 500, "any", "1 元/包；满 10 包可备注色号。", 10)
];

export function isAM(code: string): boolean {
  return /^[A-M]/.test(code);
}

/** 一种规格买了几包（带价格，方便不同卖家各算各的）。 */
export type PackLine = { id: string; beads: number; price: number; n: number; minPacks?: number };

export type OptimizedPacks = {
  cost: number;
  beads: number;
  packs: PackCounts;
  /** 各规格包数，键是 p4000/p1200/p500 */
  counts: Partial<Record<PackId, number>>;
  /** 任意规格的包数（从大到小）；买不了（没有可用的包）时为空 */
  lines: PackLine[];
};

export type OptimizeOptions = {
  /** 是否允许 500 颗装；默认允许。500 颗装满 10 包才能备注色号，见 enforce500Min。（泛化后 = 是否允许带“最少包数”的包） */
  allow500?: boolean;
  /** 在最低成本之上愿意多花的钱来换更少剩余；默认 max(¥0.30, 最低成本 × 3%)。传 0 = 纯最省钱。 */
  tolerance?: number;
  /** 排除这些包 id（计划层重算“不用某规格”时用） */
  exclude?: string[];
  /** 用哪个卖家的包规格；默认是内置默认卖家（带 price1200） */
  seller?: Seller;
};

/** 单色补充包的固定单价（元/包）。1200 颗装价格可调（1.26 / 1.5）。 */
export function packPrice(id: PackId, price1200 = DEFAULT_PRICE_1200): number {
  return id === "p4000" ? 2.17 : id === "p1200" ? price1200 : 1;
}

export function packCost(packs: PackCounts, price1200 = DEFAULT_PRICE_1200): number {
  return packs.p4000 * packPrice("p4000") + packs.p1200 * packPrice("p1200", price1200) + packs.p500 * packPrice("p500");
}

export function packBeads(packs: PackCounts): number {
  return packs.p4000 * PACK_BEADS.p4000 + packs.p1200 * PACK_BEADS.p1200 + packs.p500 * PACK_BEADS.p500;
}

/** 500 颗装“可指定色号”所需的整单最少包数（用户确认：满 10 包可备注色号）。 */
export const MIN_PACKS_500 = 10;

export function linesCost(lines: PackLine[]): number {
  return lines.reduce((sum, l) => sum + l.n * l.price, 0);
}
export function linesBeads(lines: PackLine[]): number {
  return lines.reduce((sum, l) => sum + l.n * l.beads, 0);
}
export function linesCount(lines: PackLine[]): number {
  return lines.reduce((sum, l) => sum + l.n, 0);
}
/** 把任意规格的包数折成老的 4000/1200/500 三格（其他规格不计入；只用于兼容旧界面）。 */
export function countsOfLines(lines: PackLine[]): PackCounts {
  const out: PackCounts = { p4000: 0, p1200: 0, p500: 0 };
  for (const l of lines) {
    if (l.beads === 4000) out.p4000 += l.n;
    else if (l.beads === 1200) out.p1200 += l.n;
    else if (l.beads === 500) out.p500 += l.n;
  }
  return out;
}
function linesOfCounts(packs: PackCounts, offers: SellerPack[]): PackLine[] {
  const out: PackLine[] = [];
  for (const o of sortOffers(offers)) {
    const n = o.beads === 4000 ? packs.p4000 : o.beads === 1200 ? packs.p1200 : o.beads === 500 ? packs.p500 : 0;
    if (n > 0) out.push(lineOf(o, n));
  }
  return out;
}
function lineOf(o: SellerPack, n: number): PackLine {
  return { id: o.id, beads: o.beads, price: o.price, n, ...(o.minPacks ? { minPacks: o.minPacks } : {}) };
}
function sortOffers(offers: SellerPack[]): SellerPack[] {
  return [...offers].sort((a, b) => (b.beads - a.beads) || (a.price - b.price));
}
function legacyOffers(price1200: number): SellerPack[] {
  return builtinSeller(price1200).packs;
}

const COMBO_LIMIT = 200_000;

/**
 * 泛化的单色补充包优化：offers 是任意规格/价格（可带“最少包数”、A–M 限制）。
 * 先找最低成本；再在“成本不超过最低成本 + 容差”的组合里选剩余最少的（剩余相同 → 包数更少）。
 * 枚举除最小包以外各规格的包数，最小包只补最少的那一部分，所以结果是精确的而不是启发式
 * （极端大的需求会收窄小规格的枚举范围以免卡住）。
 */
export function optimizeWithOffers(x: number, code: string, offers: SellerPack[], options: OptimizeOptions = {}): OptimizedPacks {
  const need = Math.max(0, Math.round(Number.isFinite(x) ? x : 0));
  const empty: OptimizedPacks = { cost: 0, beads: 0, packs: { p4000: 0, p1200: 0, p500: 0 }, counts: {}, lines: [] };
  if (need <= 0) return empty;
  const allowMin = options.allow500 !== false;
  const skip = new Set(options.exclude ?? []);
  const list = sortOffers(offers.filter((o) => (o.scope !== "A-M" || isAM(code)) && (allowMin || !o.minPacks) && !skip.has(o.id)));
  if (!list.length) return empty;

  // 估算枚举量，过大就收窄非最大规格的范围
  const bounds = list.map((o) => Math.ceil(need / o.beads));
  let combos = 1;
  for (let i = 0; i < list.length - 1; i++) combos *= bounds[i] + 1;
  const capSmall = combos > COMBO_LIMIT ? 12 : Infinity;

  const cands: Array<{ ns: number[]; cost: number; beads: number; count: number }> = [];
  const walk = (i: number, rest: number, ns: number[]) => {
    const o = list[i];
    if (i === list.length - 1) {
      const all = [...ns, rest > 0 ? Math.ceil(rest / o.beads) : 0];
      let cost = 0; let beads = 0; let count = 0;
      all.forEach((n, k) => { cost += n * list[k].price; beads += n * list[k].beads; count += n; });
      cands.push({ ns: all, cost, beads, count });
      return;
    }
    const max = i === 0 ? bounds[i] : Math.min(bounds[i], capSmall);
    for (let n = 0; n <= max; n++) {
      const left = rest - n * o.beads;
      walk(i + 1, left, [...ns, n]);
      if (left <= 0) break;
    }
  };
  walk(0, need, []);

  const minCost = Math.min(...cands.map((c) => c.cost));
  const tolerance = options.tolerance ?? Math.max(0.3, minCost * 0.03);
  const pool = cands.filter((c) => c.cost <= minCost + tolerance + 1e-9);
  pool.sort((p, q) => (p.beads - q.beads) || (p.count - q.count) || (p.cost - q.cost));
  const best = pool[0];
  const lines = best.ns.map((n, k) => (n > 0 ? lineOf(list[k], n) : null)).filter((l): l is PackLine => l !== null);
  const packs = countsOfLines(lines);
  const counts: Partial<Record<PackId, number>> = {};
  if (packs.p4000) counts.p4000 = packs.p4000;
  if (packs.p1200) counts.p1200 = packs.p1200;
  if (packs.p500) counts.p500 = packs.p500;
  return { cost: best.cost, beads: best.beads, packs, counts, lines };
}

/**
 * 某个色号买至少 x 颗（允许超买）。默认按内置默认卖家的包规格（4000 仅 A–M / 1200 / 500），
 * 也可以用 options.seller 指定别的卖家。
 */
export function optimizePacks(x: number, code: string, price1200 = DEFAULT_PRICE_1200, options: OptimizeOptions = {}): OptimizedPacks {
  return optimizeWithOffers(x, code, options.seller ? options.seller.packs : legacyOffers(price1200), options);
}

type Slot = { code: string; need: number; packs: PackCounts };
type LineSlot = { code: string; need: number; lines: PackLine[] };

/**
 * “最少包数”规则（计划层，泛化版）：某规格（如 500 颗装）整单总包数必须 ≥ minPacks 才能指定色号。
 * 总数在 1…minPacks-1 时二选一，取总价更低者（持平时取剩余更少的“不用这个规格”）：
 *   A) 用到该规格的色号去掉它重新最优化；
 *   B) 保留，并把它补到 minPacks 包（多出来的包加到已用它的第一个色号上，剩余会变多）。
 * 返回与 slots 同序的新包数。
 */
export function enforceMinPacks(slots: LineSlot[], offers: SellerPack[]): PackLine[][] {
  let out = slots.map((s) => s.lines.map((l) => ({ ...l })));
  const restricted = sortOffers(offers.filter((o) => (o.minPacks ?? 0) > 1));
  const countOf = (ls: PackLine[], id: string) => ls.find((l) => l.id === id)?.n ?? 0;
  for (const o of restricted) {
    const min = o.minPacks!;
    const total = out.reduce((sum, ls) => sum + countOf(ls, o.id), 0);
    if (total === 0 || total >= min) continue;
    const without = out.map((ls, i) => (countOf(ls, o.id) > 0 ? optimizeWithOffers(slots[i].need, slots[i].code, offers, { exclude: [o.id] }).lines : ls));
    const costA = without.reduce((sum, ls) => sum + linesCost(ls), 0);
    const costB = out.reduce((sum, ls) => sum + linesCost(ls), 0) + (min - total) * o.price;
    if (costA <= costB + 1e-9) { out = without; continue; }
    const target = out.findIndex((ls) => countOf(ls, o.id) > 0);
    out[target] = out[target].map((l) => (l.id === o.id ? { ...l, n: l.n + (min - total) } : l));
  }
  return out;
}

/** 500 颗装规则（老接口，默认卖家）：整单 500 颗装总数必须 ≥ 10 包才能指定色号。 */
export function enforce500Min(slots: Slot[], price1200 = DEFAULT_PRICE_1200): PackCounts[] {
  const offers = legacyOffers(price1200);
  const fixed = enforceMinPacks(slots.map((s) => ({ code: s.code, need: s.need, lines: linesOfCounts(s.packs, offers) })), offers);
  return fixed.map((ls) => countsOfLines(ls));
}

export function addPacks(target: PackCounts, packs: PackCounts): PackCounts {
  return {
    p4000: target.p4000 + packs.p4000,
    p1200: target.p1200 + packs.p1200,
    p500: target.p500 + packs.p500
  };
}

export function formatPacks(packs: PackCounts): string {
  const parts: string[] = [];
  if (packs.p4000) parts.push(`${packs.p4000}×4000`);
  if (packs.p1200) parts.push(`${packs.p1200}×1200`);
  if (packs.p500) parts.push(`${packs.p500}×500`);
  return parts.length ? parts.join(" + ") : "—";
}

export function formatMoney(value: number): string {
  return `¥${(Number.isFinite(value) ? value : 0).toFixed(2)}`;
}

export type PurchasePlanItem = {
  code: string;
  /** 图纸净需求（不含损耗、不扣库存） */
  net: number;
  /** 这次要补的缺口（含损耗、已扣库存） */
  need: number;
  setCovered: boolean;
  setBeads: number;
  remaining: number;
  packs: PackCounts;
  singlesBeads: number;
  singlesCost: number;
  totalBeads: number;
  surplus: number;
  /** 当前 1000 颗/包清单的取整数量（仅“按当前清单执行”方案有） */
  appQty?: number;
  /** 任意规格的包数（泛化后的真实来源；packs 只是兼容旧界面的 4000/1200/500 三格） */
  lines?: PackLine[];
};

export type PurchasePlan = {
  id: string;
  name: string;
  setOffer?: PurchaseOffer;
  setPrice: number;
  /** 套装整盒颗数（含用不上的颜色） */
  setBeadsTotal: number;
  /** 套装里真正用到的颗数 */
  usableSetBeads: number;
  /** 套装整盒里用不上的颗数 */
  unusedSetBeads: number;
  setColors?: number;
  singlesCost: number;
  totalCost: number;
  totalBeads: number;
  surplus: number;
  /** 套装覆盖的缺口色数；单色方案等于全部缺口色数 */
  coverage: number;
  missing: string[];
  packs: PackCounts;
  items: PurchasePlanItem[];
  /** 有用颗数：缺口色号里真正会被用掉的颗数 */
  usefulBeads: number;
  /** 浪费颗数 = 需要色号的剩余 + 套装里用不上的颜色的颗数 */
  wasteBeads: number;
  /** 浪费占总颗数的比例 0–1 */
  wastePct: number;
  /** 推荐：成本在最省钱方案 max(¥15, 5%) 以内、浪费最少的方案 */
  recommended: boolean;
  /** 最省钱 */
  cheapest: boolean;
  /** 最少浪费 */
  leastWaste: boolean;
  note: string;
  /** 商品金额（套装 + 补充包，不含运费）；totalCost = goodsCost + shipping */
  goodsCost?: number;
  /** 运费（已按包邮门槛处理） */
  shipping?: number;
  /** 还差多少元包邮；已包邮、没有门槛或运费为 0 时为 0 */
  freeShippingGap?: number;
  sellerId?: string;
  sellerName?: string;
  /** 这个卖家买不了的色号（没有可用的包且没被套装覆盖） */
  unfulfilled?: string[];
};

function codesOf(need: Counts): string[] {
  return Object.keys(need).filter((code) => (need[code] ?? 0) > 0).sort(compareCodes);
}

function finishPlan(base: {
  id: string; name: string; setOffer?: PurchaseOffer; setPrice: number; setBeadsTotal: number;
  usableSetBeads: number; setColors?: number; coverage: number; missing: string[]; items: PurchasePlanItem[];
  note: string; seller?: Seller;
}): PurchasePlan {
  let singlesCost = 0;
  let totalBeads = base.setBeadsTotal;
  let totalNeed = 0;
  let useful = 0;
  let itemSurplus = 0;
  let packs: PackCounts = { p4000: 0, p1200: 0, p500: 0 };
  for (const item of base.items) {
    singlesCost += item.singlesCost;
    totalBeads += item.singlesBeads;
    totalNeed += item.need;
    useful += Math.min(item.need, item.totalBeads);
    itemSurplus += Math.max(0, item.totalBeads - item.need);
    packs = addPacks(packs, item.packs);
  }
  const unusedSetBeads = Math.max(0, base.setBeadsTotal - base.usableSetBeads);
  const wasteBeads = itemSurplus + unusedSetBeads;
  const { seller, ...rest } = base;
  const goodsCost = base.setPrice + singlesCost;
  const shipping = seller ? shippingFor(seller, goodsCost) : 0;
  const unfulfilled = base.items.filter((item) => !item.setCovered && item.remaining > 0 && !(item.lines?.length)).map((item) => item.code);
  return {
    ...rest,
    singlesCost,
    goodsCost,
    shipping,
    totalCost: goodsCost + shipping,
    ...(seller ? { sellerId: seller.id, sellerName: seller.name, freeShippingGap: freeShippingGap(seller, goodsCost) } : {}),
    ...(unfulfilled.length ? { unfulfilled } : {}),
    totalBeads,
    surplus: totalBeads - totalNeed,
    packs,
    unusedSetBeads,
    usefulBeads: useful,
    wasteBeads,
    wastePct: totalBeads > 0 ? wasteBeads / totalBeads : 0,
    recommended: false,
    cheapest: false,
    leastWaste: false
  };
}

/** 用给定的包数组装一个色号条目（成本、颗数、剩余都由包数推出）。 */
function itemFromLines(code: string, need: number, demand: Counts, setBeads: number, covered: boolean, lines: PackLine[], appQty?: number): PurchasePlanItem {
  const remaining = appQty ?? Math.max(0, need - setBeads);
  const singlesBeads = linesBeads(lines);
  return {
    code,
    net: demand[code] ?? 0,
    need,
    setCovered: covered,
    setBeads,
    remaining,
    packs: countsOfLines(lines),
    singlesBeads,
    singlesCost: linesCost(lines),
    totalBeads: setBeads + singlesBeads,
    surplus: setBeads + singlesBeads - need,
    appQty,
    lines
  };
}

type ItemSpec = { code: string; need: number; setBeads: number; covered: boolean; appQty?: number };

/** 逐色最优化后，再按计划层的“最少包数”规则（如 500 颗装满 10 包）整体修正。 */
function buildItems(specs: ItemSpec[], demand: Counts, seller: Seller): PurchasePlanItem[] {
  const slots = specs.map((spec) => {
    const remaining = spec.appQty ?? Math.max(0, spec.need - spec.setBeads);
    return { code: spec.code, need: remaining, lines: optimizeWithOffers(remaining, spec.code, seller.packs).lines };
  });
  const fixed = enforceMinPacks(slots, seller.packs);
  return specs.map((spec, i) => itemFromLines(spec.code, spec.need, demand, spec.setBeads, spec.covered, fixed[i], spec.appQty));
}

/** 套装报价 -> 套装 offer（每色 1200 颗）。 */
export function kitOffer(kit: SellerKit): PurchaseOffer {
  const offer = setOffer(kit.id, `${kit.colors} 色套装（${kit.price} 元）`, kit.price, kit.colors);
  // 只有内置默认卖家的套装是用户确认过色号可对 MARD 的；自定义卖家的不下这个结论
  return kit.id.startsWith("set-") ? offer : { ...offer, confirmed: false, note: `${kit.colors} 色，每色 1200 颗。` };
}

/** 老接口默认用内置默认卖家（带 price1200）；传 seller 就用该卖家。 */
function legacySeller(seller: Seller | undefined, price1200: number): Seller {
  return seller ? withPrice1200(seller, price1200) : builtinSeller(price1200);
}

/** 全部按单色补充包买；最稳，颜色完全可控。 */
export function planAllSingles(need: Counts, demand: Counts = need, price1200 = DEFAULT_PRICE_1200, seller?: Seller): PurchasePlan {
  const sel = legacySeller(seller, price1200);
  const items = buildItems(codesOf(need).map((code) => ({ code, need: Math.round(need[code]), setBeads: 0, covered: false })), demand, sel);
  return finishPlan({
    id: "plan-all-singles",
    name: "全部单色号补充",
    setPrice: 0,
    setBeadsTotal: 0,
    usableSetBeads: 0,
    coverage: items.length,
    missing: [],
    items,
    seller: sel,
    note: "最稳、囤货最少；颜色完全按 MARD 色号买。"
  });
}

/** 套装按“覆盖该色能省多少钱”排序，覆盖价值最高的 N 色。 */
function coverageForSet(need: Counts, offer: PurchaseOffer, seller: Seller): { covered: Set<string>; missing: string[] } {
  const codes = codesOf(need);
  const target = Math.min(offer.colors ?? codes.length, codes.length);
  if (target >= codes.length) return { covered: new Set(codes), missing: [] };
  const beadsPerColor = offer.beadsPerColor ?? 1200;
  const values = new Map<string, number>();
  for (const code of codes) {
    const amount = Math.max(0, Math.round(need[code]));
    const base = optimizeWithOffers(amount, code, seller.packs);
    const covered = optimizeWithOffers(Math.max(0, amount - beadsPerColor), code, seller.packs);
    values.set(code, base.cost - covered.cost);
  }
  const sorted = [...codes].sort((a, b) => (values.get(b)! - values.get(a)!) || compareCodes(a, b));
  return { covered: new Set(sorted.slice(0, target)), missing: sorted.slice(target) };
}

/** 方案 id：默认卖家的四个套装保持老 id（旧链接继续有效），其他套装用 plan-kit-<id>。 */
export function planIdOfKit(kitId: string): string {
  const m = /^set-(\d+)-(\d+)$/.exec(kitId);
  return m ? `plan-set${m[1]}-${m[2]}` : `plan-kit-${kitId}`;
}

/** 套装（每色 1200 颗）+ 补充包。 */
export function planWithSet(offer: PurchaseOffer, need: Counts, demand: Counts = need, price1200 = DEFAULT_PRICE_1200, seller?: Seller): PurchasePlan {
  const sel = legacySeller(seller, price1200);
  const { covered, missing } = coverageForSet(need, offer, sel);
  const beadsPerColor = offer.beadsPerColor ?? 1200;
  const setBeadsTotal = offer.totalBeads ?? (offer.colors ?? 0) * beadsPerColor;
  const items = buildItems(codesOf(need).map((code) => {
    const isCovered = covered.has(code);
    return { code, need: Math.round(need[code]), setBeads: isCovered ? beadsPerColor : 0, covered: isCovered };
  }), demand, sel);
  const usableSetBeads = items.reduce((sum, item) => sum + item.setBeads, 0);
  const missingCost = items.filter((item) => !item.setCovered).reduce((sum, item) => sum + item.singlesCost, 0);
  const unusedColors = Math.max(0, (offer.colors ?? 0) - covered.size);
  const unusedBeads = Math.max(0, setBeadsTotal - usableSetBeads);
  return finishPlan({
    id: planIdOfKit(offer.id),
    name: `${offer.name} + 补充包`,
    setOffer: offer,
    setPrice: offer.price,
    setBeadsTotal,
    usableSetBeads,
    setColors: offer.colors,
    seller: sel,
    coverage: covered.size,
    missing,
    items,
    note: missing.length
      ? `${offer.id === "set-221-210" ? "同 221 色的高价版；" : ""}${offer.confirmed ? "套装已确认可对 MARD，每色 1200 颗。" : "套装按每色 1200 颗计。"}缺 ${missing.length} 色，单买约 ${formatMoney(missingCost)}。`
      : unusedColors
        ? `套装覆盖全部缺口色；另有 ${unusedColors} 色用不上（${unusedBeads.toLocaleString("zh-CN")} 颗），整盒计入总颗数。`
        : "套装覆盖全部缺口色，没有用不上的颜色。"
  });
}

/** 当前 app 按 1000 颗/包取整后的清单，再用真实报价履行。 */
export function planAppCurrent(need: Counts, demand: Counts = need, price1200 = DEFAULT_PRICE_1200, seller?: Seller): PurchasePlan {
  const sel = legacySeller(seller, price1200);
  const items = buildItems(codesOf(need).map((code) => {
    const amount = Math.max(0, Math.round(need[code]));
    return { code, need: amount, setBeads: 0, covered: false, appQty: Math.ceil(amount / 1000) * 1000 };
  }), demand, sel);
  const appQtyTotal = items.reduce((sum, item) => sum + (item.appQty ?? 0), 0);
  return finishPlan({
    id: "plan-app-current",
    name: "按当前 1000 颗/包清单执行",
    setPrice: 0,
    setBeadsTotal: 0,
    usableSetBeads: 0,
    coverage: items.length,
    missing: [],
    items,
    seller: sel,
    note: `当前清单按 1000 颗/包取整为 ${appQtyTotal.toLocaleString("zh-CN")} 颗；用真实报价履行通常比按缺口买更贵。`
  });
}

/** 推荐依据：综合（成本容差内最少浪费）/ 最省钱 / 最少剩余。 */
export type PurchasePrefer = "balanced" | "cheapest" | "leastWaste";
export const PURCHASE_PREFER_LABEL: Record<PurchasePrefer, string> = { balanced: "综合", cheapest: "最省钱", leastWaste: "最少剩余" };

export function parsePrefer(value: unknown): PurchasePrefer {
  return value === "cheapest" || value === "leastWaste" ? value : "balanced";
}

/** 推荐方案的成本容差：比最省钱方案多花不超过 max(¥15, 5%)。 */
export function recommendTolerance(cheapestCost: number): number {
  return Math.max(15, cheapestCost * 0.05);
}

/**
 * 给方案打标签（返回新数组，顺序不变）：
 * 最省钱 = 总价最低（并列取浪费更少）；最少浪费 = wasteBeads 最少（并列取更便宜）；
 * 推荐随 prefer：综合 = 总价在最省钱 + max(¥15, 5%) 以内、浪费最少者；最省钱 = 最省钱方案；最少剩余 = 最少浪费方案。
 * 一个方案可同时有多个标签。
 */
export function tagPlans(plans: PurchasePlan[], prefer: PurchasePrefer = "balanced"): PurchasePlan[] {
  if (!plans.length) return plans;
  const byCostThenWaste = (a: PurchasePlan, b: PurchasePlan) => a.totalCost - b.totalCost || a.wasteBeads - b.wasteBeads;
  const byWasteThenCost = (a: PurchasePlan, b: PurchasePlan) => a.wasteBeads - b.wasteBeads || a.totalCost - b.totalCost;
  const cheapest = [...plans].sort(byCostThenWaste)[0];
  const leastWaste = [...plans].sort(byWasteThenCost)[0];
  const limit = cheapest.totalCost + recommendTolerance(cheapest.totalCost) + 1e-9;
  const recommended = prefer === "cheapest" ? cheapest : prefer === "leastWaste" ? leastWaste : plans.filter((p) => p.totalCost <= limit).sort(byWasteThenCost)[0];
  return plans.map((p) => ({ ...p, cheapest: p.id === cheapest.id, leastWaste: p.id === leastWaste.id, recommended: p.id === recommended.id }));
}

/** 剩余来源：套装里用不上的颜色 vs 整包凑整多出（plan.wasteBeads = 两者之和）。 */
export function leftoverBreakdown(plan: Pick<PurchasePlan, "unusedSetBeads" | "wasteBeads" | "setColors" | "coverage">): { unusedColors: number; unusedBeads: number; roundingBeads: number } {
  const unusedBeads = Math.max(0, plan.unusedSetBeads);
  const unusedColors = unusedBeads > 0 ? Math.max(0, (plan.setColors ?? 0) - plan.coverage) : 0;
  return { unusedColors, unusedBeads, roundingBeads: Math.max(0, plan.wasteBeads - unusedBeads) };
}

/** 一句话说明为什么推荐它。 */
export function recommendationReason(plans: PurchasePlan[], prefer: PurchasePrefer = "balanced"): string {
  const pick = plans.find((p) => p.recommended);
  const cheapest = plans.find((p) => p.cheapest);
  if (!pick || !cheapest) return "";
  if (pick.id === cheapest.id) {
    const others = plans.filter((p) => p.id !== pick.id);
    const next = others.sort((a, b) => a.totalCost - b.totalCost)[0];
    return pick.leastWaste || !next
      ? "既最省钱，剩下的豆子也最少。"
      : `最省钱；比第二便宜的「${next.name}」少花 ${formatMoney(next.totalCost - pick.totalCost)}。`;
  }
  const extra = pick.totalCost - cheapest.totalCost;
  const saved = cheapest.wasteBeads - pick.wasteBeads;
  return `${prefer === "leastWaste" ? "剩余最少：" : ""}比最省钱方案${extra > 0.005 ? `贵 ${formatMoney(extra)}` : "价格相当"}，少剩 ${saved.toLocaleString("zh-CN")} 颗用不上的豆子。`;
}

/**
 * 方案列表，按总价（含运费）从低到高，并标出 推荐 / 最省钱 / 最少浪费。
 * 默认卖家 = 6 个方案（4 个套装 + 全单色 + 按当前清单）。seller 不传就用当前选中的卖家（读本机偏好），
 * 所以 Shopping 等老调用点不用改；选中内置默认卖家时 price1200 仍然是 1200 颗装的单价。
 */
export function buildPurchasePlans(need: Counts, demand: Counts = need, price1200 = DEFAULT_PRICE_1200, prefer: PurchasePrefer = "balanced", seller?: Seller): PurchasePlan[] {
  const sel = withPrice1200(seller ?? activeSeller(), price1200);
  const plans = [
    ...sel.kits.map((kit) => planWithSet(kitOffer(kit), need, demand, price1200, sel)),
    planAllSingles(need, demand, price1200, sel),
    planAppCurrent(need, demand, price1200, sel)
  ];
  const doable = plans.filter((p) => !p.unfulfilled?.length);
  const pool = doable.length ? doable : plans;
  return tagPlans(pool.sort((a, b) => a.totalCost - b.totalCost || a.id.localeCompare(b.id)), prefer);
}

export type SellerQuote = {
  seller: Seller;
  /** 该卖家最省钱的方案（含运费） */
  best: PurchasePlan;
  /** 该卖家按偏好推荐的方案 */
  recommended: PurchasePlan;
  /** 最省钱方案的总价（含运费） */
  total: number;
  /** 买不了的色号（没有可用的包）；非空表示这个卖家供不齐 */
  unfulfilled: string[];
  /** 需求特别大、包规格又多，单色组合的搜索被收窄过的色号：这些色号的结果不保证是最省的 */
  narrowed?: string[];
};

/** 同一份采购清单在各个卖家那里的最低总价，从低到高；供不齐的排在后面。 */
export function compareSellers(need: Counts, demand: Counts, sellers: Seller[], price1200 = DEFAULT_PRICE_1200, prefer: PurchasePrefer = "balanced"): SellerQuote[] {
  const quotes = sellers.map((seller) => {
    const plans = buildPurchasePlans(need, demand, price1200, prefer, seller);
    const best = plans.find((p) => p.cheapest) ?? plans[0];
    const recommended = plans.find((p) => p.recommended) ?? best;
    const narrowed = narrowedCodes(need, seller);
    return { seller, best, recommended, total: best.totalCost, unfulfilled: best.unfulfilled ?? [], ...(narrowed.length ? { narrowed } : {}) };
  });
  return quotes.sort((a, b) => (a.unfulfilled.length - b.unfulfilled.length) || (a.total - b.total) || a.seller.name.localeCompare(b.seller.name));
}

export type SupplementRow = {
  code: string;
  packs: number;
  /** 这一规格买到的颗数 */
  beads: number;
  /** 该色号需要补的缺口（扣掉套装后） */
  need: number;
  /** 该色号补充包买到的总颗数 */
  bought: number;
  /** 该色号补充包买到的 − 需要；分多种规格时只在第一行显示 */
  surplus: number;
  /** 这一行（该规格）的小计 */
  cost: number;
  /** 该色号在多个规格里，这一行不是第一行 */
  continued: boolean;
};

export type SupplementGroup = {
  /** 规格 id：默认卖家是 p4000 / p1200 / p500，其他卖家是各自的包 id */
  size: string;
  beadsPerPack: number;
  packs: number;
  cost: number;
  rows: SupplementRow[];
  /** 带“最少包数”限制的规格 */
  minPacks?: number;
};

const SIZE_ORDER: PackId[] = ["p4000", "p1200", "p500"];

/** 把方案的补充包按规格分组（4000 → 1200 → 500），组内按色号排序。 */
function groupFromLines(plan: Pick<PurchasePlan, "items">): SupplementGroup[] {
  const sizes = new Map<string, PackLine>();
  for (const item of plan.items) for (const l of item.lines ?? []) if (l.n > 0 && !sizes.has(l.id)) sizes.set(l.id, l);
  const groups: SupplementGroup[] = [];
  for (const head of [...sizes.values()].sort((a, b) => b.beads - a.beads)) {
    const rows: SupplementRow[] = [];
    for (const item of [...plan.items].sort((a, b) => compareCodes(a.code, b.code))) {
      const line = item.lines?.find((l) => l.id === head.id);
      if (!line || line.n <= 0) continue;
      const first = item.lines!.find((l) => l.n > 0)!.id === head.id;
      rows.push({
        code: item.code, packs: line.n, beads: line.n * line.beads, need: item.remaining, bought: item.singlesBeads,
        surplus: item.singlesBeads - item.remaining, cost: line.n * line.price, continued: !first
      });
    }
    groups.push({ size: head.id, beadsPerPack: head.beads, packs: rows.reduce((s, r) => s + r.packs, 0), cost: rows.reduce((s, r) => s + r.cost, 0), rows, ...(head.minPacks ? { minPacks: head.minPacks } : {}) });
  }
  return groups;
}

export function groupSupplements(plan: Pick<PurchasePlan, "items">, price1200 = DEFAULT_PRICE_1200): SupplementGroup[] {
  // 方案条目带 lines（任意规格）就按 lines 分组；只有 packs 的老数据走下面的三规格路径
  if (plan.items.some((item) => item.lines)) return groupFromLines(plan);
  const groups: SupplementGroup[] = [];
  for (const size of SIZE_ORDER) {
    const rows: SupplementRow[] = [];
    for (const item of [...plan.items].sort((a, b) => compareCodes(a.code, b.code))) {
      const n = item.packs[size];
      if (!n) continue;
      const first = SIZE_ORDER.find((id) => item.packs[id] > 0) === size;
      rows.push({
        code: item.code, packs: n, beads: n * PACK_BEADS[size], need: item.remaining, bought: item.singlesBeads,
        surplus: item.singlesBeads - item.remaining, cost: n * packPrice(size, price1200), continued: !first
      });
    }
    if (rows.length) groups.push({ size, beadsPerPack: PACK_BEADS[size], packs: rows.reduce((s, r) => s + r.packs, 0), cost: rows.reduce((s, r) => s + r.cost, 0), rows, ...(size === "p500" ? { minPacks: MIN_PACKS_500 } : {}) });
  }
  return groups;
}

/** 给卖家看的纯文本：按规格分组，例如 “4000颗装：A1×1、H7×2”。 */
export function formatPurchaseText(plan: Pick<PurchasePlan, "items" | "setOffer">, price1200 = DEFAULT_PRICE_1200, sellerName?: string): string {
  const lines: string[] = [];
  if (plan.setOffer) lines.push(`套装：${plan.setOffer.name.replace(/（.*?）/g, "")}×1`);
  for (const group of groupSupplements(plan, price1200)) {
    const head = group.minPacks ? `${group.beadsPerPack}颗装（共${group.packs}包）` : `${group.beadsPerPack}颗装`;
    lines.push(`${head}：${group.rows.map((r) => `${r.code}×${r.packs}`).join("、")}`);
  }
  if (!lines.length) return "无需补充包";
  if (sellerName?.trim()) lines.unshift(`卖家：${sellerName.trim()}`);
  return lines.join("\n");
}

/** 把方案写回采购清单：每个色号买到的总颗数（套装 1200 + 补充包）。 */
export function applyPlanToEdits(plan: PurchasePlan): Record<string, number> {
  const edits: Record<string, number> = {};
  for (const item of plan.items) if (item.totalBeads > 0) edits[item.code] = item.totalBeads;
  return edits;
}

/**
 * 当前清单（每色数量）按真实报价履行的成本估算（同样遵守“最少包数”规则，如 500 颗装满 10 包）。
 * 不含运费（cost 是商品金额）；seller 不传就用当前选中的卖家，选中默认卖家时 price1200 是 1200 颗装单价。
 */
export function estimateCostForRows(rows: Array<{ code: string; qty: number }>, price1200 = DEFAULT_PRICE_1200, seller?: Seller): { cost: number; beads: number; packs: PackCounts; lines: PackLine[] } {
  const sel = withPrice1200(seller ?? activeSeller(), price1200);
  const valid = rows.filter((row) => row.qty > 0);
  const slots = valid.map((row) => ({ code: row.code, need: row.qty, lines: optimizeWithOffers(row.qty, row.code, sel.packs).lines }));
  const fixed = enforceMinPacks(slots, sel.packs);
  const merged = new Map<string, PackLine>();
  for (const ls of fixed) for (const l of ls) merged.set(l.id, { ...l, n: (merged.get(l.id)?.n ?? 0) + l.n });
  const lines = [...merged.values()].filter((l) => l.n > 0).sort((a, b) => b.beads - a.beads);
  return { cost: linesCost(lines), beads: linesBeads(lines), packs: countsOfLines(lines), lines };
}

// ---------- 任意规格的包数文字 / 运费说明 / 搜索收窄提示（采购清单、采购方案共用） ----------

/** “2×4000 + 3×1200”；没有包返回“—”。规格从大到小，默认卖家的文字与 formatPacks 完全一样。 */
export function formatPackLines(lines: PackLine[]): string {
  const parts = [...lines].filter((l) => l.n > 0).sort((a, b) => b.beads - a.beads || a.price - b.price).map((l) => `${l.n}×${l.beads}`);
  return parts.length ? parts.join(" + ") : "—";
}

/** 把几组包数按（规格 + 价格）加起来，从大到小。 */
export function mergePackLines(...lists: PackLine[][]): PackLine[] {
  const merged = new Map<string, PackLine>();
  for (const list of lists) for (const l of list) {
    const key = `${l.id}|${l.beads}|${l.price}`;
    const cur = merged.get(key);
    merged.set(key, cur ? { ...cur, n: cur.n + l.n } : { ...l });
  }
  return [...merged.values()].filter((l) => l.n > 0).sort((a, b) => b.beads - a.beads || a.price - b.price);
}

/** 一个方案里所有色号补充包的包数（任意规格）。 */
export function planPackLines(plan: Pick<PurchasePlan, "items">): PackLine[] {
  return mergePackLines(...plan.items.map((i) => i.lines ?? []));
}

/** 方案的补充包文字；旧数据没有 lines 时退回 4000/1200/500 三格。 */
export function formatPlanPacks(plan: Pick<PurchasePlan, "items" | "packs">): string {
  const lines = planPackLines(plan);
  return lines.length ? formatPackLines(lines) : formatPacks(plan.packs);
}

export type ShipNote = { shipping: number; gap: number; total: number; text: string };
/** 商品金额 goods 在这个卖家下的运费、还差多少包邮、总价和一句说明（没有运费也没有门槛时 text 为空）。 */
export function shipNote(seller: Pick<Seller, "shipping" | "freeShipping">, goods: number): ShipNote {
  const shipping = shippingFor(seller, goods);
  const gap = freeShippingGap(seller, goods);
  let text = "";
  if (shipping > 0) text = `运费 ${formatMoney(shipping)}${gap > 0 ? `，再买 ${formatMoney(gap)} 包邮` : ""}`;
  else if (seller.shipping > 0 && goods > 0) text = "已达包邮门槛，不收运费";
  return { shipping, gap, total: Math.round((goods + shipping) * 100) / 100, text };
}

/** 这个色号的单色组合搜索会不会被收窄（需求特别大、包规格多时）；收窄后结果不保证最省。 */
export function searchNarrowed(x: number, code: string, offers: SellerPack[]): boolean {
  const need = Math.max(0, Math.round(Number.isFinite(x) ? x : 0));
  const list = sortOffers(offers.filter((o) => o.scope !== "A-M" || isAM(code)));
  if (need <= 0 || list.length < 2) return false;
  let combos = 1;
  for (let i = 0; i < list.length - 1; i++) combos *= Math.ceil(need / list[i].beads) + 1;
  return combos > COMBO_LIMIT;
}

export function narrowedCodes(need: Counts, seller: Pick<Seller, "packs">): string[] {
  return Object.keys(need).filter((code) => searchNarrowed(need[code] ?? 0, code, seller.packs)).sort(compareCodes);
}

/** 下单快照在多少天内默认用于入库。 */
export const ORDER_FRESH_DAYS = 60;

/** 复制采购文本时生成快照：只留数量 > 0 的色号，按色号排序。 */
export function makeOrderSnapshot(items: Array<{ code: string; qty: number }>, opts: { planId?: string; cost?: number; now?: number } = {}): LastOrder {
  const merged = new Map<string, number>();
  for (const it of items) {
    const qty = Math.round(Number.isFinite(it.qty) ? it.qty : 0);
    if (qty > 0) merged.set(it.code, (merged.get(it.code) ?? 0) + qty);
  }
  const out: LastOrder = {
    at: opts.now ?? Date.now(),
    items: [...merged].map(([code, qty]) => ({ code, qty })).sort((a, b) => compareCodes(a.code, b.code))
  };
  if (opts.planId) out.planId = opts.planId;
  if (opts.cost !== undefined && Number.isFinite(opts.cost)) out.cost = Math.round(opts.cost * 100) / 100;
  return out;
}

/** 还没入过库的快照；没有、已入库或没有色号都返回 null。 */
export function pendingOrder(order: LastOrder | undefined | null): LastOrder | null {
  return order && !order.receivedAt && order.items?.length ? order : null;
}

/** 入库时默认采用快照：未入库且不超过 60 天。 */
export function orderIsFresh(order: LastOrder, now = Date.now()): boolean {
  return now - order.at < ORDER_FRESH_DAYS * 86_400_000;
}

export function orderSummary(order: Pick<LastOrder, "items">): { colors: number; beads: number } {
  return { colors: order.items.length, beads: order.items.reduce((sum, it) => sum + it.qty, 0) };
}

/** MM-DD（本地时间）。 */
export function formatMD(at: number): string {
  const d = new Date(at);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 下一次保存偏好用的 updatedAt：保证严格大于上一次，避免同步时被旧记录覆盖。 */
export function nextStamp(prev: number, now = Date.now()): number {
  return Math.max(now, (Number.isFinite(prev) ? prev : 0) + 1);
}
