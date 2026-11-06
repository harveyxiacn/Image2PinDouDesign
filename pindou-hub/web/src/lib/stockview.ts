// 库存相关页面用的纯函数：粘贴解析、流水分组、采购文本、入库流水生成。不碰存储，便于测试。
import type { Counts, Pattern, Txn, TxnKind } from "./model";
import { totalOf, uid } from "./model";
import type { PatternStatus } from "./model";
import { compareCodes } from "./inventory";

export type Normalizer = (input: string) => string | null;

// ---------- 粘贴解析：“A1 1000, B3×500\nH7=2000” ----------
export type ParsedRow = { code: string; qty: number };
export type ParseResult = { rows: ParsedRow[]; errors: string[] };

const ENTRY = /([A-Za-z]{1,2}\s*\d{1,2})\s*[x×*:=：]?\s*(\d{1,7})/g;

/** 解析粘贴文本。重复色号数量相加；认不出的色号放进 errors（原样文本）。 */
export function parseBatchText(input: string, normalize: Normalizer): ParseResult {
  const text = input.normalize("NFKC").replace(/[，；、;]/g, ",").replace(/(?<![A-Za-z\d])(\d{1,3}),(\d{3})(?!\d)/g, "$1$2");
  const map = new Map<string, number>();
  const errors: string[] = [];
  let covered = text;
  for (const match of text.matchAll(ENTRY)) {
    covered = covered.replace(match[0], " ");
    const code = normalize(match[1]);
    const qty = Number(match[2]);
    if (!code) { errors.push(match[1].replace(/\s+/g, "").toUpperCase()); continue; }
    if (!(qty > 0)) continue;
    map.set(code, (map.get(code) ?? 0) + qty);
  }
  // 剩下带字母/数字的零碎也提示（例如只有色号没有数量）
  for (const leftover of covered.split(/[\s,]+/)) {
    if (/[A-Za-z0-9]/.test(leftover) && !errors.includes(leftover.toUpperCase())) errors.push(leftover.toUpperCase());
  }
  return { rows: [...map].map(([code, qty]) => ({ code, qty })), errors };
}

// ---------- 入库流水 ----------
export type PurchaseOpts = { device: string; note?: string; totalPrice?: number; at?: number; batchId?: string };

/** 一批入库 → 同一 batchId 的 purchase 流水；填了总价则按颗数均摊成单价。 */
export function purchaseTxns(rows: ParsedRow[], opts: PurchaseOpts): Txn[] {
  const at = opts.at ?? Date.now();
  const batchId = opts.batchId ?? uid("b");
  const valid = rows.filter((r) => r.qty > 0);
  const sum = valid.reduce((a, r) => a + r.qty, 0);
  const unit = opts.totalPrice && opts.totalPrice > 0 && sum > 0 ? Math.round((opts.totalPrice / sum) * 100000) / 100000 : undefined;
  return valid.map((r) => ({
    id: uid("t"), code: r.code, delta: Math.round(r.qty), kind: "purchase" as const, batchId,
    unitPrice: unit, note: opts.note?.trim() || undefined, device: opts.device, at, updatedAt: at
  }));
}

// ---------- 采购文本 ----------
export function shareText(rows: Array<{ code: string; qty: number }>, brand = "MARD"): string {
  const list = rows.filter((r) => r.qty > 0);
  if (!list.length) return `${brand} 拼豆采购：无`;
  const total = list.reduce((a, r) => a + r.qty, 0);
  return `${brand} 拼豆采购：${list.map((r) => `${r.code}×${r.qty}`).join("、")} 共 ${list.length} 色 ${total} 颗`;
}

// ---------- 色号 / 豆盒 ----------
export function seriesOf(code: string): string {
  return /^[A-Z]+/.exec(code)?.[0] ?? "";
}

export type StockLevel = "empty" | "low" | "ok";
export function levelOf(have: number, floor: number): StockLevel {
  if (have <= 0) return "empty";
  return floor > 0 && have < floor ? "low" : "ok";
}

/** 条形 meter 填充比例：以最低库存的 2 倍为满格。 */
export function meterRatio(have: number, floor: number): number {
  const full = Math.max(1, floor * 2);
  return Math.max(0, Math.min(1, have / full));
}

export function matchesQuery(code: string, nameZh: string | undefined, query: string): boolean {
  const q = query.normalize("NFKC").trim().toUpperCase();
  if (!q) return true;
  return code.toUpperCase().includes(q) || (nameZh ?? "").toUpperCase().includes(q);
}

// ---------- 记录分组：按天 → 按批次 ----------
export type LedgerGroup =
  | { type: "txns"; key: string; at: number; kind: TxnKind | "mixed"; note: string; txns: Txn[]; delta: number; codes: number; undone?: boolean }
  | { type: "pattern"; key: string; at: number; pattern: Pattern };
export type LedgerDay = { day: string; label: string; groups: LedgerGroup[] };

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function dayLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const diff = Math.round((new Date(dayKey(now)).getTime() - new Date(dayKey(ms)).getTime()) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  const w = "日一二三四五六"[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日 周${w}`;
}

/** reveal：刚撤销（已软删除）但仍要留在原位显示“已撤销 · 恢复”的流水 id。 */
export type LedgerFilter = { kinds?: Array<TxnKind | "pattern">; code?: string; reveal?: Set<string> };

export function groupLedger(txns: Txn[], patterns: Pattern[], filter: LedgerFilter = {}, now = Date.now()): LedgerDay[] {
  const kinds = filter.kinds && filter.kinds.length ? new Set(filter.kinds) : null;
  const code = filter.code?.trim().toUpperCase();
  const byKey = new Map<string, Txn[]>();
  for (const txn of txns) {
    if (txn.deleted && !filter.reveal?.has(txn.id)) continue;
    if (kinds && !kinds.has(txn.kind)) continue;
    // 批次按“批次号”聚合；无批次号的单条流水各自成组
    const key = txn.batchId ? `b:${txn.batchId}` : `t:${txn.id}`;
    const list = byKey.get(key);
    if (list) list.push(txn); else byKey.set(key, [txn]);
  }
  const groups: LedgerGroup[] = [];
  for (const [key, list] of byKey) {
    if (code && !list.some((t) => t.code.toUpperCase() === code)) continue;
    list.sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
    const kindSet = new Set(list.map((t) => t.kind));
    const note = list.find((t) => t.note)?.note ?? "";
    groups.push({
      type: "txns", key, at: Math.max(...list.map((t) => t.at)), kind: kindSet.size === 1 ? list[0].kind : "mixed",
      note, txns: list, delta: list.reduce((a, t) => a + t.delta, 0), codes: new Set(list.map((t) => t.code)).size,
      undone: list.every((t) => t.deleted) || undefined
    });
  }
  if (!code && (!kinds || kinds.has("pattern"))) {
    for (const p of patterns) if (!p.deleted) groups.push({ type: "pattern", key: `p:${p.id}`, at: p.createdAt, pattern: p });
  }
  groups.sort((a, b) => b.at - a.at);
  const days: LedgerDay[] = [];
  for (const g of groups) {
    const k = dayKey(g.at);
    let day = days[days.length - 1];
    if (!day || day.day !== k) { day = { day: k, label: dayLabel(g.at, now), groups: [] }; days.push(day); }
    day.groups.push(g);
  }
  return days;
}

/** 截取最多 limit 个分组（跨天），保留天的结构。 */
export function limitGroups(days: LedgerDay[], limit: number): { days: LedgerDay[]; total: number; shown: number } {
  let left = limit;
  let total = 0;
  const out: LedgerDay[] = [];
  for (const d of days) {
    total += d.groups.length;
    if (left <= 0) continue;
    const groups = d.groups.slice(0, left);
    left -= groups.length;
    out.push({ ...d, groups });
  }
  return { days: out, total, shown: out.reduce((a, d) => a + d.groups.length, 0) };
}

export function txnsToCsvRows(txns: Txn[]): Array<Record<string, string | number>> {
  const label: Record<TxnKind, string> = { purchase: "入库", consume: "消耗", adjust: "调整", stocktake: "盘点" };
  return txns.filter((t) => !t.deleted).sort((a, b) => b.at - a.at).map((t) => ({
    time: new Date(t.at).toLocaleString("zh-CN", { hour12: false }), code: t.code, delta: t.delta, kind: label[t.kind],
    unitPrice: t.unitPrice ?? "", note: t.note ?? "", batch: t.batchId ?? ""
  }));
}

// ---------- 备份导入：只收比本地新的 ----------
export type BackupRecord = { collection: string; id: string; data: unknown; updatedAt: number; deleted?: boolean };
export function parseBackup(text: string): BackupRecord[] | null {
  try {
    const raw = JSON.parse(text);
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.records) ? raw.records : null;
    if (!list) return null;
    return list.filter((r: BackupRecord) => r && typeof r.id === "string" && typeof r.collection === "string" && r.data && typeof r.updatedAt === "number");
  } catch { return null; }
}

/** 计划需要但库存不足的色号集合 */
export function shortCodes(demand: Counts, stock: Counts): Set<string> {
  const out = new Set<string>();
  for (const [code, need] of Object.entries(demand)) if (need > Math.max(0, stock[code] ?? 0)) out.add(code);
  return out;
}


// ---------- 合集（按标签分组） ----------
export type Collection = {
  /** 标签；"" 表示未分组 */
  tag: string;
  patterns: Pattern[];
  count: number;
  /** 整套所有图纸用豆合计（每份用量 × 份数） */
  totalBeads: number;
  /** 整套用到的不同色号数 */
  colors: number;
  /** 未完成的图纸整套做完时，库存不够的色号数 */
  missingColors: number;
  /** 上述缺口合计颗数 */
  shortBeads: number;
  /** 已在“计划拼 / 制作中”的图纸数 */
  plannedCount: number;
  /** 库存覆盖整套需求的比例 0–1 */
  coverage: number;
};

export const UNTAGGED = "";

function patternWeight(p: Pattern): Counts {
  const copies = Math.max(1, p.copies || 1);
  const out: Counts = {};
  for (const [code, n] of Object.entries(p.counts)) if (n > 0) out[code] = n * copies;
  return out;
}

/** 按标签分合集。一张图纸有几个标签就出现在几个合集里；没有标签的归 "" 合集（includeUntagged 时放最后）。 */
export function collectionsByTag(patterns: Pattern[], stock: Counts, includeUntagged = false): Collection[] {
  const groups = new Map<string, Pattern[]>();
  for (const p of patterns) {
    if (p.deleted) continue;
    const tags = p.tags.length ? p.tags : [UNTAGGED];
    for (const t of tags) {
      if (t === UNTAGGED && !includeUntagged) continue;
      const list = groups.get(t);
      if (list) list.push(p); else groups.set(t, [p]);
    }
  }
  const out: Collection[] = [];
  for (const [tag, list] of groups) {
    const demand: Counts = {};
    const all = new Set<string>();
    let totalBeads = 0;
    for (const p of list) {
      const w = patternWeight(p);
      totalBeads += Object.values(w).reduce((a, v) => a + v, 0);
      for (const code of Object.keys(w)) all.add(code);
      if (p.status === "done" || p.consumed) continue;
      for (const [code, n] of Object.entries(w)) demand[code] = (demand[code] ?? 0) + n;
    }
    let missingColors = 0, shortBeads = 0, need = 0, covered = 0;
    for (const [code, n] of Object.entries(demand)) {
      const have = Math.max(0, stock[code] ?? 0);
      need += n; covered += Math.min(have, n);
      if (n > have) { missingColors++; shortBeads += n - have; }
    }
    out.push({
      tag, patterns: list, count: list.length, totalBeads, colors: all.size, missingColors, shortBeads,
      plannedCount: list.filter((p) => p.status === "planned" || p.status === "making").length,
      coverage: need > 0 ? covered / need : 1
    });
  }
  return out.sort((a, b) => (a.tag === UNTAGGED ? 1 : b.tag === UNTAGGED ? -1 : b.count - a.count || a.tag.localeCompare(b.tag, "zh")));
}

// ---------- 色号用量：需求 vs 库存 ----------
export type UsageRow = { code: string; need: number; have: number; /** 缺口 */ short: number; /** 库存已覆盖的部分 */ covered: number };
export type Usage = { rows: UsageRow[]; rest: { codes: number; need: number; short: number }; max: number; totalCodes: number };

/** 需求最多的前 n 个色号，附库存与缺口；其余折叠成 rest。 */
export function topUsage(demand: Counts, stock: Counts, n = 10): Usage {
  const all: UsageRow[] = Object.entries(demand).filter(([, need]) => need > 0).map(([code, need]) => {
    const have = Math.max(0, stock[code] ?? 0);
    return { code, need, have, short: Math.max(0, need - have), covered: Math.min(need, have) };
  }).sort((a, b) => b.need - a.need || compareCodes(a.code, b.code));
  const rows = all.slice(0, Math.max(0, n));
  const rest = all.slice(rows.length);
  return {
    rows, max: rows.reduce((m, r) => Math.max(m, r.need, r.have), 0), totalCodes: all.length,
    rest: { codes: rest.length, need: rest.reduce((a, r) => a + r.need, 0), short: rest.reduce((a, r) => a + r.short, 0) }
  };
}

// ---------- 批量编辑（纯函数，返回新对象；updatedAt 保证大于旧值） ----------
function stamp(p: Pattern, now: number): number { return Math.max(now, p.updatedAt + 1); }
export function withStatus(p: Pattern, status: PatternStatus, now = Date.now()): Pattern {
  return p.status === status ? p : { ...p, status, updatedAt: stamp(p, now) };
}
export function withTag(p: Pattern, tag: string, now = Date.now()): Pattern {
  const t = tag.trim();
  return !t || p.tags.includes(t) ? p : { ...p, tags: [...p.tags, t], updatedAt: stamp(p, now) };
}
/** 顺序列表中 a、b 两项之间（含）的 id，Shift+点击范围选择用。 */
export function rangeIds(order: string[], a: string, b: string): string[] {
  const i = order.indexOf(a), j = order.indexOf(b);
  if (i < 0 || j < 0) return j >= 0 ? [order[j]] : [];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}
/** “只算某个标签”：返回要排除的图纸 id（不带该标签的）。 */
export function excludeForTag(patterns: Pattern[], tag: string): Set<string> {
  return new Set(tag ? patterns.filter((p) => !p.tags.includes(tag)).map((p) => p.id) : []);
}
/** 一个合集里要“整套加入计划”的图纸：还没在计划里、也没完成的。 */
export function planCandidates(patterns: Pattern[]): Pattern[] {
  return patterns.filter((p) => !p.deleted && p.status === "idea" && !p.consumed && totalOf(p.counts) > 0);
}
