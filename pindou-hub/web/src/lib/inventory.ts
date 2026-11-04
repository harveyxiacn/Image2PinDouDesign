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
    const needWithLoss = need > 0 ? Math.ceil(need * (1 + Math.max(0, prefs.lossRate))) : 0;
    const shortfall = Math.max(0, needWithLoss - Math.max(0, have));
    const floor = prefs.minStock[code] ?? prefs.lowStock;
    if (shortfall > 0) {
      rows.push({ code, need, needWithLoss, stock: have, shortfall, buy: Math.ceil(shortfall / pack) * pack, reason: "shortfall" });
    } else if (includeLowStock && have - needWithLoss < floor && have > 0 && floor > 0) {
      // 已经在库存里的色号（说明常用），扣除计划用量后低于最低库存 → 补一包。
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
