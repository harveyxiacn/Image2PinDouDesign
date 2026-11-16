// 按库存换色：把图纸里“我不管理”的色号换成最接近的、我管理的色号。纯逻辑，不碰存储，便于单测。
import { ciede2000 } from "@engine/color";
import { decodeDone, encodeDone } from "./build";
import { compareCodes } from "./inventory";
import { decodeMatrix, encodeMatrix, matrixOf, type Matrix } from "./matrix";
import type { Counts, Pattern, StockRecolor } from "./model";
import { managedCodes, colorOf } from "./palette";

export type RecolorMode = "managed" | "instock";
export const RECOLOR_MODE_LABEL: Record<RecolorMode, string> = { managed: "我的套装和库存", instock: "只用现在有货的" };

/** 可以换成的色号：managed = 套装里的 + 库存里有货的套装外色号；instock = 只要库存大于 0 的色号。 */
export function allowedCodes(mode: RecolorMode, kitId: string | null | undefined, stock: Record<string, number>): string[] {
  if (mode === "instock") {
    return Object.entries(stock).filter(([code, qty]) => qty > 0 && !!colorOf(code)).map(([code]) => code).sort(compareCodes);
  }
  return managedCodes(kitId, stock);
}

export type DistanceLabel = "几乎一样" | "很接近" | "相近" | "差别明显";
/** 与 lib/insights.ts 的 substituteLabel 同一套阈值（≤2、≤4），再往上分“相近”（≤8）和“差别明显”。 */
export function distanceLabel(deltaE: number): DistanceLabel {
  if (deltaE <= 2) return "几乎一样";
  if (deltaE <= 4) return "很接近";
  if (deltaE <= 8) return "相近";
  return "差别明显";
}

export type RecolorRow = { from: string; to: string; count: number; deltaE: number; label: DistanceLabel };
export type RecolorPlan = {
  rows: RecolorRow[];
  /** 色卡里没有的色号：不动，单独列出 */
  unknown: Array<{ code: string; count: number }>;
  map: Array<[string, string]>;
  newCounts: Counts;
  newMatrix?: Matrix;
  /** 图纸总颗数（换色前后相同） */
  beads: number;
  /** 被换色的颗数 / 颜色数 / “差别明显”的颜色数 */
  changedBeads: number;
  changedColors: number;
  noticeable: number;
  /** 没有可做的事时说明原因 */
  reason?: string;
};

type PlanInput = { counts: Counts; matrix?: Matrix };

function usedCodes(input: PlanInput): Counts {
  const out: Counts = {};
  for (const [code, n] of Object.entries(input.counts)) if (n > 0) out[code] = n;
  return out;
}

/** 为 code 在 allowed 里找最接近的（CIEDE2000），距离相同取色号顺序靠前的。 */
export function nearestAllowed(code: string, allowed: string[]): { to: string; deltaE: number } | null {
  const src = colorOf(code);
  if (!src) return null;
  let best: { to: string; deltaE: number } | null = null;
  for (const cand of allowed) {
    const c = colorOf(cand);
    if (!c || cand === code) continue;
    const d = ciede2000(src.lab, c.lab);
    if (!best || d < best.deltaE - 1e-9 || (Math.abs(d - best.deltaE) <= 1e-9 && compareCodes(cand, best.to) < 0)) best = { to: cand, deltaE: d };
  }
  return best;
}

export function planRecolor(input: PlanInput, allowed: string[]): RecolorPlan {
  const used = usedCodes(input);
  const beads = Object.values(used).reduce((a, b) => a + b, 0);
  const base: RecolorPlan = { rows: [], unknown: [], map: [], newCounts: { ...used }, newMatrix: input.matrix, beads, changedBeads: 0, changedColors: 0, noticeable: 0 };
  if (!allowed.length) return { ...base, reason: "没有可换成的颜色：套装和库存里都没有可用的色号" };
  const set = new Set(allowed);
  const rows: RecolorRow[] = [];
  const unknown: RecolorPlan["unknown"] = [];
  for (const code of Object.keys(used).sort(compareCodes)) {
    if (set.has(code)) continue;
    if (!colorOf(code)) { unknown.push({ code, count: used[code] }); continue; }
    const near = nearestAllowed(code, allowed);
    if (!near) continue;
    rows.push({ from: code, to: near.to, count: used[code], deltaE: near.deltaE, label: distanceLabel(near.deltaE) });
  }
  rows.sort((a, b) => b.count - a.count || compareCodes(a.from, b.from));
  const map: Array<[string, string]> = rows.map((r) => [r.from, r.to]);
  if (!rows.length) return { ...base, unknown, reason: unknown.length ? "没有需要换的颜色（色卡里没有的色号不会动）" : "这张图纸用的颜色都在你的范围内" };
  const lookup = new Map(map);
  const newCounts: Counts = {};
  for (const [code, n] of Object.entries(used)) { const to = lookup.get(code) ?? code; newCounts[to] = (newCounts[to] ?? 0) + n; }
  const newMatrix = input.matrix?.map((row) => row.map((cell) => (cell ? lookup.get(cell) ?? cell : cell)));
  return {
    rows, unknown, map, newCounts, newMatrix, beads,
    changedBeads: rows.reduce((a, r) => a + r.count, 0),
    changedColors: rows.length,
    noticeable: rows.filter((r) => r.label === "差别明显").length
  };
}

/** 这张图纸有没有用到范围外的色号（有色卡里没有的不算）。 */
export function outsideColors(counts: Counts, allowed: string[]): Array<{ code: string; count: number }> {
  const set = new Set(allowed);
  return Object.entries(counts).filter(([code, n]) => n > 0 && !set.has(code) && !!colorOf(code)).map(([code, count]) => ({ code, count })).sort((a, b) => compareCodes(a.code, b.code));
}

export function hasBuildProgress(pattern: Pick<Pattern, "build">): boolean {
  return !!pattern.build && /=/.test(pattern.build.done ?? "");
}

export type RecolorBlock = "done" | "consumed" | "progress";
/** 能不能换色：已完成 / 已扣库存的不换（颜色已经用掉了，改了会和库存流水对不上）。 */
export function recolorBlock(pattern: Pattern): RecolorBlock | null {
  if (pattern.status === "done") return "done";
  if (pattern.consumed) return "consumed";
  return null;
}
export const BLOCK_TEXT: Record<RecolorBlock, string> = {
  done: "已完成的图纸不换色：豆子已经拼好了，换了颜色会和实物对不上",
  consumed: "已扣过库存的图纸不换色，免得和库存记录对不上",
  progress: "拼装进行中"
};

function dims(pattern: Pattern): { w: number; h: number } | null {
  return pattern.width && pattern.height ? { w: pattern.width, h: pattern.height } : null;
}

/** 换色：返回要写回图纸的补丁。第一次换色记下原样；再换一次保留第一次的原样。拼装进度跟着换到新色号上（同一格仍算已拼）。 */
export function applyRecolor(pattern: Pattern, plan: RecolorPlan, mode: RecolorMode, now: number, preview?: { previewId: string }): Partial<Pattern> {
  const prev = pattern.stockRecolor;
  const cur = matrixOf(pattern);
  const patch: Partial<Pattern> = { counts: plan.newCounts, updatedAt: Math.max(now, pattern.updatedAt + 1) };
  // 换色以后：以前核对过的“已核对”不再成立，颜色匹配度作废
  patch.verifiedAt = undefined;
  patch.colorMatch = undefined;
  if (plan.newMatrix && cur) {
    if (pattern.matrix?.length) patch.matrix = plan.newMatrix;
    else patch.matrixRle = encodeMatrix(plan.newMatrix);
  }
  const d = dims(pattern);
  if (pattern.build && cur && plan.newMatrix && d && hasBuildProgress(pattern)) {
    const flags = decodeDone(pattern.build.done, cur, d.w, d.h);
    patch.build = { ...pattern.build, done: encodeDone(plan.newMatrix, flags, d.w, d.h), colorIndex: 0, updatedAt: Math.max(now, pattern.build.updatedAt + 1) };
  }
  const map = prev ? mergeMaps(prev.map, plan.map) : plan.map;
  const rec: StockRecolor = prev
    ? { ...prev, at: now, mode, map }
    : {
      at: now, mode, map, origCounts: { ...pattern.counts },
      origMatrixRle: cur ? encodeMatrix(cur) : undefined,
      origPreviewId: preview ? pattern.previewId : undefined,
      previewAdded: preview && !pattern.previewId ? true : undefined,
      origVerifiedAt: pattern.verifiedAt, origColorMatch: pattern.colorMatch
    };
  if (prev && preview && !prev.origPreviewId && !prev.previewAdded) {
    if (pattern.previewId) rec.origPreviewId = pattern.previewId;
    else rec.previewAdded = true;
  }
  if (preview) patch.previewId = preview.previewId;
  patch.stockRecolor = rec;
  return patch;
}

/** 第一次换色的对照与这一次的对照合并：原色号 → 最终色号。 */
function mergeMaps(first: Array<[string, string]>, next: Array<[string, string]>): Array<[string, string]> {
  const second = new Map(next);
  const out = new Map<string, string>();
  for (const [from, to] of first) out.set(from, second.get(to) ?? to);
  for (const [from, to] of next) if (!out.has(from) && !first.some(([, t]) => t === from)) out.set(from, to);
  return [...out].sort((a, b) => compareCodes(a[0], b[0]));
}

/** 恢复原色：给回换色前的用量 / 格子（/ 预览图 / 拼装进度），并清掉记录。没有记录返回 null。 */
export function restoreRecolor(pattern: Pattern, now: number): Partial<Pattern> | null {
  const rec = pattern.stockRecolor;
  if (!rec) return null;
  const patch: Partial<Pattern> = { counts: { ...rec.origCounts }, stockRecolor: undefined, verifiedAt: rec.origVerifiedAt, colorMatch: rec.origColorMatch, updatedAt: Math.max(now, pattern.updatedAt + 1) };
  const orig = decodeMatrix(rec.origMatrixRle);
  const cur = matrixOf(pattern);
  if (orig) {
    if (pattern.matrix?.length) patch.matrix = orig;
    else patch.matrixRle = rec.origMatrixRle;
  }
  const d = dims(pattern);
  if (pattern.build && orig && cur && d && hasBuildProgress(pattern)) {
    const flags = decodeDone(pattern.build.done, cur, d.w, d.h);
    patch.build = { ...pattern.build, done: encodeDone(orig, flags, d.w, d.h), colorIndex: 0, updatedAt: Math.max(now, pattern.build.updatedAt + 1) };
  }
  if (rec.origPreviewId) patch.previewId = rec.origPreviewId;
  else if (rec.previewAdded) patch.previewId = undefined;
  return patch;
}

export type BatchSummary = {
  /** 会被换色的图纸 */
  patterns: Array<{ id: string; plan: RecolorPlan }>;
  colors: number;
  beads: number;
  noticeable: number;
  skippedDone: number;
  skippedConsumed: number;
  skippedProgress: number;
};

/** 全部图纸一起换：统计受影响的图纸、颜色、颗数，以及因为已完成 / 已扣库存 / 拼装进行中而跳过的张数。 */
export function planBatch(patterns: Pattern[], allowed: string[]): BatchSummary {
  const out: BatchSummary = { patterns: [], colors: 0, beads: 0, noticeable: 0, skippedDone: 0, skippedConsumed: 0, skippedProgress: 0 };
  const colorSet = new Set<string>();
  for (const p of patterns) {
    if (p.deleted) continue;
    if (!outsideColors(p.counts, allowed).length) continue;
    const block = recolorBlock(p);
    if (block === "done") { out.skippedDone += 1; continue; }
    if (block === "consumed") { out.skippedConsumed += 1; continue; }
    if (hasBuildProgress(p)) { out.skippedProgress += 1; continue; }
    const plan = planRecolor({ counts: p.counts, matrix: matrixOf(p) }, allowed);
    if (!plan.rows.length) continue;
    out.patterns.push({ id: p.id, plan });
    out.beads += plan.changedBeads;
    out.noticeable += plan.noticeable;
    for (const r of plan.rows) colorSet.add(r.from);
  }
  out.colors = colorSet.size;
  return out;
}
