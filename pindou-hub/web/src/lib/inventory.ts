// 库存 / 需求 / 采购清单的纯计算，不碰存储，便于单元测试。
import type { Counts, Pattern, SharedPrefs, Txn } from "./model";
import { totalOf, uid } from "./model";

export function stockByCode(txns: Txn[]): Counts {
  const stock: Counts = {};
  for (const txn of txns) {
    if (txn.deleted) continue;
    stock[txn.code] = (stock[txn.code] ?? 0) + txn.delta;
  }
  return stock;
}

export function isActive(pattern: Pattern): boolean {
  return !pattern.deleted && !pattern.consumed && (pattern.status === "planned" || pattern.status === "making");
}

/** 计划中 / 制作中的图纸合计需求（份数 × 每份用量），已扣过库存的不重复计算。 */
export function demandByCode(patterns: Pattern[], filter: (p: Pattern) => boolean = isActive): Counts {
  const demand: Counts = {};
  for (const pattern of patterns) {
    if (!filter(pattern)) continue;
    const copies = Math.max(1, pattern.copies || 1);
    for (const [code, count] of Object.entries(pattern.counts)) {
      if (count > 0) demand[code] = (demand[code] ?? 0) + count * copies;
    }
  }
  return demand;
}

/** 含损耗向上取整。1e-9 容差避免浮点误差多买一颗：100 × (1 + 0.1) = 110.00000000000001 → 仍是 110。 */
export function withLoss(n: number, rate: number): number {
  const base = Number.isFinite(n) ? n : 0;
  const r = Math.max(0, Number.isFinite(rate) ? rate : 0);
  return Math.max(0, Math.ceil(base * (1 + r) - 1e-9));
}

/** 含损耗需求 − 现有库存（负库存按 0），扣完为 0 的色号不返回。供采购方案使用。 */
export function needAfterStock(demand: Counts, stock: Counts, lossRate: number): Counts {
  const out: Counts = {};
  const loss = Math.max(0, lossRate || 0);
  for (const [code, n] of Object.entries(demand)) {
    const left = withLoss(n, loss) - Math.max(0, stock[code] ?? 0);
    if (left > 0) out[code] = left;
  }
  return out;
}

export type ShoppingRow = {
  code: string;
  need: number;
  needWithLoss: number;
  stock: number;
  shortfall: number;
  buy: number;
  reason: "shortfall" | "low";
};

/**
 * 采购清单：需求（含损耗）减去库存得到缺口；按包装规格向上取整得到建议购买量。
 * 没有需求、但库存低于“最低库存”的常用色也列出来（补货提醒）。
 */
export function shoppingList(stock: Counts, demand: Counts, prefs: SharedPrefs, includeLowStock = true): ShoppingRow[] {
  const rows: ShoppingRow[] = [];
  const codes = new Set([...Object.keys(demand), ...(includeLowStock ? Object.keys(stock) : [])]);
  const pack = Math.max(1, Math.round(prefs.packSize || 1));
  for (const code of codes) {
    const need = demand[code] ?? 0;
    const have = stock[code] ?? 0;
    const needWithLoss = need > 0 ? withLoss(need, prefs.lossRate) : 0;
    const shortfall = Math.max(0, needWithLoss - Math.max(0, have));
    const floor = prefs.minStock[code] ?? prefs.lowStock;
    if (shortfall > 0) {
      rows.push({ code, need, needWithLoss, stock: have, shortfall, buy: Math.ceil(shortfall / pack) * pack, reason: "shortfall" });
    } else if (includeLowStock && have - needWithLoss < floor && have >= 0 && floor > 0) {
      // 已经在库存里的色号（有过流水，说明常用；用到 0 也要提醒），扣除计划用量后低于最低库存 → 补一包。
      const gap = floor - (have - needWithLoss);
      rows.push({ code, need, needWithLoss, stock: have, shortfall: 0, buy: Math.ceil(gap / pack) * pack, reason: "low" });
    }
  }
  return rows.sort((a, b) => (a.reason === b.reason ? b.shortfall - a.shortfall || compareCodes(a.code, b.code) : a.reason === "shortfall" ? -1 : 1));
}

export type Readiness = {
  /** 以当前库存能完整做出的份数 */
  makeable: number;
  missing: Array<{ code: string; need: number; have: number }>;
  coverage: number;
};

/** 一张图纸以当前库存能做几份、还差哪些色。coverage = 已有豆子能覆盖的比例。 */
export function readiness(pattern: Pattern, stock: Counts): Readiness {
  const entries = Object.entries(pattern.counts).filter(([, n]) => n > 0);
  if (!entries.length) return { makeable: 0, missing: [], coverage: 0 };
  let makeable = Infinity;
  let covered = 0;
  const missing: Readiness["missing"] = [];
  const copies = Math.max(1, pattern.copies || 1);
  for (const [code, need] of entries) {
    const have = Math.max(0, stock[code] ?? 0);
    makeable = Math.min(makeable, Math.floor(have / need));
    covered += Math.min(have, need * copies);
    if (have < need * copies) missing.push({ code, need: need * copies, have });
  }
  return {
    makeable: Number.isFinite(makeable) ? makeable : 0,
    missing: missing.sort((a, b) => b.need - b.have - (a.need - a.have)),
    coverage: covered / (totalOf(pattern.counts) * copies)
  };
}

export function consumeTxns(pattern: Pattern, device: string, at = Date.now()): Txn[] {
  const batchId = uid("b");
  const copies = Math.max(1, pattern.copies || 1);
  return Object.entries(pattern.counts)
    .filter(([, n]) => n > 0)
    .map(([code, n]) => ({
      id: uid("t"), code, delta: -n * copies, kind: "consume" as const, patternId: pattern.id, batchId,
      note: `完成「${pattern.name}」×${copies}`, device, at, updatedAt: at
    }));
}

/** 已经被退回过的扣库存流水 id（只看没被撤销的退回记录），保证同一条不会退两次。 */
export function refundedIds(txns: Txn[]): Set<string> {
  const ids = new Set<string>();
  for (const t of txns) if (!t.deleted && t.refundOf) ids.add(t.refundOf);
  return ids;
}

export type ReopenPlan = {
  /** 需要问用户：这张图纸完成时扣过库存，并且还有没退回的扣库存记录 */
  ask: boolean;
  /** 如果选“放回库存”，将被冲回的那几条扣库存流水（最近一次完成的那一批） */
  originals: Txn[];
  /** 将放回的颗数 / 色数 */
  beads: number;
  colors: number;
};

/**
 * 已完成的图纸改回收藏 / 计划拼 / 制作中时的处理方案。
 * 退回的数量取自当初真正写下的扣库存流水（不是现在的用量 × 份数），所以完成后改过用量或份数也不会错。
 * 只退“最近一次完成”的那一批；已经退过的不再退。
 */
export function planReopen(pattern: Pattern, txns: Txn[]): ReopenPlan {
  const none: ReopenPlan = { ask: false, originals: [], beads: 0, colors: 0 };
  if (pattern.status !== "done" || !pattern.consumed) return none;
  const done = refundedIds(txns);
  const mine = txns.filter((t) => !t.deleted && t.kind === "consume" && t.patternId === pattern.id && t.delta < 0 && !done.has(t.id));
  if (!mine.length) return none;
  const groups = new Map<string, Txn[]>();
  for (const t of mine) {
    const key = t.batchId ?? t.id;
    const list = groups.get(key);
    if (list) list.push(t); else groups.set(key, [t]);
  }
  let latest: Txn[] = [];
  let latestAt = -Infinity;
  for (const list of groups.values()) {
    const at = Math.max(...list.map((t) => t.at));
    if (at > latestAt) { latestAt = at; latest = list; }
  }
  return { ask: true, originals: latest, beads: latest.reduce((a, t) => a - t.delta, 0), colors: new Set(latest.map((t) => t.code)).size };
}

/**
 * 把扣掉的豆子放回库存：每条扣库存流水对应一条新的“调整”流水（+同样的数量）。
 * 旧流水不动；id 由原流水决定，两台设备同时点也只会得到同一条记录，不会退两次。
 */
export function refundTxns(originals: Txn[], pattern: Pattern, toStatus: string, device: string, at = Date.now()): Txn[] {
  if (!originals.length) return [];
  const batchId = `rb_${originals[0].batchId ?? originals[0].id}`;
  return originals.map((o) => ({
    id: `r_${o.id}`, code: o.code, delta: -o.delta, kind: "adjust" as const, patternId: pattern.id, batchId, refundOf: o.id,
    note: `退回「${pattern.name}」的扣除：改回${toStatus}，豆子放回库存`, device, at, updatedAt: at
  }));
}

/** 完成的图纸重新打开后的新记录：状态改掉，并清掉“已扣库存”标记（否则它不会出现在采购清单里）。 */
export function reopenedPattern(pattern: Pattern, status: Pattern["status"], now = Date.now()): Pattern {
  return { ...pattern, status, consumed: pattern.consumed ? false : pattern.consumed, updatedAt: Math.max(now, pattern.updatedAt + 1) };
}

/** 盘点：把实际数到的数量写成一条差额流水。 */
export function stocktakeTxn(code: string, actual: number, current: number, device: string, at = Date.now()): Txn | null {
  const delta = Math.round(actual) - Math.round(current);
  if (!delta) return null;
  return { id: uid("t"), code, delta, kind: "stocktake", note: `盘点：${current} → ${actual}`, device, at, updatedAt: at };
}

const SERIES_ORDER = ["A", "B", "C", "D", "E", "F", "G", "H", "M", "P", "Q", "R", "T", "Y", "ZG"];

/** 色号排序：系列（A–H、M、P…）优先，再按数字。 */
export function compareCodes(a: string, b: string): number {
  const pa = /^([A-Z]+)(\d+)$/.exec(a);
  const pb = /^([A-Z]+)(\d+)$/.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  const sa = SERIES_ORDER.indexOf(pa[1]);
  const sb = SERIES_ORDER.indexOf(pb[1]);
  if (sa !== sb) return (sa < 0 ? 99 : sa) - (sb < 0 ? 99 : sb);
  return Number(pa[2]) - Number(pb[2]);
}

export function countsToCsv(rows: Array<Record<string, string | number>>, columns: Array<[string, string]>): string {
  const cell = (value: string | number) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return "﻿" + [columns.map(([, label]) => cell(label)).join(","), ...rows.map((row) => columns.map(([key]) => cell(row[key])).join(","))].join("\n");
}

/**
 * 库存导出 CSV，格式与图纸工坊（根应用）的“库存 CSV”完全一致：BOM + 表头 色号,颜色,HEX,颗数 + 每行一个色号，
 * 只含库存 > 0 的色号，行尾带换行。图纸工坊的“从拼豆仓导入库存”读的就是它。
 */
export function inventoryExportCsv(stock: Counts, palette: ReadonlyArray<{ code: string; nameZh: string; hex: string }>): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = palette
    .filter((c) => (stock[c.code] ?? 0) > 0)
    .sort((a, b) => compareCodes(a.code, b.code))
    .map((c) => [c.code, c.nameZh, c.hex, String(stock[c.code])].map(cell).join(","));
  return `\uFEFF色号,颜色,HEX,颗数\n${rows.join("\n")}\n`;
}
