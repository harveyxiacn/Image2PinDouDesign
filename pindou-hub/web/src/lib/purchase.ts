// 采购方案：把用户 2026-11-06 确认过的套装/补充包报价，按当前缺口算到最小成本。
// 这里只有纯函数，页面和测试共用；数据来源是用户确认的固定报价，不依赖服务端。
import type { Counts, LastOrder } from "./model";
import { compareCodes } from "./inventory";

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

export type OptimizedPacks = {
  cost: number;
  beads: number;
  packs: PackCounts;
  /** 各规格包数，键是 p4000/p1200/p500 */
  counts: Partial<Record<PackId, number>>;
};

export type OptimizeOptions = {
  /** 是否允许 500 颗装；默认允许。500 颗装满 10 包才能备注色号，见 enforce500Min。 */
  allow500?: boolean;
  /** 在最低成本之上愿意多花的钱来换更少剩余；默认 max(¥0.30, 最低成本 × 3%)。传 0 = 纯最省钱。 */
  tolerance?: number;
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

/**
 * 某个色号买至少 x 颗（允许超买）。
 * 先找最低成本；再在“成本不超过最低成本 + 容差”的组合里选剩余最少的（剩余相同 → 包数更少）。
 * 枚举 4000/1200 的包数，500 颗装只补最少的那一部分，所以结果是精确的而不是启发式。
 */
export function optimizePacks(x: number, code: string, price1200 = DEFAULT_PRICE_1200, options: OptimizeOptions = {}): OptimizedPacks {
  const need = Math.max(0, Math.round(Number.isFinite(x) ? x : 0));
  const empty: OptimizedPacks = { cost: 0, beads: 0, packs: { p4000: 0, p1200: 0, p500: 0 }, counts: {} };
  if (need <= 0) return empty;

  const allow500 = options.allow500 !== false;
  const max4000 = isAM(code) ? Math.ceil(need / 4000) : 0;
  const max1200 = Math.ceil(need / 1200);
  const cands: Array<{ packs: PackCounts; cost: number; beads: number; count: number }> = [];
  for (let a = 0; a <= max4000; a++) {
    for (let b = 0; b <= max1200; b++) {
      const rest = need - a * 4000 - b * 1200;
      const c = rest > 0 ? (allow500 ? Math.ceil(rest / 500) : -1) : 0;
      if (c < 0) continue;
      const packs: PackCounts = { p4000: a, p1200: b, p500: c };
      cands.push({ packs, cost: packCost(packs, price1200), beads: packBeads(packs), count: a + b + c });
    }
  }
  const minCost = Math.min(...cands.map((c) => c.cost));
  const tolerance = options.tolerance ?? Math.max(0.3, minCost * 0.03);
  const pool = cands.filter((c) => c.cost <= minCost + tolerance + 1e-9);
  pool.sort((p, q) => (p.beads - q.beads) || (p.count - q.count) || (p.cost - q.cost));
  const best = pool[0];
  const counts: Partial<Record<PackId, number>> = {};
  if (best.packs.p4000) counts.p4000 = best.packs.p4000;
  if (best.packs.p1200) counts.p1200 = best.packs.p1200;
  if (best.packs.p500) counts.p500 = best.packs.p500;
  return { cost: best.cost, beads: best.beads, packs: best.packs, counts };
}

type Slot = { code: string; need: number; packs: PackCounts };

/**
 * 500 颗装规则（计划层）：整单 500 颗装总数必须 ≥ 10 包才能指定色号。
 * 总数在 1–9 包时二选一，取总价更低者（持平时取剩余更少的“不用 500 装”）：
 *   A) 用到 500 装的色号去掉 500 装重新最优化；
 *   B) 保留，并把 500 装补到 10 包（多出来的包加到已用 500 装的色号上，没有则加到第一个有需求的色号，剩余会变多）。
 * 返回与 slots 同序的新包数。
 */
export function enforce500Min(slots: Slot[], price1200 = DEFAULT_PRICE_1200): PackCounts[] {
  const out = slots.map((s) => ({ ...s.packs }));
  const total = out.reduce((sum, p) => sum + p.p500, 0);
  if (total === 0 || total >= MIN_PACKS_500) return out;

  const without = out.map((p, i) => (p.p500 > 0 ? optimizePacks(slots[i].need, slots[i].code, price1200, { allow500: false }).packs : p));
  const costA = without.reduce((sum, p) => sum + packCost(p, price1200), 0);
  const costB = out.reduce((sum, p) => sum + packCost(p, price1200), 0) + (MIN_PACKS_500 - total) * packPrice("p500");
  if (costA <= costB + 1e-9) return without;

  const target = out.findIndex((p) => p.p500 > 0);
  out[target] = { ...out[target], p500: out[target].p500 + (MIN_PACKS_500 - total) };
  return out;
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
};

function codesOf(need: Counts): string[] {
  return Object.keys(need).filter((code) => (need[code] ?? 0) > 0).sort(compareCodes);
}

function finishPlan(base: {
  id: string; name: string; setOffer?: PurchaseOffer; setPrice: number; setBeadsTotal: number;
  usableSetBeads: number; setColors?: number; coverage: number; missing: string[]; items: PurchasePlanItem[];
  note: string;
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
  return {
    ...base,
    singlesCost,
    totalCost: base.setPrice + singlesCost,
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
function itemFromPacks(code: string, need: number, demand: Counts, price1200: number, setBeads: number, covered: boolean, packs: PackCounts, appQty?: number): PurchasePlanItem {
  const remaining = appQty ?? Math.max(0, need - setBeads);
  const singlesBeads = packBeads(packs);
  return {
    code,
    net: demand[code] ?? 0,
    need,
    setCovered: covered,
    setBeads,
    remaining,
    packs,
    singlesBeads,
    singlesCost: packCost(packs, price1200),
    totalBeads: setBeads + singlesBeads,
    surplus: setBeads + singlesBeads - need,
    appQty
  };
}

type ItemSpec = { code: string; need: number; setBeads: number; covered: boolean; appQty?: number };

/** 逐色最优化后，再按计划层的 500 颗装规则整体修正。 */
function buildItems(specs: ItemSpec[], demand: Counts, price1200: number): PurchasePlanItem[] {
  const slots = specs.map((spec) => {
    const remaining = spec.appQty ?? Math.max(0, spec.need - spec.setBeads);
    return { code: spec.code, need: remaining, packs: optimizePacks(remaining, spec.code, price1200).packs };
  });
  const fixed = enforce500Min(slots, price1200);
  return specs.map((spec, i) => itemFromPacks(spec.code, spec.need, demand, price1200, spec.setBeads, spec.covered, fixed[i], spec.appQty));
}

/** 全部按单色补充包买；最稳，颜色完全可控。 */
export function planAllSingles(need: Counts, demand: Counts = need, price1200 = DEFAULT_PRICE_1200): PurchasePlan {
  const items = buildItems(codesOf(need).map((code) => ({ code, need: Math.round(need[code]), setBeads: 0, covered: false })), demand, price1200);
  return finishPlan({
    id: "plan-all-singles",
    name: "全部单色号补充",
    setPrice: 0,
    setBeadsTotal: 0,
    usableSetBeads: 0,
    coverage: items.length,
    missing: [],
    items,
    note: "最稳、囤货最少；颜色完全按 MARD 色号买。"
  });
}

/** 套装按“覆盖该色能省多少钱”排序，覆盖价值最高的 N 色。 */
function coverageForSet(need: Counts, offer: PurchaseOffer, price1200: number): { covered: Set<string>; missing: string[] } {
  const codes = codesOf(need);
  const target = Math.min(offer.colors ?? codes.length, codes.length);
  if (target >= codes.length) return { covered: new Set(codes), missing: [] };
  const beadsPerColor = offer.beadsPerColor ?? 1200;
  const values = new Map<string, number>();
  for (const code of codes) {
    const amount = Math.max(0, Math.round(need[code]));
    const base = optimizePacks(amount, code, price1200);
    const covered = optimizePacks(Math.max(0, amount - beadsPerColor), code, price1200);
    values.set(code, base.cost - covered.cost);
  }
  const sorted = [...codes].sort((a, b) => (values.get(b)! - values.get(a)!) || compareCodes(a, b));
  return { covered: new Set(sorted.slice(0, target)), missing: sorted.slice(target) };
}

/** 套装（每色 1200 颗）+ 补充包。 */
export function planWithSet(offer: PurchaseOffer, need: Counts, demand: Counts = need, price1200 = DEFAULT_PRICE_1200): PurchasePlan {
  const { covered, missing } = coverageForSet(need, offer, price1200);
  const beadsPerColor = offer.beadsPerColor ?? 1200;
  const setBeadsTotal = offer.totalBeads ?? (offer.colors ?? 0) * beadsPerColor;
  const items = buildItems(codesOf(need).map((code) => {
    const isCovered = covered.has(code);
    return { code, need: Math.round(need[code]), setBeads: isCovered ? beadsPerColor : 0, covered: isCovered };
  }), demand, price1200);
  const usableSetBeads = items.reduce((sum, item) => sum + item.setBeads, 0);
  const missingCost = items.filter((item) => !item.setCovered).reduce((sum, item) => sum + item.singlesCost, 0);
  const unusedColors = Math.max(0, (offer.colors ?? 0) - covered.size);
  const unusedBeads = Math.max(0, setBeadsTotal - usableSetBeads);
  return finishPlan({
    id: offer.id === "set-221-185" ? "plan-set221-185" : offer.id === "set-221-210" ? "plan-set221-210" : offer.id === "set-265-257" ? "plan-set265-257" : "plan-set295-352",
    name: `${offer.name} + 补充包`,
    setOffer: offer,
    setPrice: offer.price,
    setBeadsTotal,
    usableSetBeads,
    setColors: offer.colors,
    coverage: covered.size,
    missing,
    items,
    note: missing.length
      ? `${offer.id === "set-221-210" ? "同 221 色的高价版；" : ""}套装已确认可对 MARD，每色 1200 颗。缺 ${missing.length} 色，单买约 ${formatMoney(missingCost)}。`
      : unusedColors
        ? `套装覆盖全部缺口色；另有 ${unusedColors} 色用不上（${unusedBeads.toLocaleString("zh-CN")} 颗），整盒计入总颗数。`
        : "套装覆盖全部缺口色，没有用不上的颜色。"
  });
}

/** 当前 app 按 1000 颗/包取整后的清单，再用真实报价履行。 */
export function planAppCurrent(need: Counts, demand: Counts = need, price1200 = DEFAULT_PRICE_1200): PurchasePlan {
  const items = buildItems(codesOf(need).map((code) => {
    const amount = Math.max(0, Math.round(need[code]));
    return { code, need: amount, setBeads: 0, covered: false, appQty: Math.ceil(amount / 1000) * 1000 };
  }), demand, price1200);
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

/** 6 个方案，按总价从低到高，并标出 推荐 / 最省钱 / 最少浪费。 */
export function buildPurchasePlans(need: Counts, demand: Counts = need, price1200 = DEFAULT_PRICE_1200, prefer: PurchasePrefer = "balanced"): PurchasePlan[] {
  const plans = [
    planWithSet(PURCHASE_OFFERS[0], need, demand, price1200),
    planWithSet(PURCHASE_OFFERS[1], need, demand, price1200),
    planAllSingles(need, demand, price1200),
    planWithSet(PURCHASE_OFFERS[2], need, demand, price1200),
    planAppCurrent(need, demand, price1200),
    planWithSet(PURCHASE_OFFERS[3], need, demand, price1200)
  ];
  return tagPlans(plans.sort((a, b) => a.totalCost - b.totalCost || a.id.localeCompare(b.id)), prefer);
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

export type SupplementGroup = { size: PackId; beadsPerPack: number; packs: number; cost: number; rows: SupplementRow[] };

const SIZE_ORDER: PackId[] = ["p4000", "p1200", "p500"];

/** 把方案的补充包按规格分组（4000 → 1200 → 500），组内按色号排序。 */
export function groupSupplements(plan: Pick<PurchasePlan, "items">, price1200 = DEFAULT_PRICE_1200): SupplementGroup[] {
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
    if (rows.length) groups.push({ size, beadsPerPack: PACK_BEADS[size], packs: rows.reduce((s, r) => s + r.packs, 0), cost: rows.reduce((s, r) => s + r.cost, 0), rows });
  }
  return groups;
}

/** 给卖家看的纯文本：按规格分组，例如 “4000颗装：A1×1、H7×2”。 */
export function formatPurchaseText(plan: Pick<PurchasePlan, "items" | "setOffer">, price1200 = DEFAULT_PRICE_1200): string {
  const lines: string[] = [];
  if (plan.setOffer) lines.push(`套装：${plan.setOffer.name.replace(/（.*?）/g, "")}×1`);
  for (const group of groupSupplements(plan, price1200)) {
    const head = group.size === "p500" ? `${group.beadsPerPack}颗装（共${group.packs}包）` : `${group.beadsPerPack}颗装`;
    lines.push(`${head}：${group.rows.map((r) => `${r.code}×${r.packs}`).join("、")}`);
  }
  if (!lines.length) return "无需补充包";
  return lines.join("\n");
}

/** 把方案写回采购清单：每个色号买到的总颗数（套装 1200 + 补充包）。 */
export function applyPlanToEdits(plan: PurchasePlan): Record<string, number> {
  const edits: Record<string, number> = {};
  for (const item of plan.items) if (item.totalBeads > 0) edits[item.code] = item.totalBeads;
  return edits;
}

/** 当前清单（每色数量）按真实报价履行的成本估算（同样遵守 500 颗装满 10 包的规则）。 */
export function estimateCostForRows(rows: Array<{ code: string; qty: number }>, price1200 = DEFAULT_PRICE_1200): { cost: number; beads: number; packs: PackCounts } {
  const valid = rows.filter((row) => row.qty > 0);
  const slots = valid.map((row) => ({ code: row.code, need: row.qty, packs: optimizePacks(row.qty, row.code, price1200).packs }));
  const fixed = enforce500Min(slots, price1200);
  let packs: PackCounts = { p4000: 0, p1200: 0, p500: 0 };
  for (const p of fixed) packs = addPacks(packs, p);
  return { cost: packCost(packs, price1200), beads: packBeads(packs), packs };
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
