// 库存相关页面用的纯函数：粘贴解析、流水分组、采购文本、入库流水生成。不碰存储，便于测试。
import type { Counts, Pattern, Txn, TxnKind } from "./model";
import { uid } from "./model";

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
  | { type: "txns"; key: string; at: number; kind: TxnKind | "mixed"; note: string; txns: Txn[]; delta: number; codes: number }
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

export type LedgerFilter = { kinds?: Array<TxnKind | "pattern">; code?: string };

export function groupLedger(txns: Txn[], patterns: Pattern[], filter: LedgerFilter = {}, now = Date.now()): LedgerDay[] {
  const kinds = filter.kinds && filter.kinds.length ? new Set(filter.kinds) : null;
  const code = filter.code?.trim().toUpperCase();
  const byKey = new Map<string, Txn[]>();
  for (const txn of txns) {
    if (txn.deleted) continue;
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
      note, txns: list, delta: list.reduce((a, t) => a + t.delta, 0), codes: new Set(list.map((t) => t.code)).size
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
