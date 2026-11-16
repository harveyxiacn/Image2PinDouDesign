// 完工记录的纯逻辑：条目增删、作品集清单、汇总、分组筛选，以及“真实完成日期优先、旧记录按扣库存估算”的月度完成数。
// 不碰存储、不依赖 React，时钟与 id 都可注入，便于单元测试。
import { refundedIds } from "./inventory";
import { totalOf, uid, type Pattern, type Txn, type WorkEntry } from "./model";

// ---------- 条目 ----------
export type WorkInput = { at: number; photoId?: string; note?: string; rating?: number; tag?: string; durationMs?: number };

function clean(text: string | undefined, max: number): string | undefined {
  const t = (text ?? "").trim().slice(0, max);
  return t || undefined;
}

/** 规整一条记录：去掉空白字段、评分限制在 1–5；时间无效则返回 null（旧设备或损坏数据不会让页面出错）。 */
export function sanitizeEntry(e: unknown): WorkEntry | null {
  if (!e || typeof e !== "object") return null;
  const r = e as Record<string, unknown>;
  const at = typeof r.at === "number" && Number.isFinite(r.at) && r.at > 0 ? r.at : 0;
  if (!at || typeof r.id !== "string" || !r.id) return null;
  const out: WorkEntry = { id: r.id, at };
  if (typeof r.copies === "number" && r.copies >= 1) out.copies = Math.min(99, Math.round(r.copies));
  if (typeof r.photoId === "string" && r.photoId) out.photoId = r.photoId;
  const note = clean(typeof r.note === "string" ? r.note : undefined, 500);
  if (note) out.note = note;
  if (typeof r.rating === "number" && r.rating >= 1) out.rating = Math.min(5, Math.round(r.rating));
  const tag = clean(typeof r.tag === "string" ? r.tag : undefined, 20);
  if (tag) out.tag = tag;
  if (typeof r.durationMs === "number" && r.durationMs > 0 && Number.isFinite(r.durationMs)) out.durationMs = Math.round(r.durationMs);
  return out;
}

/** 这张图纸的完工记录，新的在前。 */
export function worksOf(p: Pick<Pattern, "works">): WorkEntry[] {
  const list: WorkEntry[] = [];
  for (const raw of p.works ?? []) {
    const e = sanitizeEntry(raw);
    if (e) list.push(e);
  }
  return list.sort((a, b) => b.at - a.at);
}

/** 拼装模式如果记录了用时（毫秒）就读出来；字段由拼装模式那边决定，这里只做宽松读取。 */
export function buildDurationMs(build: unknown): number | undefined {
  if (!build || typeof build !== "object") return undefined;
  const b = build as Record<string, unknown>;
  for (const k of ["activeMs", "elapsedMs", "durationMs"]) {
    const v = b[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
  }
  return undefined;
}

export function durationLabel(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function stamp(p: Pattern, now: number): number {
  return Math.max(now, p.updatedAt + 1);
}

export function newEntry(input: WorkInput, copies: number, id = uid("w")): WorkEntry {
  const e = sanitizeEntry({ ...input, id, copies: Math.max(1, copies || 1) });
  return e ?? { id, at: 1 };
}

/** 标记完成并追加一条完工记录（已完成的再完成一次，也是追加）。 */
export function completedPattern(p: Pattern, input: WorkInput, opts: { id?: string; now?: number } = {}): Pattern {
  const now = opts.now ?? Date.now();
  const entry = newEntry(input, p.copies, opts.id);
  return { ...p, status: "done", works: [...worksOf(p), entry], updatedAt: stamp(p, now) };
}

export function withWorkPatch(p: Pattern, entryId: string, patch: Partial<Omit<WorkEntry, "id">>, now = Date.now()): Pattern {
  const list = worksOf(p).map((e) => (e.id === entryId ? sanitizeEntry({ ...e, ...patch, id: e.id }) ?? e : e));
  return { ...p, works: list, updatedAt: stamp(p, now) };
}

/** 补一条记录（旧的已完成图纸没有记录时用），不改状态。 */
export function withWorkAdded(p: Pattern, input: WorkInput, opts: { id?: string; now?: number } = {}): Pattern {
  return { ...p, works: [...worksOf(p), newEntry(input, p.copies, opts.id)], updatedAt: stamp(p, opts.now ?? Date.now()) };
}

export function withWorkRemoved(p: Pattern, entryId: string, now = Date.now()): Pattern {
  const list = worksOf(p).filter((e) => e.id !== entryId);
  return { ...p, works: list.length ? list : undefined, updatedAt: stamp(p, now) };
}

// ---------- 日期输入 ----------
const pad = (n: number) => String(n).padStart(2, "0");

/** 本地日期的 YYYY-MM-DD，给 <input type="date"> 用。 */
export function dateInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 解析日期输入：当天保留当前时刻，其他日期取当地中午；未来的日期当作现在；格式不对返回 null。 */
export function parseDateInput(text: string, now: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const at = new Date(y, mo - 1, d, 12, 0, 0, 0);
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) return null;
  if (dateInputValue(at.getTime()) === dateInputValue(now)) return now;
  return Math.min(at.getTime(), now);
}

export function monthKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// ---------- 作品集 ----------
export type WorkItem = {
  /** 稳定的列表 key：图纸 id + 条目 id（旧记录为 legacy） */
  key: string;
  patternId: string;
  entryId: string;
  name: string;
  at: number;
  /** 没有真实完成日期（来自旧记录，按扣库存时间或最后修改时间估的） */
  estimated: boolean;
  photoId?: string;
  /** 没有成品照片时用的图纸预览 / 原图 */
  fallbackId?: string;
  width?: number;
  height?: number;
  beads: number;
  copies: number;
  note?: string;
  rating?: number;
  tag?: string;
  /** 图纸标签 + 给谁了，去重 */
  tags: string[];
  durationMs?: number;
};

function legacyAt(p: Pattern, txns: Txn[], refunded: Set<string>): number {
  let best = 0;
  for (const t of txns) if (!t.deleted && t.kind === "consume" && t.delta < 0 && t.patternId === p.id && !refunded.has(t.id) && t.at > best) best = t.at;
  return best || p.updatedAt || p.createdAt || 1;
}

/** 所有完工：有记录的按记录；已完成但没有记录的旧图纸各算一件（日期估算）。新的在前。 */
export function collectWorks(patterns: Pattern[], txns: Txn[] = []): WorkItem[] {
  const refunded = refundedIds(txns);
  const items: WorkItem[] = [];
  for (const p of patterns) {
    if (p.deleted) continue;
    const unit = totalOf(p.counts);
    const base = { patternId: p.id, name: p.name, fallbackId: p.previewId ?? p.imageId, width: p.width, height: p.height };
    const entries = worksOf(p);
    if (entries.length) {
      for (const e of entries) {
        const copies = Math.max(1, e.copies ?? p.copies ?? 1);
        items.push({
          ...base, key: `${p.id}:${e.id}`, entryId: e.id, at: e.at, estimated: false, photoId: e.photoId, beads: unit * copies, copies,
          note: e.note, rating: e.rating, tag: e.tag, tags: Array.from(new Set([...p.tags, ...(e.tag ? [e.tag] : [])])), durationMs: e.durationMs
        });
      }
    } else if (p.status === "done") {
      const copies = Math.max(1, p.copies || 1);
      items.push({ ...base, key: `${p.id}:legacy`, entryId: "legacy", at: legacyAt(p, txns, refunded), estimated: true, beads: unit * copies, copies, tags: [...p.tags] });
    }
  }
  return items.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name, "zh-CN"));
}

export type WorkTotals = { pieces: number; beads: number; thisYear: number; thisYearBeads: number };

export function workTotals(items: WorkItem[], now: number): WorkTotals {
  const year = new Date(now).getFullYear();
  const t: WorkTotals = { pieces: items.length, beads: 0, thisYear: 0, thisYearBeads: 0 };
  for (const it of items) {
    t.beads += it.beads;
    if (new Date(it.at).getFullYear() === year) { t.thisYear += 1; t.thisYearBeads += it.beads; }
  }
  return t;
}

export type WorkFilter = { year?: number; month?: number; tag?: string };

export function filterWorks(items: WorkItem[], f: WorkFilter): WorkItem[] {
  return items.filter((it) => {
    const d = new Date(it.at);
    if (f.year != null && d.getFullYear() !== f.year) return false;
    if (f.month != null && d.getMonth() + 1 !== f.month) return false;
    if (f.tag && !it.tags.includes(f.tag)) return false;
    return true;
  });
}

/** 筛选项：有作品的年份（新的在前）、某年里有作品的月份、所有标签（按件数多的在前）。 */
export function filterOptions(items: WorkItem[], year?: number): { years: number[]; months: number[]; tags: string[] } {
  const years = new Set<number>();
  const months = new Set<number>();
  const tags = new Map<string, number>();
  for (const it of items) {
    const d = new Date(it.at);
    years.add(d.getFullYear());
    if (year == null || d.getFullYear() === year) months.add(d.getMonth() + 1);
    for (const t of it.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  return {
    years: [...years].sort((a, b) => b - a),
    months: [...months].sort((a, b) => b - a),
    tags: [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN")).map(([t]) => t)
  };
}

export type WorkGroup = { key: string; year: number; month: number; items: WorkItem[]; beads: number };

/** 按月分组，月份和组内都是新的在前。 */
export function groupByMonth(items: WorkItem[]): WorkGroup[] {
  const map = new Map<string, WorkGroup>();
  for (const it of [...items].sort((a, b) => b.at - a.at)) {
    const key = monthKeyOf(it.at);
    let g = map.get(key);
    if (!g) { const d = new Date(it.at); g = { key, year: d.getFullYear(), month: d.getMonth() + 1, items: [], beads: 0 }; map.set(key, g); }
    g.items.push(it);
    g.beads += it.beads;
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}

// ---------- 洞察：每月完成数 ----------
export type MonthlyDone = Record<string, { real: number; estimated: number }>;

/**
 * 每月完成件数。规则：
 * - 图纸有完工记录：按记录的日期，每条算 1 件（真实）；
 * - 图纸没有记录（旧数据）：按它没被退回的扣库存流水所在月份，每个月算 1 件（估算），与旧口径一致；
 * - 有记录的图纸（含已删除的）不再按流水估，避免同一张图重复计数。
 */
export function monthlyDone(patterns: Pattern[], txns: Txn[]): MonthlyDone {
  const out: MonthlyDone = {};
  const slot = (k: string) => (out[k] ??= { real: 0, estimated: 0 });
  const recorded = new Set<string>();
  for (const p of patterns) {
    const entries = worksOf(p);
    if (!entries.length) continue;
    recorded.add(p.id);
    if (p.deleted) continue;
    for (const e of entries) slot(monthKeyOf(e.at)).real += 1;
  }
  const refunded = refundedIds(txns);
  const seen = new Set<string>();
  for (const t of txns) {
    if (t.deleted || t.kind !== "consume" || !(t.delta < 0) || !t.patternId || refunded.has(t.id) || recorded.has(t.patternId)) continue;
    const k = monthKeyOf(t.at);
    const id = `${t.patternId}@${k}`;
    if (seen.has(id)) continue;
    seen.add(id);
    slot(k).estimated += 1;
  }
  return out;
}
