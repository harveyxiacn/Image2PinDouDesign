// 快速核对队列的纯逻辑：排序、决定与撤销、滑动判定、会话恢复。不碰 DOM / 存储，时钟由调用方传入。
import type { Pattern } from "./model";

export type Decision = "ok" | "flag" | "skip";
export type QueueOrder = "confidence" | "newest";

/** 标有问题的图纸加的标签；图库里可按它筛出来。 */
export const FLAG_TAG = "待复查";
export const REASON_MAX = 80;

export type QueueItem = Pick<Pattern, "id" | "createdAt" | "verifiedAt" | "deleted"> & { confidence?: number };

/** 一次核对会话。队列本身不存：由“范围内仍未核对、且本次还没决定的图纸”现算，所以离开再回来、别处改了数据都自然对得上。 */
export type Session = {
  order: QueueOrder;
  /** 只核对这些 id（来自图库的筛选 / 选择）；null = 全部未核对 */
  scope: string[] | null;
  decisions: Record<string, Decision>;
  /** 决定的先后顺序，撤销从末尾取 */
  history: string[];
};

export function newSession(order: QueueOrder = "confidence", scope: string[] | null = null): Session {
  return { order, scope: scope ? [...new Set(scope)] : null, decisions: {}, history: [] };
}

/** 可信度缺失（手工录入）排到最后：没有识别疑点可查，也最不急。 */
function rank(i: QueueItem): number { return typeof i.confidence === "number" && Number.isFinite(i.confidence) ? i.confidence : 2; }

/** 仍未核对的图纸，按次序排好（可信度低的优先；同分新的优先）。 */
export function orderQueue(items: QueueItem[], order: QueueOrder): string[] {
  const list = items.filter((i) => !i.deleted && i.verifiedAt == null);
  list.sort((a, b) => (order === "newest" ? b.createdAt - a.createdAt : rank(a) - rank(b) || b.createdAt - a.createdAt) || (a.id < b.id ? -1 : 1));
  return list.map((i) => i.id);
}

/** 现在还待决定的 id（按次序）。 */
export function pending(items: QueueItem[], s: Session): string[] {
  const scope = s.scope ? new Set(s.scope) : null;
  return orderQueue(items.filter((i) => (!scope || scope.has(i.id)) && !s.decisions[i.id]), s.order);
}

export function currentId(items: QueueItem[], s: Session): string | undefined { return pending(items, s)[0]; }

/** 进度：done = 本次已决定的张数，total = 已决定 + 还待决定。 */
export function progress(items: QueueItem[], s: Session): { done: number; total: number; index: number } {
  const done = s.history.length;
  const left = pending(items, s).length;
  return { done, total: done + left, index: Math.min(done + 1, done + left) };
}

export function decide(s: Session, id: string, d: Decision): Session {
  if (s.decisions[id]) return s;
  return { ...s, decisions: { ...s.decisions, [id]: d }, history: [...s.history, id] };
}

/** 撤销最近一次决定；返回被撤销的 id 与决定，调用方据此还原图纸。 */
export function undo(s: Session): { session: Session; id?: string; was?: Decision } {
  const id = s.history[s.history.length - 1];
  if (!id) return { session: s };
  const { [id]: was, ...rest } = s.decisions;
  return { session: { ...s, decisions: rest, history: s.history.slice(0, -1) }, id, was };
}

export function setOrder(s: Session, order: QueueOrder): Session { return s.order === order ? s : { ...s, order }; }

export type Summary = { ok: string[]; flag: string[]; skip: string[]; left: number };
export function summarize(items: QueueItem[], s: Session): Summary {
  const by = (d: Decision) => s.history.filter((id) => s.decisions[id] === d);
  return { ok: by("ok"), flag: by("flag"), skip: by("skip"), left: pending(items, s).length };
}

// ---- 总数核对 ----

export type TotalCheck = { value: number; same: boolean };
/** 用量合计与“格子数”“图上标注总数”的对照；没有的那项为 null（旧图纸没存标注总数，就只比格子数）。 */
export function totalChecks(used: number, gridTotal: number | null, statedTotal: unknown): { grid: TotalCheck | null; stated: TotalCheck | null } {
  const stated = typeof statedTotal === "number" && Number.isFinite(statedTotal) && statedTotal > 0 ? Math.round(statedTotal) : null;
  return {
    grid: gridTotal == null ? null : { value: gridTotal, same: gridTotal === used },
    stated: stated == null ? null : { value: stated, same: stated === used }
  };
}

// ---- 图纸改动（纯函数，调用方负责写库） ----

export function cleanReason(text: string): string { return text.replace(/\s+/g, " ").trim().slice(0, REASON_MAX); }

export function applyOk(p: Pattern, now: number): Pattern {
  const { reviewNote: _drop, ...rest } = p;
  return { ...rest, verifiedAt: now, tags: p.tags.filter((t) => t !== FLAG_TAG), updatedAt: Math.max(now, p.updatedAt + 1) };
}

export function applyFlag(p: Pattern, reason: string, now: number): Pattern {
  const note = cleanReason(reason);
  const tags = p.tags.includes(FLAG_TAG) ? p.tags : [...p.tags, FLAG_TAG];
  const next: Pattern = { ...p, tags, updatedAt: Math.max(now, p.updatedAt + 1) };
  if (note) next.reviewNote = note;
  return next;
}

/** 撤销：有原记录就整条还原（时间戳向前走，让别的设备也采纳）；没有（刷新后）就尽量反向处理。 */
export function revertDecision(current: Pattern, was: Decision, original: Pattern | undefined, now: number): Pattern | null {
  if (was === "skip") return null;
  const at = Math.max(now, current.updatedAt + 1);
  if (original) return { ...original, updatedAt: at };
  if (was === "ok") return { ...current, verifiedAt: undefined, updatedAt: at };
  const { reviewNote: _drop, ...rest } = current;
  return { ...rest, tags: current.tags.filter((t) => t !== FLAG_TAG), updatedAt: at };
}

// ---- 滑动判定 ----

export const SWIPE = { distance: 72, flickDistance: 36, flickSpeed: 0.5, ratio: 1.8, lock: 10 } as const;

/** 手势一开始往哪个方向：横向超过 lock 且明显比纵向多才算横滑；纵向多则交还给页面滚动。 */
export function swipeAxis(dx: number, dy: number): "x" | "y" | null {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < SWIPE.lock) return null;
  return ax >= ay * 1.2 ? "x" : "y";
}

/** 抬手时的结果：右滑 = 没问题，左滑 = 有问题；距离不够、太斜都不算。 */
export function swipeDecision(dx: number, dy: number, ms: number): "ok" | "flag" | null {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < ay * SWIPE.ratio) return null;
  const fast = ms > 0 && ax / ms >= SWIPE.flickSpeed && ax >= SWIPE.flickDistance;
  if (ax < SWIPE.distance && !fast) return null;
  return dx > 0 ? "ok" : "flag";
}

/** 拖动中给视觉提示用：-1（有问题）… 1（没问题），到阈值时绝对值为 1。 */
export function swipeProgress(dx: number): number { return Math.max(-1, Math.min(1, dx / SWIPE.distance)); }

// ---- 会话存取（序列化 / 校验，真正的 sessionStorage 读写在页面里） ----

export function serializeSession(s: Session): string { return JSON.stringify(s); }

export function parseSession(text: string | null | undefined): Session | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<Session>;
    if (!v || (v.order !== "confidence" && v.order !== "newest") || typeof v.decisions !== "object" || v.decisions === null || !Array.isArray(v.history)) return null;
    const scope = Array.isArray(v.scope) ? v.scope.filter((x): x is string => typeof x === "string") : null;
    const decisions: Record<string, Decision> = {};
    for (const [k, d] of Object.entries(v.decisions)) if (d === "ok" || d === "flag" || d === "skip") decisions[k] = d;
    const history = v.history.filter((id): id is string => typeof id === "string" && !!decisions[id]);
    return { order: v.order, scope, decisions, history: [...new Set(history)] };
  } catch { return null; }
}
