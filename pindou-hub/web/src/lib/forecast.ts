// 补货预告的纯计算：不碰存储、不依赖 React。
// 口径：需求 = 计划拼 / 制作中的图纸（份数 × 每份用量 × (1 + 损耗) 向上取整）；
// 在途 = 已下单还没入库的数量；消耗速度 = 最近 6 个 30 天窗口里 consume 流水的加权平均（越近权重越大）。
import type { Counts, Pattern, SharedPrefs, Txn } from "./model";
import { compareCodes, isActive, withLoss } from "./inventory";
import {
  DEFAULT_PRICE_1200, enforce500Min, formatMoney, formatPurchaseText, optimizePacks, packBeads, packCost, pendingOrder,
  type PackCounts
} from "./purchase";

export type Horizon = 1 | 2 | 3;
export type ForecastStatus = "now" | "plan" | "soon" | "ok";

export const STATUS_TEXT: Record<ForecastStatus, string> = { now: "现在就缺", plan: "拼完计划后不够", soon: "快用完", ok: "够用" };

const DAY = 86_400_000;
/** 一个“月”按 30 天算，避免日历月长短不一。 */
export const MONTH_MS = 30 * DAY;
/** 最多看最近几个月的消耗。 */
export const RATE_MONTHS = 6;
/** 消耗记录少于这个次数（按“一次完成图纸”计）就不估速度。 */
export const MIN_CONSUME_EVENTS = 3;

export type ConsumeRates = {
  /** 每个色号每月平均消耗（颗）；记录太少时为空对象 */
  perMonth: Counts;
  /** 参与统计的窗口数（1–6） */
  months: number;
  /** 不同的“消耗事件”数（按批次 / 图纸 / 流水去重） */
  events: number;
  /** 记录太少，不估速度 */
  thin: boolean;
};

/**
 * 加权月均消耗。窗口 i（0 = 最近 30 天）权重 = 窗口数 − i。
 * 窗口数 = 第一条消耗记录距今多少个 30 天（向上取整，1–6）：开始记录之前的月份不算 0。
 * 消耗事件少于 MIN_CONSUME_EVENTS 时不估速度（thin = true，perMonth 为空）。
 */
export function consumeRates(txns: Txn[], now = Date.now()): ConsumeRates {
  const rows = txns.filter((t) => !t.deleted && t.kind === "consume" && t.delta < 0 && t.at <= now);
  const events = new Set(rows.map((t) => t.batchId ?? t.patternId ?? t.id)).size;
  if (!rows.length) return { perMonth: {}, months: 0, events: 0, thin: true };
  const first = Math.min(...rows.map((t) => t.at));
  const months = Math.min(RATE_MONTHS, Math.max(1, Math.ceil((now - first) / MONTH_MS)));
  if (events < MIN_CONSUME_EVENTS) return { perMonth: {}, months, events, thin: true };
  const weightSum = (months * (months + 1)) / 2;
  const sums: Counts = {};
  for (const t of rows) {
    const i = Math.floor((now - t.at) / MONTH_MS);
    if (i >= months) continue;
    sums[t.code] = (sums[t.code] ?? 0) + -t.delta * (months - i);
  }
  const perMonth: Counts = {};
  for (const [code, s] of Object.entries(sums)) perMonth[code] = s / weightSum;
  return { perMonth, months, events, thin: false };
}

export type ForecastRow = {
  code: string;
  stock: number;
  /** 已下单、还没入库的数量 */
  incoming: number;
  /** 计划图纸含损耗需求 */
  committed: number;
  /** 计划拼完后还差多少（已算上现有库存和在途） */
  shortfall: number;
  /** 拼完计划后的预计库存（可为负） */
  projected: number;
  /** 每月平均消耗；没有估计时为 0 */
  perMonth: number;
  /** 按消耗速度预计用完的时间；没有速度时为 null；已经没了 = now */
  runOutAt: number | null;
  runOutDays: number | null;
  status: ForecastStatus;
  label: string;
  /** 为覆盖计划 + 所选周期的日常消耗，至少要买的颗数（取整成包之前） */
  wanted: number;
  packs: PackCounts;
  /** 实际买到的颗数（整包） */
  buyBeads: number;
  cost: number;
};

export type ForecastResult = {
  inventoryReady: boolean;
  horizon: Horizon;
  thin: boolean;
  /** 一句话说明数据够不够 */
  basis: string;
  rates: ConsumeRates;
  /** 按紧急程度排序、需要关注的色号（够用的不在里面） */
  rows: ForecastRow[];
  okCount: number;
  totals: { colors: number; beads: number; cost: number; packs: PackCounts };
};

export const FORMULA_NOTE = "建议数量 = 计划图纸含损耗用量 + 所选周期的日常消耗 − 现有库存 − 已下单未入库，再凑成整包。日常消耗取最近 6 个月的加权平均，近期权重更大。";

/** “2×1200 + 1×500”→ 给人看的包装说明，例如 “1200颗×2 + 500颗×1”。 */
export function formatPackText(packs: PackCounts): string {
  const parts: string[] = [];
  if (packs.p4000) parts.push(`4000颗×${packs.p4000}`);
  if (packs.p1200) parts.push(`1200颗×${packs.p1200}`);
  if (packs.p500) parts.push(`500颗×${packs.p500}`);
  return parts.length ? parts.join(" + ") : "—";
}

export function horizonLabel(h: Horizon): string {
  return `${h} 个月`;
}

/** 日期 MM-DD，本地时区。 */
export function dayText(at: number): string {
  const d = new Date(at);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function statusLabel(status: ForecastStatus, runOutDays: number | null): string {
  if (status === "soon" && runOutDays != null) return `约 ${Math.max(1, Math.round(runOutDays / 7))} 周后用完`;
  return STATUS_TEXT[status];
}

/** 给每个要买的色号取整成整包，并满足“500 颗装满 10 包才能备注色号”的规则。 */
export function roundToPacks(wanted: Array<{ code: string; qty: number }>, price1200 = DEFAULT_PRICE_1200): Array<{ code: string; packs: PackCounts; beads: number; cost: number }> {
  const slots = wanted.map((w) => ({ code: w.code, need: w.qty, packs: optimizePacks(w.qty, w.code, price1200).packs }));
  const fixed = enforce500Min(slots, price1200);
  return slots.map((s, i) => ({ code: s.code, packs: fixed[i], beads: packBeads(fixed[i]), cost: packCost(fixed[i], price1200) }));
}

export type ForecastInput = {
  patterns: Pattern[];
  txns: Txn[];
  prefs: Pick<SharedPrefs, "lossRate" | "lastOrder" | "inventoryStartedAt">;
  horizon?: Horizon;
  now?: number;
  price1200?: number;
};

export function forecastNeeds(input: ForecastInput): ForecastResult {
  const now = input.now ?? Date.now();
  const horizon: Horizon = input.horizon ?? 2;
  const price1200 = input.price1200 ?? DEFAULT_PRICE_1200;
  const loss = input.prefs.lossRate;
  const live = input.txns.filter((t) => !t.deleted);
  const inventoryReady = !!input.prefs.inventoryStartedAt || live.length > 0;
  const rates = consumeRates(input.txns, now);
  const emptyPacks: PackCounts = { p4000: 0, p1200: 0, p500: 0 };
  const basis = rates.thin
    ? "消耗记录还少，暂时只按计划图纸预告"
    : `按最近 ${rates.months} 个月共 ${rates.events} 次消耗记录估算日常用量`;
  const base: ForecastResult = { inventoryReady, horizon, thin: rates.thin, basis, rates, rows: [], okCount: 0, totals: { colors: 0, beads: 0, cost: 0, packs: emptyPacks } };
  if (!inventoryReady) return base;

  const stock: Counts = {};
  const seen = new Set<string>();
  for (const t of live) {
    stock[t.code] = (stock[t.code] ?? 0) + t.delta;
    seen.add(t.code);
  }
  const raw: Counts = {};
  for (const p of input.patterns) {
    if (!isActive(p)) continue;
    const copies = Math.max(1, p.copies || 1);
    for (const [code, n] of Object.entries(p.counts)) if (n > 0) raw[code] = (raw[code] ?? 0) + n * copies;
  }
  const incoming: Counts = {};
  for (const it of pendingOrder(input.prefs.lastOrder)?.items ?? []) if (it.qty > 0) incoming[it.code] = (incoming[it.code] ?? 0) + it.qty;

  // 只看“用过 / 存过 / 计划要用”的色号；从没碰过的色号不会被当成快用完。
  const codes = new Set<string>([...seen, ...Object.keys(raw)]);
  const rows: ForecastRow[] = [];
  const wantedList: Array<{ code: string; qty: number }> = [];
  let okCount = 0;
  for (const code of codes) {
    const have = Math.max(0, stock[code] ?? 0);
    const inc = incoming[code] ?? 0;
    const committed = raw[code] ? withLoss(raw[code], loss) : 0;
    const perMonth = rates.perMonth[code] ?? 0;
    const effective = have + inc;
    const projected = effective - committed;
    const shortfall = Math.max(0, -projected);
    const runOutDays = perMonth > 0 ? Math.max(0, projected) / (perMonth / 30) : null;
    let status: ForecastStatus = "ok";
    if ((committed > 0 || perMonth > 0) && effective <= 0) status = "now";
    else if (committed > 0 && projected < 0) status = "plan";
    else if (runOutDays != null && runOutDays <= horizon * 30) status = "soon";
    const wanted = Math.max(0, Math.ceil(committed + perMonth * horizon - effective - 1e-9));
    if (status === "ok") { okCount += 1; continue; }
    const runOutAt = status === "now" ? now : runOutDays != null ? now + runOutDays * DAY : null;
    rows.push({
      code, stock: have, incoming: inc, committed, shortfall, projected, perMonth, runOutAt,
      runOutDays: status === "now" ? 0 : runOutDays, status, label: statusLabel(status, runOutDays), wanted,
      packs: emptyPacks, buyBeads: 0, cost: 0
    });
    if (wanted > 0) wantedList.push({ code, qty: wanted });
  }

  const rounded = new Map(roundToPacks(wantedList, price1200).map((r) => [r.code, r]));
  let totalPacks: PackCounts = { ...emptyPacks };
  for (const row of rows) {
    const r = rounded.get(row.code);
    if (!r) continue;
    row.packs = r.packs; row.buyBeads = r.beads; row.cost = r.cost;
    totalPacks = { p4000: totalPacks.p4000 + r.packs.p4000, p1200: totalPacks.p1200 + r.packs.p1200, p500: totalPacks.p500 + r.packs.p500 };
  }
  const order: Record<ForecastStatus, number> = { now: 0, plan: 1, soon: 2, ok: 3 };
  rows.sort((a, b) => order[a.status] - order[b.status]
    || (a.status === "soon" ? (a.runOutDays ?? 0) - (b.runOutDays ?? 0) : b.shortfall - a.shortfall)
    || compareCodes(a.code, b.code));
  base.rows = rows;
  base.okCount = okCount;
  base.totals = {
    colors: rounded.size,
    beads: packBeads(totalPacks),
    cost: packCost(totalPacks, price1200),
    packs: totalPacks
  };
  return base;
}

/** 给卖家看的纯文本（复用采购页的格式：“1200颗装：A1×2、H7×1”），没有要买的返回空串。 */
export function forecastPurchaseText(rows: ForecastRow[], price1200 = DEFAULT_PRICE_1200): string {
  const items = rows.filter((r) => r.buyBeads > 0).map((r) => ({ code: r.code, packs: r.packs, remaining: r.wanted, singlesBeads: r.buyBeads }));
  if (!items.length) return "";
  return formatPurchaseText({ items } as unknown as Parameters<typeof formatPurchaseText>[0], price1200);
}

/** 复制用的完整文字：标题 + 清单 + 合计。 */
export function forecastCopyText(result: ForecastResult, price1200 = DEFAULT_PRICE_1200): string {
  const body = forecastPurchaseText(result.rows, price1200);
  if (!body) return "";
  return [`补货清单（预计未来 ${horizonLabel(result.horizon)}）`, body, `合计约 ${result.totals.beads} 颗，${formatMoney(result.totals.cost)}`].join("\n");
}
