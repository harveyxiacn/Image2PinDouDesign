// 采购方案：把用户 2026-11-06 确认过的套装/补充包报价，按当前缺口算到最小成本。
// 这里只有纯函数，页面和测试共用；数据来源是用户确认的固定报价，不依赖服务端。
import type { Counts } from "./model";
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

type DpOption = { id: PackId; beads: number; price: number };

/** 某个色号买至少 x 颗的最小成本（允许超买），DP 与 2026-11-06 分析脚本同一套逻辑。 */
export function optimizePacks(x: number, code: string, price1200 = DEFAULT_PRICE_1200): OptimizedPacks {
  const need = Math.max(0, Math.round(Number.isFinite(x) ? x : 0));
  const empty: OptimizedPacks = { cost: 0, beads: 0, packs: { p4000: 0, p1200: 0, p500: 0 }, counts: {} };
  if (need <= 0) return empty;

  const opts: DpOption[] = [];
  if (isAM(code)) opts.push({ id: "p4000", beads: 4000, price: 2.17 });
  opts.push({ id: "p1200", beads: 1200, price: price1200 });
  opts.push({ id: "p500", beads: 500, price: 1 });

  const max = need + Math.max(...opts.map((o) => o.beads));
  const dp = new Float64Array(max + 1);
  dp.fill(Infinity);
  dp[0] = 0;
  const pick = new Int8Array(max + 1);
  pick.fill(-1);
  for (let i = 1; i <= max; i++) {
    for (let j = 0; j < opts.length; j++) {
      const option = opts[j];
      const previous = Math.max(0, i - option.beads);
      const value = option.price + dp[previous];
      if (value < dp[i] - 1e-9) {
        dp[i] = value;
        pick[i] = j;
      }
    }
  }

  const counts: Partial<Record<PackId, number>> = {};
  let remaining = need;
  while (remaining > 0 && pick[remaining] >= 0) {
    const option = opts[pick[remaining]];
    counts[option.id] = (counts[option.id] ?? 0) + 1;
    remaining = Math.max(0, remaining - option.beads);
  }
  const packs: PackCounts = {
    p4000: counts.p4000 ?? 0,
    p1200: counts.p1200 ?? 0,
    p500: counts.p500 ?? 0
  };
  return {
    cost: dp[need],
    beads: packs.p4000 * PACK_BEADS.p4000 + packs.p1200 * PACK_BEADS.p1200 + packs.p500 * PACK_BEADS.p500,
    packs,
    counts
  };
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
  recommended: 0 | 1 | 2;
  note: string;
};

function codesOf(need: Counts): string[] {
  return Object.keys(need).filter((code) => (need[code] ?? 0) > 0).sort(compareCodes);
}

function finishPlan(base: {
  id: string; name: string; setOffer?: PurchaseOffer; setPrice: number; setBeadsTotal: number;
  usableSetBeads: number; setColors?: number; coverage: number; missing: string[]; items: PurchasePlanItem[];
  recommended: 0 | 1 | 2; note: string;
}): PurchasePlan {
  let singlesCost = 0;
  let totalBeads = base.setBeadsTotal;
  let totalNeed = 0;
  let packs: PackCounts = { p4000: 0, p1200: 0, p500: 0 };
  for (const item of base.items) {
    singlesCost += item.singlesCost;
    totalBeads += item.singlesBeads;
    totalNeed += item.need;
    packs = addPacks(packs, item.packs);
  }
  return {
    ...base,
    singlesCost,
    totalCost: base.setPrice + singlesCost,
    totalBeads,
    surplus: totalBeads - totalNeed,
    packs,
    unusedSetBeads: Math.max(0, base.setBeadsTotal - base.usableSetBeads)
  };
}

function itemFor(code: string, need: number, demand: Counts, price1200: number, setBeads: number, covered: boolean, appQty?: number): PurchasePlanItem {
  const remaining = Math.max(0, need - setBeads);
  const result = optimizePacks(remaining, code, price1200);
  return {
    code,
    net: demand[code] ?? 0,
    need,
    setCovered: covered,
    setBeads,
    remaining,
    packs: result.packs,
    singlesBeads: result.beads,
    singlesCost: result.cost,
    totalBeads: setBeads + result.beads,
    surplus: setBeads + result.beads - need,
    appQty
  };
}

/** 全部按单色补充包买；最稳，颜色完全可控。 */
export function planAllSingles(need: Counts, demand: Counts = need, price1200 = DEFAULT_PRICE_1200): PurchasePlan {
  const items = codesOf(need).map((code) => itemFor(code, Math.round(need[code]), demand, price1200, 0, false));
  return finishPlan({
    id: "plan-all-singles",
    name: "全部单色号补充",
    setPrice: 0,
    setBeadsTotal: 0,
    usableSetBeads: 0,
    coverage: items.length,
    missing: [],
    items,
    recommended: 2,
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
  const items = codesOf(need).map((code) => {
    const isCovered = covered.has(code);
    return itemFor(code, Math.round(need[code]), demand, price1200, isCovered ? beadsPerColor : 0, isCovered);
  });
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
    recommended: offer.id === "set-221-185" ? 1 : 0,
    note: missing.length
      ? `${offer.id === "set-221-185" ? "最省钱；" : offer.id === "set-221-210" ? "同 221 色的高价版；" : ""}套装已确认可对 MARD，每色 1200 颗。缺 ${missing.length} 色，单买约 ${formatMoney(missingCost)}。`
      : unusedColors
        ? `套装覆盖全部缺口色；另有 ${unusedColors} 色用不上（${unusedBeads.toLocaleString("zh-CN")} 颗），整盒计入总颗数。`
        : "套装覆盖全部缺口色，没有用不上的颜色。"
  });
}

/** 当前 app 按 1000 颗/包取整后的清单，再用真实报价履行。 */
export function planAppCurrent(need: Counts, demand: Counts = need, price1200 = DEFAULT_PRICE_1200): PurchasePlan {
  const items = codesOf(need).map((code) => {
    const amount = Math.max(0, Math.round(need[code]));
    const appQty = Math.ceil(amount / 1000) * 1000;
    const result = optimizePacks(appQty, code, price1200);
    return {
      code,
      net: demand[code] ?? 0,
      need: amount,
      setCovered: false,
      setBeads: 0,
      remaining: appQty,
      packs: result.packs,
      singlesBeads: result.beads,
      singlesCost: result.cost,
      totalBeads: result.beads,
      surplus: result.beads - amount,
      appQty
    };
  });
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
    recommended: 0,
    note: `当前清单按 1000 颗/包取整为 ${appQtyTotal.toLocaleString("zh-CN")} 颗；用真实报价履行通常比按缺口买更贵。`
  });
}

/** 6 个方案，按总价从低到高。 */
export function buildPurchasePlans(need: Counts, demand: Counts = need, price1200 = DEFAULT_PRICE_1200): PurchasePlan[] {
  const plans = [
    planWithSet(PURCHASE_OFFERS[0], need, demand, price1200),
    planWithSet(PURCHASE_OFFERS[1], need, demand, price1200),
    planAllSingles(need, demand, price1200),
    planWithSet(PURCHASE_OFFERS[2], need, demand, price1200),
    planAppCurrent(need, demand, price1200),
    planWithSet(PURCHASE_OFFERS[3], need, demand, price1200)
  ];
  return plans.sort((a, b) => a.totalCost - b.totalCost || a.id.localeCompare(b.id));
}

/** 把方案写回采购清单：每个色号买到的总颗数（套装 1200 + 补充包）。 */
export function applyPlanToEdits(plan: PurchasePlan): Record<string, number> {
  const edits: Record<string, number> = {};
  for (const item of plan.items) if (item.totalBeads > 0) edits[item.code] = item.totalBeads;
  return edits;
}

/** 当前清单（每色数量）按真实报价履行的成本估算。 */
export function estimateCostForRows(rows: Array<{ code: string; qty: number }>, price1200 = DEFAULT_PRICE_1200): { cost: number; beads: number; packs: PackCounts } {
  let cost = 0;
  let beads = 0;
  let packs: PackCounts = { p4000: 0, p1200: 0, p500: 0 };
  for (const row of rows) {
    if (!(row.qty > 0)) continue;
    const result = optimizePacks(row.qty, row.code, price1200);
    cost += result.cost;
    beads += result.beads;
    packs = addPacks(packs, result.packs);
  }
  return { cost, beads, packs };
}
