// 数据洞察的纯计算：不碰存储、不依赖 React，便于单元测试。
// 约定：只统计未删除的记录；需求一律“份数 × 每份用量 × (1 + 损耗)”向上取整（与采购方案口径一致）。
import { ciede2000 } from "@engine/color";
import type { Counts, Pattern, SharedPrefs, Txn } from "./model";
import { compareCodes, isActive, withLoss } from "./inventory";
import { colorOf } from "./palette";

function have(stock: Counts, code: string): number {
  return Math.max(0, stock[code] ?? 0);
}
function ratio(a: number, b: number): number {
  return b > 0 ? a / b : 0;
}

/** 活动图纸（计划拼 / 制作中、未扣库存）每个色号的含损耗需求。 */
function needByCode(patterns: Pattern[], lossRate: number): Counts {
  const raw: Counts = {};
  for (const p of patterns) {
    if (!isActive(p)) continue;
    const copies = Math.max(1, p.copies || 1);
    for (const [code, n] of Object.entries(p.counts)) if (n > 0) raw[code] = (raw[code] ?? 0) + n * copies;
  }
  const out: Counts = {};
  for (const [code, n] of Object.entries(raw)) out[code] = withLoss(n, lossRate);
  return out;
}

// ---------- 现在能拼什么 ----------
export type MissingColor = { code: string; need: number; have: number; gap: number };
export type ReadyRow = {
  id: string;
  name: string;
  copies: number;
  /** 含损耗、含份数的总颗数 */
  needed: number;
  covered: number;
  coverage: number; // 0–1
  missingColors: number;
  missingBeads: number;
  missing: MissingColor[];
  complete: boolean;
};

/** 每张活动图纸单独对照完整库存（各图不叠加占用）。没有用量的图纸不列出。最齐的排前面。 */
export function readiness(patterns: Pattern[], stock: Counts, lossRate = 0): ReadyRow[] {
  const rows: ReadyRow[] = [];
  for (const p of patterns) {
    if (!isActive(p)) continue;
    const copies = Math.max(1, p.copies || 1);
    let needed = 0;
    let covered = 0;
    const missing: MissingColor[] = [];
    for (const [code, n] of Object.entries(p.counts)) {
      if (!(n > 0)) continue;
      const need = withLoss(n * copies, lossRate);
      const h = have(stock, code);
      needed += need;
      covered += Math.min(h, need);
      if (h < need) missing.push({ code, need, have: h, gap: need - h });
    }
    if (needed <= 0) continue;
    missing.sort((a, b) => b.gap - a.gap || compareCodes(a.code, b.code));
    rows.push({
      id: p.id, name: p.name, copies, needed, covered, coverage: ratio(covered, needed),
      missingColors: missing.length, missingBeads: missing.reduce((s, m) => s + m.gap, 0), missing, complete: missing.length === 0
    });
  }
  return rows.sort((a, b) => b.coverage - a.coverage || a.missingColors - b.missingColors || a.missingBeads - b.missingBeads || a.name.localeCompare(b.name, "zh-CN"));
}

// ---------- 替代色 ----------
export type SubLabel = "几乎一样" | "很接近" | "可替代";
export type Substitute = { code: string; deltaE: number; label: SubLabel; have: number };

export function substituteLabel(deltaE: number): SubLabel | null {
  if (deltaE <= 2) return "几乎一样";
  if (deltaE <= 4) return "很接近";
  if (deltaE <= 6) return "可替代";
  return null;
}

/** 为缺的色号找库存里够用的相近色（CIEDE2000 ≤ 6），最多 limit 个；不会推荐自己。 */
export function substitutes(missingCode: string, stock: Counts, opts: { need?: number; limit?: number; maxDeltaE?: number } = {}): Substitute[] {
  const target = colorOf(missingCode);
  if (!target) return [];
  const need = Math.max(1, opts.need ?? 1);
  const limit = opts.limit ?? 3;
  const max = Math.min(6, opts.maxDeltaE ?? 6);
  const out: Substitute[] = [];
  for (const code of Object.keys(stock)) {
    if (code === missingCode) continue;
    const h = have(stock, code);
    if (h < need) continue;
    const c = colorOf(code);
    if (!c) continue;
    const d = ciede2000(target.lab, c.lab);
    const label = d <= max ? substituteLabel(d) : null;
    if (label) out.push({ code, deltaE: d, label, have: h });
  }
  return out.sort((a, b) => a.deltaE - b.deltaE || compareCodes(a.code, b.code)).slice(0, limit);
}

// ---------- 最缺的颜色 ----------
export type DemandRow = { code: string; demand: number; need: number; stock: number; gap: number; patterns: number };

/** 按缺口从大到小；缺口相同按需求，再按色号顺序。demand 为不含损耗的原始用量，need/gap 含损耗。 */
export function demandRanking(patterns: Pattern[], stock: Counts, opts: { limit?: number; lossRate?: number } = {}): DemandRow[] {
  const demand: Counts = {};
  const used: Record<string, number> = {};
  for (const p of patterns) {
    if (!isActive(p)) continue;
    const copies = Math.max(1, p.copies || 1);
    for (const [code, n] of Object.entries(p.counts)) {
      if (!(n > 0)) continue;
      demand[code] = (demand[code] ?? 0) + n * copies;
      used[code] = (used[code] ?? 0) + 1;
    }
  }
  const rows = Object.entries(demand).map(([code, d]) => {
    const need = withLoss(d, opts.lossRate ?? 0);
    const h = have(stock, code);
    return { code, demand: d, need, stock: h, gap: Math.max(0, need - h), patterns: used[code] ?? 0 };
  });
  rows.sort((a, b) => b.gap - a.gap || b.need - a.need || compareCodes(a.code, b.code));
  return opts.limit ? rows.slice(0, opts.limit) : rows;
}

// ---------- 色系 ----------
export type FamilyRow = { family: string; demand: number; stock: number; gap: number; colors: number };

export function familyOf(code: string): string {
  const m = /^([A-Z]+)\d/.exec(code);
  return m ? m[1] : "其他";
}

export function familyBreakdown(patterns: Pattern[], stock: Counts, lossRate = 0): FamilyRow[] {
  const need = needByCode(patterns, lossRate);
  const map = new Map<string, FamilyRow>();
  const row = (f: string) => {
    let r = map.get(f);
    if (!r) { r = { family: f, demand: 0, stock: 0, gap: 0, colors: 0 }; map.set(f, r); }
    return r;
  };
  for (const [code, n] of Object.entries(need)) {
    const r = row(familyOf(code));
    r.demand += n;
    r.colors += 1;
    r.gap += Math.max(0, n - have(stock, code));
  }
  for (const code of Object.keys(stock)) {
    const h = have(stock, code);
    if (h > 0) row(familyOf(code)).stock += h;
  }
  return [...map.values()].sort((a, b) => (a.family === "其他" ? 1 : b.family === "其他" ? -1 : compareCodes(`${a.family}0`, `${b.family}0`)));
}

// ---------- 库存健康 ----------
export type HealthBucket = { colors: number; beads: number };
export type StockHealth = {
  enough: HealthBucket;
  tight: HealthBucket;
  idle: HealthBucket;
  idleList: Array<{ code: string; beads: number }>;
  tightList: Array<{ code: string; stock: number; need: number }>;
};

/** need 为含损耗需求（见 demandRanking.need）。闲置 = 有库存但没有活动图纸用；吃紧 = 库存 < 需求；充足 = 库存 ≥ 需求。 */
export function stockHealth(stock: Counts, demand: Counts, prefs: Pick<SharedPrefs, "lossRate">): StockHealth {
  const out: StockHealth = {
    enough: { colors: 0, beads: 0 }, tight: { colors: 0, beads: 0 }, idle: { colors: 0, beads: 0 }, idleList: [], tightList: []
  };
  const codes = new Set([...Object.keys(stock), ...Object.keys(demand)]);
  for (const code of codes) {
    const h = have(stock, code);
    const d = demand[code] ?? 0;
    const need = d > 0 ? withLoss(d, prefs.lossRate) : 0;
    if (need > 0) {
      const b = h >= need ? out.enough : out.tight;
      b.colors += 1;
      b.beads += h;
      if (h < need) out.tightList.push({ code, stock: h, need });
    } else if (h > 0) {
      out.idle.colors += 1;
      out.idle.beads += h;
      out.idleList.push({ code, beads: h });
    }
  }
  out.idleList.sort((a, b) => b.beads - a.beads || compareCodes(a.code, b.code));
  out.tightList.sort((a, b) => b.need - b.stock - (a.need - a.stock) || compareCodes(a.code, b.code));
  return out;
}

// ---------- 进出趋势 ----------
export type MonthRow = { key: string; year: number; month: number; purchased: number; consumed: number; spent: number; completed: number };
export type Activity = { months: MonthRow[]; hasTxns: boolean; hasPrice: boolean; totalSpent: number };

export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * 最近 months 个自然月（本地时区，含当月，没有流水的月份补 0）。
 * 入库 = purchase 且 delta>0；消耗 = consume 且 delta<0；花费 = 入库颗数 × unitPrice（无单价的不计）；
 * 完成图纸数 = 当月有 consume 流水的不同 patternId（模型没有“完成时间”字段，以扣库存时间为准）。
 */
export function monthlyActivity(txns: Txn[], opts: { months?: number; now?: number } = {}): Activity {
  const n = Math.max(1, opts.months ?? 12);
  const now = new Date(opts.now ?? Date.now());
  const rows: MonthRow[] = [];
  const index = new Map<string, MonthRow>();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const r: MonthRow = { key: monthKey(d.getTime()), year: d.getFullYear(), month: d.getMonth() + 1, purchased: 0, consumed: 0, spent: 0, completed: 0 };
    rows.push(r);
    index.set(r.key, r);
  }
  const done = new Map<string, Set<string>>();
  let hasTxns = false;
  let hasPrice = false;
  for (const t of txns) {
    if (t.deleted) continue;
    hasTxns = true;
    const r = index.get(monthKey(t.at));
    if (t.kind === "purchase" && t.delta > 0) {
      if (t.unitPrice != null && t.unitPrice > 0) hasPrice = true;
      if (r) {
        r.purchased += t.delta;
        if (t.unitPrice != null && t.unitPrice > 0) r.spent += t.delta * t.unitPrice;
      }
    } else if (t.kind === "consume" && t.delta < 0 && r) {
      r.consumed += -t.delta;
      if (t.patternId) {
        const s = done.get(r.key) ?? new Set<string>();
        s.add(t.patternId);
        done.set(r.key, s);
      }
    }
  }
  for (const r of rows) r.completed = done.get(r.key)?.size ?? 0;
  return { months: rows, hasTxns, hasPrice, totalSpent: rows.reduce((s, r) => s + r.spent, 0) };
}

// ---------- 识别质量 ----------
export type Quality = {
  total: number;
  verified: number;
  unverified: number;
  /** 计划拼 / 制作中且未核对的张数 */
  activeUnverified: number;
  noConfidence: number;
  buckets: Array<{ label: string; min: number; max: number; count: number }>;
};

export function recognitionQuality(patterns: Pattern[]): Quality {
  const buckets = [
    { label: "低于 50%", min: 0, max: 0.5, count: 0 },
    { label: "50–70%", min: 0.5, max: 0.7, count: 0 },
    { label: "70–90%", min: 0.7, max: 0.9, count: 0 },
    { label: "90% 以上", min: 0.9, max: Infinity, count: 0 }
  ];
  const q: Quality = { total: 0, verified: 0, unverified: 0, activeUnverified: 0, noConfidence: 0, buckets };
  for (const p of patterns) {
    if (p.deleted) continue;
    q.total += 1;
    if (p.verifiedAt != null) q.verified += 1;
    else {
      q.unverified += 1;
      if (isActive(p)) q.activeUnverified += 1;
    }
    if (typeof p.confidence === "number" && Number.isFinite(p.confidence)) {
      const b = buckets.find((x) => p.confidence! >= x.min && p.confidence! < x.max);
      if (b) b.count += 1;
    } else q.noConfidence += 1;
  }
  return q;
}
