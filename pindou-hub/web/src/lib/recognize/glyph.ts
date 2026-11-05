// 格内色号的“簇平均字形”读取：同一颜色的所有格子印的是同一个色号，把它们对齐后平均，
// 水印 / JPEG 噪点互相抵消，得到一张干净的字形图，再整体 OCR 一次（所有簇叠成一张图，一次识别）。
// 纯 TypeScript（不依赖 DOM / canvas），浏览器和 node 评测共用。
import { ciede2000, rgbToLab } from "@engine/color";
import { MARD_PALETTE } from "@engine/palette";
import type { PixelSource } from "@engine/types";
import type { GridReading } from "./types";

export type GlyphGrid = { x0: number; y0: number; pitchX: number; pitchY: number; cols: number };
export type Lum = { width: number; height: number; data: Float32Array };

/** 亮度图（只算一次，所有簇共用）。 */
export function lumOf(src: PixelSource): Lum {
  const n = src.width * src.height;
  const data = new Float32Array(n);
  const d = src.data;
  for (let i = 0, j = 0; i < n; i += 1, j += 4) data[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return { width: src.width, height: src.height, data };
}

function bil(l: Lum, x: number, y: number): number {
  // x,y：像素中心坐标系（像素 i 的中心在 i+0.5）
  let u = x - 0.5, v = y - 0.5;
  u = u < 0 ? 0 : u > l.width - 1 ? l.width - 1 : u;
  v = v < 0 ? 0 : v > l.height - 1 ? l.height - 1 : v;
  const i = Math.floor(u), j = Math.floor(v);
  const i1 = Math.min(l.width - 1, i + 1), j1 = Math.min(l.height - 1, j + 1);
  const fu = u - i, fv = v - j;
  const d = l.data, w = l.width;
  const a = d[j * w + i] * (1 - fu) + d[j * w + i1] * fu;
  const b = d[j1 * w + i] * (1 - fu) + d[j1 * w + i1] * fu;
  return a * (1 - fv) + b * fv;
}

export type Glyph = {
  /** 参与平均的格子数 */
  n: number;
  w: number;
  h: number;
  /** 墨迹强度 0..1（1 = 字的笔画），已按极性翻转成“字为正” */
  ink: Float32Array;
  /** 1：深字（字比底色暗）；-1：浅字深底（字比底色亮） */
  polarity: 1 | -1;
  /** 字形包围盒（含端点），没有有效字形为 null */
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  /** 峰值 / 背景噪声：越大越清晰 */
  snr: number;
};

export type AverageOptions = {
  /** 裁掉每格四周的比例（避开格线），默认 0.08 */
  margin?: number;
  /** 最多取多少个格子，默认 48 */
  maxCells?: number;
};

const median = (a: ArrayLike<number>): number => {
  const b = Array.from(a).sort((x, y) => x - y);
  return b[b.length >> 1];
};

/**
 * 把一组同色格子对齐后平均成一张字形图。
 * lum 是高清源的亮度图；grid 是原图坐标的网格，f 是 高清源 / 原图 的缩放比。
 */
export function averageGlyph(lum: Lum, grid: GlyphGrid, f: number, cells: number[], opts: AverageOptions = {}): Glyph | null {
  const m = opts.margin ?? 0.08;
  const pw = grid.pitchX * f, ph = grid.pitchY * f;
  if (pw < 6 || ph < 6 || cells.length < 1) return null;
  const W = Math.max(6, Math.min(72, Math.round(pw * (1 - 2 * m))));
  const H = Math.max(6, Math.min(72, Math.round(ph * (1 - 2 * m))));
  const sx = (pw * (1 - 2 * m)) / W, sy = (ph * (1 - 2 * m)) / H;
  const use = cells.slice(0, opts.maxCells ?? 48);
  const N = use.length;
  const ox = use.map((c) => (grid.x0 + (c % grid.cols) * grid.pitchX) * f + m * pw);
  const oy = use.map((c) => (grid.y0 + Math.floor(c / grid.cols) * grid.pitchY) * f + m * ph);
  const crop = (k: number, dx: number, dy: number, base: number): Float32Array => {
    const o = new Float32Array(W * H);
    for (let j = 0; j < H; j += 1) for (let i = 0; i < W; i += 1) o[j * W + i] = bil(lum, ox[k] + dx + (i + 0.5) * sx, oy[k] + dy + (j + 0.5) * sy) - base;
    return o;
  };
  // 每格基线：该格中位亮度（底色占大多数）
  const base = use.map((_, k) => {
    const o = crop(k, 0, 0, 0);
    return median(o);
  });
  const dxs = new Float32Array(N), dys = new Float32Array(N);
  let crops = use.map((_, k) => crop(k, 0, 0, base[k]));
  const meanOf = (cs: Float32Array[], keep: boolean[]) => {
    const r = new Float32Array(W * H);
    let n = 0;
    cs.forEach((c, k) => { if (!keep[k]) return; n += 1; for (let p = 0; p < r.length; p += 1) r[p] += c[p]; });
    if (n) for (let p = 0; p < r.length; p += 1) r[p] /= n;
    return r;
  };
  const keep = new Array<boolean>(N).fill(true);
  let ref = meanOf(crops, keep);
  const corr = (a: Float32Array, b: Float32Array) => {
    let s = 0, na = 0, nb = 0;
    for (let p = 0; p < a.length; p += 1) { s += a[p] * b[p]; na += a[p] * a[p]; nb += b[p] * b[p]; }
    return s / Math.sqrt(na * nb + 1e-6);
  };
  if (N >= 3) {
    // 亚像素对齐：以当前均值为参照，每格在小范围内找最佳平移（两轮，步长递减）
    for (const [range, step] of [[1, 0.5], [0.4, 0.2]] as const) {
      for (let k = 0; k < N; k += 1) {
        let best = -2, bx = dxs[k], by = dys[k];
        for (let ddy = -range; ddy <= range + 1e-6; ddy += step) for (let ddx = -range; ddx <= range + 1e-6; ddx += step) {
          const c = crop(k, dxs[k] + ddx, dys[k] + ddy, base[k]);
          const s = corr(c, ref);
          if (s > best) { best = s; bx = dxs[k] + ddx; by = dys[k] + ddy; }
        }
        dxs[k] = bx; dys[k] = by;
        crops[k] = crop(k, bx, by, base[k]);
      }
      ref = meanOf(crops, keep);
    }
    // 丢掉与均值明显不像的格子（被水印盖住 / 边缘格 / 不是同一个字）
    const sc = crops.map((c) => corr(c, ref));
    const med = median(sc);
    const thr = Math.min(0.5, med - 0.25);
    let kept = 0;
    sc.forEach((s, k) => { keep[k] = s >= thr; if (keep[k]) kept += 1; });
    if (kept < Math.min(N, 3)) keep.fill(true);
    crops = crops.filter((_, k) => keep[k]);
  }
  const n = crops.length;
  // 逐像素截尾均值（去掉两端各 ~15%）
  const mean = new Float32Array(W * H);
  const col = new Float32Array(n);
  const cut = n >= 8 ? Math.floor(n * 0.15) : 0;
  for (let p = 0; p < W * H; p += 1) {
    for (let k = 0; k < n; k += 1) col[k] = crops[k][p];
    const s = Array.from(col).sort((x, y) => x - y);
    let t = 0;
    for (let k = cut; k < n - cut; k += 1) t += s[k];
    mean[p] = t / (n - 2 * cut);
  }
  // 极性：中央区域里正偏离与负偏离哪边质量大（字是细笔画，底色基线≈0）
  let pos = 0, neg = 0;
  for (let j = 0; j < H; j += 1) for (let i = 0; i < W; i += 1) {
    const v = mean[j * W + i];
    if (v > 0) pos += v; else neg -= v;
  }
  // 笔画浅（亮）于底色 → 正偏离 → 浅字深底；此处统一：ink = 绝对偏离大的那一侧
  const polarity: 1 | -1 = pos >= neg ? -1 : 1;
  const sign = polarity === -1 ? 1 : -1;
  const raw = new Float32Array(W * H);
  let peak = 0;
  for (let p = 0; p < raw.length; p += 1) { raw[p] = Math.max(0, sign * mean[p]); if (raw[p] > peak) peak = raw[p]; }
  // 背景噪声：墨迹值的中位数 + MAD
  const med = median(raw);
  const mad = median(raw.map((v) => Math.abs(v - med)));
  const ink = new Float32Array(W * H);
  if (peak > 0) for (let p = 0; p < ink.length; p += 1) ink[p] = Math.min(1, raw[p] / peak);
  const snr = peak / (1.4826 * mad + 1);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let j = 0; j < H; j += 1) for (let i = 0; i < W; i += 1) {
    if (ink[j * W + i] > 0.4) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; }
  }
  const bbox = x1 >= 0 && peak >= 18 ? { x0, y0, x1, y1 } : null;
  return { n, w: W, h: H, ink, polarity, bbox, snr };
}

export type GlyphStack = { image: PixelSource; rows: Array<{ id: number; y0: number; y1: number }> };

/**
 * 把若干簇的字形竖向叠成一张“黑字白底”的图（每行字高 ≈ targetH）。
 * soft：笔画二值化的软度（低 = 更细更尖）。
 */
export function stackGlyphs(glyphs: Array<{ id: number; glyph: Glyph }>, targetH = 40, lo = 0.28, span = 0.4): GlyphStack {
  const pad = 14;
  type P = { id: number; g: Glyph; s: number; bw: number; bh: number; bx: number; by: number };
  const ps: P[] = [];
  for (const { id, glyph: g } of glyphs) {
    if (!g.bbox) continue;
    const bx = Math.max(0, g.bbox.x0 - 2), by = Math.max(0, g.bbox.y0 - 2);
    const bw = Math.min(g.w, g.bbox.x1 + 3) - bx, bh = Math.min(g.h, g.bbox.y1 + 3) - by;
    const s = Math.min(8, Math.max(1, targetH / Math.max(1, g.bbox.y1 - g.bbox.y0 + 1)));
    ps.push({ id, g, s, bw, bh, bx, by });
  }
  const outW = Math.ceil(Math.max(1, ...ps.map((p) => p.bw * p.s))) + pad * 2;
  const outH = ps.reduce((s, p) => s + Math.ceil(p.bh * p.s) + pad * 2, 0);
  const out = new Uint8ClampedArray(Math.max(1, outW * outH) * 4).fill(255);
  const rows: GlyphStack["rows"] = [];
  let oy = 0;
  for (const p of ps) {
    const hh = Math.ceil(p.bh * p.s), ww = Math.ceil(p.bw * p.s);
    const ink = p.g.ink, gw = p.g.w;
    for (let y = 0; y < hh; y += 1) for (let x = 0; x < ww; x += 1) {
      // 双线性取样
      const u = Math.min(p.bw - 1, Math.max(0, (x + 0.5) / p.s - 0.5)), v = Math.min(p.bh - 1, Math.max(0, (y + 0.5) / p.s - 0.5));
      const i = Math.floor(u), j = Math.floor(v);
      const i1 = Math.min(p.bw - 1, i + 1), j1 = Math.min(p.bh - 1, j + 1);
      const fu = u - i, fv = v - j;
      const at = (a: number, b: number) => ink[(p.by + b) * gw + p.bx + a];
      const val = (at(i, j) * (1 - fu) + at(i1, j) * fu) * (1 - fv) + (at(i, j1) * (1 - fu) + at(i1, j1) * fu) * fv;
      const t = Math.min(1, Math.max(0, (val - lo) / span));
      const o = ((oy + pad + y) * outW + pad + x) * 4;
      const g = Math.round(255 * (1 - t));
      out[o] = out[o + 1] = out[o + 2] = g;
    }
    rows.push({ id: p.id, y0: oy, y1: oy + hh + pad * 2 });
    oy += hh + pad * 2;
  }
  return { image: { width: outW, height: Math.max(1, outH), data: out }, rows };
}

// ── 文字 → 色号 ──

const CONFUSABLE: Array<[string, string]> = [
  ["0", "O"], ["0", "D"], ["0", "Q"], ["O", "Q"], ["O", "D"], ["1", "I"], ["1", "L"], ["1", "7"], ["5", "S"], ["8", "B"], ["2", "Z"], ["6", "G"],
  ["9", "G"], ["C", "G"], ["H", "N"], ["M", "N"], ["E", "F"], ["P", "R"], ["B", "R"], ["3", "8"], ["5", "6"], ["6", "8"], ["4", "A"], ["A", "R"], ["T", "Y"], ["I", "L"], ["H", "M"],
  ["9", "P"], ["9", "8"], ["2", "7"], ["7", "T"], ["F", "P"]
];
const confusable = new Set(CONFUSABLE.flatMap(([a, b]) => [a + b, b + a]));

/** 带混淆代价的编辑距离：常见形近字替换 0.35，其余替换 / 插入 / 删除 1。 */
export function textCost(read: string, code: string): number {
  const a = read.toUpperCase().replace(/[^0-9A-Z]/g, ""), b = code;
  const n = a.length, m = b.length;
  if (!n) return Math.max(2, m);
  const dp: number[][] = Array.from({ length: n + 1 }, (_, i) => [i, ...new Array<number>(m).fill(0)]);
  for (let j = 0; j <= m; j += 1) dp[0][j] = j;
  for (let i = 1; i <= n; i += 1) for (let j = 1; j <= m; j += 1) {
    const sub = a[i - 1] === b[j - 1] ? 0 : confusable.has(a[i - 1] + b[j - 1]) ? 0.35 : 1;
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + sub);
  }
  return dp[n][m];
}

export type CodeCandidate = { code: string; cost: number; textCost: number; colorDe: number };

/**
 * 在候选色号里为一个簇排序：文字编辑代价 + 颜色距离（ΔE/12 ≈ 一次编辑）。
 * texts：该簇的若干次 OCR 读数（可含空串）；取各读数里代价最低的。
 */
export function rankCodes(texts: string[], clusterDe: (code: string) => number, codes: string[]): CodeCandidate[] {
  const out: CodeCandidate[] = [];
  const reads = texts.filter((t) => /[0-9A-Za-z]/.test(t));
  if (!reads.length) return out;
  for (const code of codes) {
    let tc = Infinity;
    for (const t of reads) tc = Math.min(tc, textCost(t, code));
    const de = clusterDe(code);
    out.push({ code, cost: tc + de / 12, textCost: tc, colorDe: de });
  }
  return out.sort((x, y) => x.cost - y.cost);
}

// ── 整图：每个簇平均字形 → 叠图 OCR → 文字 + 颜色排序 ──

export type GlyphVote = { code: string; cost: number; textCost: number; colorDe: number; text: string; margin: number };

export type GlyphGroup = { id: number; rgb: { r: number; g: number; b: number }; count: number; cells: number[]; /** 原始簇编号 */ members: number[]; /** 领头簇按颜色匹配得到的色号 */ colorCode: string };

/**
 * 把水印 / JPEG 噪点拆碎的簇并成“颜色组”：按格子数从大到小做领头聚类，
 * 与领头簇的 ΔE76 ≤ maxDe 的并入该组（组色 = 领头簇的颜色）。每个组之后统一读一次字。
 */
export function groupClusters(reading: GridReading, maxDe = 7): GlyphGroup[] {
  const clusters = reading.clusters ?? [];
  const order = [...clusters].sort((a, b) => b.count - a.count);
  const labs = new Map(order.map((c) => [c.id, rgbToLab(c.rgb)]));
  const groups: GlyphGroup[] = [];
  const leaders: Array<{ lab: { l: number; a: number; b: number }; g: GlyphGroup }> = [];
  for (const c of order) {
    const lab = labs.get(c.id)!;
    let best: (typeof leaders)[number] | null = null, bd = maxDe;
    for (const l of leaders) {
      const d = Math.hypot(l.lab.l - lab.l, l.lab.a - lab.a, l.lab.b - lab.b);
      if (d <= bd) { bd = d; best = l; }
    }
    if (best) { best.g.count += c.count; best.g.cells.push(...c.cells); best.g.members.push(c.id); }
    else {
      const g: GlyphGroup = { id: groups.length, rgb: c.rgb, count: c.count, cells: [...c.cells], members: [c.id], colorCode: c.colorCode };
      groups.push(g);
      leaders.push({ lab, g });
    }
  }
  return groups;
}

/** 每组挑最多 n 个代表格：有墨迹、优先“四邻同组”的内部格，沿图均匀分布。 */
export function pickGlyphCells(reading: GridReading, group: GlyphGroup, n: number): number[] {
  const { cols, rows } = reading.grid;
  const ink = reading.cellInk!;
  const inGroup = new Set(group.cells);
  const inner: number[] = [];
  const rest: number[] = [];
  for (const i of group.cells) {
    if (!ink[i] || reading.backgroundMask?.[i]) continue;
    const x = i % cols, y = Math.floor(i / cols);
    const same = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < cols && yy < rows && inGroup.has(yy * cols + xx);
    (same(x - 1, y) && same(x + 1, y) && same(x, y - 1) && same(x, y + 1) ? inner : rest).push(i);
  }
  const pool = (inner.length >= Math.min(n, 12) ? inner : [...inner, ...rest]).sort((a, b) => a - b);
  const k = Math.min(n, pool.length);
  const out: number[] = [];
  for (let t = 0; t < k; t += 1) out.push(pool[Math.floor(((t + 0.5) * pool.length) / k)]);
  return out;
}

export type GlyphReadOptions = {
  /** 候选色号全集（图例里的色号）；没有则用整个 MARD 色卡 */
  allowed?: string[] | null;
  /** 图例色块的实际颜色（色号 → RGB）：有则作为该色号的颜色参照 */
  legendColors?: Record<string, { r: number; g: number; b: number }> | null;
  whitelist?: string;
};

/**
 * 读出每个簇的格内色号。返回 簇编号 → 投票（含代价与第二名的差距）。
 * 只读：不改 reading。最多 2 次 OCR（两种笔画粗细的叠图），与簇颜色一起排序。
 */
export async function readGlyphCodes(
  hi: PixelSource, f: number, grid: GlyphGrid, reading: GridReading, groups: GlyphGroup[],
  opts: GlyphReadOptions, signal: AbortSignal | undefined,
  ocr: (img: PixelSource, signal: AbortSignal | undefined, o: { scale: number; psm: string; whitelist: string }) => Promise<{ words: Array<{ text: string; bbox: { y0: number; y1: number; x0: number; x1: number } }> }>
): Promise<{ votes: Record<number, GlyphVote>; glyphs: number }> {
  const lum = lumOf(hi);
  const clusters: Record<number, GlyphGroup> = Object.fromEntries(groups.map((g) => [g.id, g]));
  const glyphs: Array<{ id: number; glyph: Glyph }> = [];
  for (const { id } of groups) {
    const cells = pickGlyphCells(reading, clusters[id], 48);
    if (cells.length < 2 && clusters[id].count > 1) continue;
    if (!cells.length) continue;
    const g = averageGlyph(lum, grid, f, cells);
    if (g?.bbox) glyphs.push({ id, glyph: g });
  }
  const votes: Record<number, GlyphVote> = {};
  if (!glyphs.length) return { votes, glyphs: 0 };
  const allowed = opts.allowed && opts.allowed.length >= 2 ? opts.allowed : MARD_PALETTE.map((c) => c.code);
  const pal = new Map(MARD_PALETTE.map((p) => [p.code, p]));
  const labOf = (code: string) => {
    const lc = opts.legendColors?.[code];
    return lc ? rgbToLab(lc) : pal.get(code)?.lab ?? null;
  };
  const texts = new Map<number, string[]>();
  // 三种二值化软度：笔画粗细不同时误读互不相同。前两种并发读（worker 池），第三种只给还没“两遍读成同一个有效色号”的组
  const wl = opts.whitelist ?? "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const allowedSet = new Set(allowed);
  const readVariant = async (lo: number, span: number, only?: Set<number>): Promise<Array<[number, string]>> => {
    const list = only ? glyphs.filter((g) => only.has(g.id)) : glyphs;
    const out: Array<[number, string]> = [];
    // 每批最多 40 行，避免叠图过高
    for (let s = 0; s < list.length; s += 40) {
      const stack = stackGlyphs(list.slice(s, s + 40), 40, lo, span);
      if (!stack.rows.length) continue;
      (globalThis as { __phGlyphDebug?: (info: unknown) => void }).__phGlyphDebug?.({ stack: stack.image });
      const res = await ocr(stack.image, signal, { scale: 1, psm: "6", whitelist: wl });
      for (const row of stack.rows) {
        const t = res.words
          .filter((w) => { const cy = (w.bbox.y0 + w.bbox.y1) / 2; return cy >= row.y0 && cy < row.y1; })
          .sort((a, b) => a.bbox.x0 - b.bbox.x0).map((w) => w.text).join("");
        out.push([row.id, t]);
      }
    }
    return out;
  };
  const absorb = (rs: Array<Array<[number, string]>>) => { for (const r of rs) for (const [id, t] of r) { const arr = texts.get(id) ?? []; arr.push(t); texts.set(id, arr); } };
  absorb(await Promise.all([readVariant(0.45, 0.3), readVariant(0.55, 0.25)]));
  const undecided = new Set<number>();
  for (const { id } of glyphs) {
    const t = texts.get(id) ?? [];
    const a0 = (t[0] ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
    // 两遍相同且就是一个有效色号：再读一遍只会得到同样的最优候选（文字代价 0 已是最低）
    if (!(t.length >= 2 && a0 && a0 === (t[1] ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "") && allowedSet.has(a0))) undecided.add(id);
  }
  if (undecided.size) absorb([await readVariant(0.3, 0.4, undecided)]);
  const dbg = (globalThis as { __phGlyphDebug?: (info: unknown) => void }).__phGlyphDebug;
  for (const { id } of glyphs) {
    const cl = clusters[id];
    const cLab = rgbToLab(cl.rgb);
    const ranked = rankCodes(texts.get(id) ?? [], (code) => { const l = labOf(code); return l ? ciede2000(cLab, l) : 60; }, allowed);
    if (!ranked.length) continue;
    const best = ranked[0], second = ranked[1];
    // 接受条件：文字至多差一个字符，颜色不能离谱（同色号在不同图里漂移也要容得下）
    dbg?.({ id, rgb: cl.rgb, count: cl.count, texts: texts.get(id), top: ranked.slice(0, 3).map((r) => `${r.code}:${r.textCost.toFixed(2)}/${r.colorDe.toFixed(0)}`) });
    const strong = best.textCost <= 1.0 && best.colorDe <= 28;
    // 读出的字残缺（如 “C” “8”）：文字只能排除不像的，颜色又明显偏向某一个 → 也采纳
    const byColor = best.colorDe <= 10 && (second ? second.cost - best.cost : 9) >= 0.8;
    if (!strong && !byColor) continue;
    // 与颜色匹配结果不一致时要更强的证据：至少两次识别都（几乎）精确读出该色号，避免单次误读（A1→A2）推翻正确的颜色匹配
    if (best.code !== clusters[id].colorCode) {
      const exact = (texts.get(id) ?? []).filter((t) => textCost(t, best.code) <= 0.35).length;
      if (exact < 2) continue;
    }
    votes[id] = { code: best.code, cost: best.cost, textCost: best.textCost, colorDe: best.colorDe, text: (texts.get(id) ?? []).join("|"), margin: second ? second.cost - best.cost : 9 };
  }
  return { votes, glyphs: glyphs.length };
}

// ── 近色色号逐格区分 ──
// 白 / 米白 / 浅粉这类色块互相只差 ΔE 2~6：JPEG 与水印下颜色聚类分不开（H2 / H12 / H19 混成一簇或被切碎），
// 但格内印的字不同（H2 两个字，H12 三个字…）。对这类“近色组”里的有字格，按字形做余弦 k-means，每个字形组整体 OCR 命名。

const SIG_W = 16, SIG_H = 8;

/** 一个格子中央文字带的墨迹签名（L2 归一化），格子基线 = 带内中位亮度。 */
function cellSignature(lum: Lum, grid: GlyphGrid, f: number, cell: number): Float32Array | null {
  const pw = grid.pitchX * f, ph = grid.pitchY * f;
  if (pw < 8 || ph < 8) return null;
  const ox = (grid.x0 + (cell % grid.cols) * grid.pitchX) * f, oy = (grid.y0 + Math.floor(cell / grid.cols) * grid.pitchY) * f;
  const raw = new Float32Array(SIG_W * SIG_H);
  for (let j = 0; j < SIG_H; j += 1) for (let i = 0; i < SIG_W; i += 1) {
    raw[j * SIG_W + i] = bil(lum, ox + (0.1 + 0.8 * (i + 0.5) / SIG_W) * pw, oy + (0.25 + 0.5 * (j + 0.5) / SIG_H) * ph);
  }
  const base = median(raw);
  const dev = raw.map((v) => Math.abs(v - base));
  // 3×3 盒式模糊：容忍 1px 内的错位
  const out = new Float32Array(dev.length);
  let nn = 0;
  for (let j = 0; j < SIG_H; j += 1) for (let i = 0; i < SIG_W; i += 1) {
    let s = 0, c = 0;
    for (let dj = -1; dj <= 1; dj += 1) for (let di = -1; di <= 1; di += 1) {
      const jj = j + dj, ii = i + di;
      if (jj < 0 || ii < 0 || jj >= SIG_H || ii >= SIG_W) continue;
      s += dev[jj * SIG_W + ii]; c += 1;
    }
    out[j * SIG_W + i] = s / c;
    nn += out[j * SIG_W + i] * out[j * SIG_W + i];
  }
  if (nn < 1) return null;
  const inv = 1 / Math.sqrt(nn);
  for (let p = 0; p < out.length; p += 1) out[p] *= inv;
  return out;
}

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let p = 0; p < a.length; p += 1) s += a[p] * b[p]; return s; };

/** 余弦 k-means：种子取“比较典型”的点里彼此最不像的 k 个。返回每个点的组号。 */
function cosKMeans(sigs: Float32Array[], k: number): number[] {
  const n = sigs.length;
  const mean = new Float32Array(sigs[0].length);
  for (const s of sigs) for (let p = 0; p < mean.length; p += 1) mean[p] += s[p];
  const typ = sigs.map((s) => dot(s, mean));
  const cut = median(typ);
  const pool = sigs.map((_, i) => i).filter((i) => typ[i] >= cut);
  const seeds: number[] = [pool.reduce((b, i) => (typ[i] > typ[b] ? i : b), pool[0])];
  while (seeds.length < k) {
    let bi = -1, bs = Infinity;
    for (const i of pool) {
      const m = Math.max(...seeds.map((s) => dot(sigs[i], sigs[s])));
      if (m < bs) { bs = m; bi = i; }
    }
    if (bi < 0) break;
    seeds.push(bi);
  }
  let cents = seeds.map((s) => Float32Array.from(sigs[s]));
  const lab = new Array<number>(n).fill(0);
  for (let it = 0; it < 15; it += 1) {
    let moved = false;
    for (let i = 0; i < n; i += 1) {
      let bj = 0, bs = -Infinity;
      for (let j = 0; j < cents.length; j += 1) { const s = dot(sigs[i], cents[j]); if (s > bs) { bs = s; bj = j; } }
      if (lab[i] !== bj) { lab[i] = bj; moved = true; }
    }
    cents = cents.map((c, j) => {
      const m = new Float32Array(c.length);
      let cnt = 0;
      for (let i = 0; i < n; i += 1) if (lab[i] === j) { cnt += 1; for (let p = 0; p < m.length; p += 1) m[p] += sigs[i][p]; }
      if (!cnt) return c;
      const nr = Math.sqrt(dot(m, m)) || 1;
      for (let p = 0; p < m.length; p += 1) m[p] /= nr;
      return m;
    });
    if (!moved) break;
  }
  return lab;
}

/** 一组格子平均字形的字宽（占裁剪宽度的比例）；没有可信字形返回 null。 */
function glyphWidthFrac(lum: Lum, grid: GlyphGrid, f: number, reading: GridReading, cells: number[]): number | null {
  const ids = pickGlyphCells(reading, { id: 0, rgb: { r: 0, g: 0, b: 0 }, count: cells.length, cells, members: [], colorCode: "" }, 48);
  if (ids.length < 3) return null;
  const g = averageGlyph(lum, grid, f, ids);
  if (!g?.bbox) return null;
  return (g.bbox.x1 - g.bbox.x0 + 1) / g.w;
}

/**
 * 近色组逐格定色号。返回 格序号 → 色号（只含有把握的格子）。
 * allowed：图例色号全集（必须）。只处理“图例里互相 ΔE2000 ≤ 7、且字数不全相同”的色号组（H2 / H12 / H19：两字与三字），
 * 组内有字格 ≥ 12 个。字形太小、OCR 读不出时，字数（平均字形的宽度，用已读出的色号簇标定两字 / 三字的宽度）加颜色就能定色号。
 * votes：已读出的簇 → 色号（用来标定字宽）。
 */
export function readNearColorCells(
  hi: PixelSource, f: number, grid: GlyphGrid, reading: GridReading, votes: Record<number, string>,
  opts: GlyphReadOptions
): Record<number, string> {
  const out: Record<number, string> = {};
  const allowed = opts.allowed ?? [];
  if (allowed.length < 3 || !reading.clusters || !reading.cellInk || !reading.cellCluster) return out;
  const pal = new Map(MARD_PALETTE.map((p) => [p.code, p]));
  const labOf = (code: string) => { const lc = opts.legendColors?.[code]; return lc ? rgbToLab(lc) : pal.get(code)?.lab ?? null; };
  // 只处理浅色（白 / 米白 / 浅粉 / 浅灰，L ≥ 80）：浅色之间 JPEG 与水印足以让颜色互相混淆；深色 / 饱和色颜色匹配与簇级 OCR 本来就可靠
  const codes = allowed.filter((c) => { const l = labOf(c); return l && l.l >= 80; });
  // 近色组：并查集
  const par = new Map(codes.map((c) => [c, c]));
  const find = (c: string): string => { let r = c; while (par.get(r) !== r) r = par.get(r)!; par.set(c, r); return r; };
  for (let i = 0; i < codes.length; i += 1) for (let j = i + 1; j < codes.length; j += 1) {
    if (ciede2000(labOf(codes[i])!, labOf(codes[j])!) <= 7) par.set(find(codes[i]), find(codes[j]));
  }
  const sets = new Map<string, string[]>();
  for (const c of codes) { const r = find(c); sets.set(r, [...(sets.get(r) ?? []), c]); }
  const multi = [...sets.values()].filter((s) => s.length >= 2 && new Set(s.map((c) => c.length)).size >= 2);
  if (!multi.length) return out;
  const setOf = new Map<string, number>();
  multi.forEach((s, i) => s.forEach((c) => setOf.set(c, i)));
  // 每个簇的归属：最近的图例色号在某个近色组里，且颜色够近
  const clusterSet = new Map<number, number>();
  for (const c of reading.clusters) {
    const lab = rgbToLab(c.rgb);
    let bd = Infinity, bc = "";
    for (const code of codes) { const d = ciede2000(lab, labOf(code)!); if (d < bd) { bd = d; bc = code; } }
    const si = setOf.get(bc);
    if (si !== undefined && bd <= 6.5) clusterSet.set(c.id, si);
  }
  const lum = lumOf(hi);
  // 标定字宽：已读出色号的簇（排除近色组里的簇），两字 / 三字各取中位数
  const w2: number[] = [], w3: number[] = [];
  for (const c of [...reading.clusters].sort((a, b) => b.count - a.count)) {
    const code = votes[c.id];
    if (!code || clusterSet.has(c.id) || c.count < 8 || (w2.length >= 8 && w3.length >= 8)) continue;
    const L = code.length;
    if ((L !== 2 && L !== 3) || (L === 2 ? w2 : w3).length >= 8) continue;
    const wf = glyphWidthFrac(lum, grid, f, reading, c.cells);
    if (wf !== null) (L === 2 ? w2 : w3).push(wf);
  }
  if (w2.length < 2 || w3.length < 2) return out;
  const m2 = median(w2), m3 = median(w3);
  if (m3 - m2 < 0.08) return out;
  const thr = (m2 + m3) / 2;
  for (let si = 0; si < multi.length; si += 1) {
    const cells: number[] = [];
    for (const c of reading.clusters) {
      if (clusterSet.get(c.id) !== si) continue;
      for (const i of c.cells) if (reading.cellInk[i] && !reading.backgroundMask?.[i]) cells.push(i);
    }
    if (cells.length < 12) continue;
    const sigs: Float32Array[] = [], used: number[] = [];
    for (const i of cells) { const s = cellSignature(lum, grid, f, i); if (s) { sigs.push(s); used.push(i); } }
    if (sigs.length < 12) continue;
    const k = Math.min(4, multi[si].length + 1);
    const lab = cosKMeans(sigs, k);
    for (let j = 0; j < k; j += 1) {
      const gc = used.filter((_, t) => lab[t] === j);
      if (gc.length < 3) continue;
      const wf = glyphWidthFrac(lum, grid, f, reading, gc);
      if (wf === null) continue;
      const nc = wf > thr ? 3 : 2;
      let r = 0, g = 0, b = 0;
      for (const i of gc) { const cl = reading.clusters[reading.cellCluster[i]]; r += cl.rgb.r; g += cl.rgb.g; b += cl.rgb.b; }
            // 同字数的候选只差在白 / 米白的细微色调上：RGB 距离（对偏黄 / 偏粉的色调更敏感）比 ΔE2000 拉得开
      const rgb0 = { r: r / gc.length, g: g / gc.length, b: b / gc.length };
      const rgbOf = (c: string) => opts.legendColors?.[c] ?? pal.get(c)?.rgb ?? { r: 0, g: 0, b: 0 };
      const cand = multi[si].filter((c) => c.length === nc).map((c) => { const q = rgbOf(c); return { c, de: Math.hypot(rgb0.r - q.r, rgb0.g - q.g, rgb0.b - q.b) }; }).sort((x, y) => x.de - y.de);
      if (!cand.length || cand[0].de > 20) continue;
      if (cand.length > 1 && cand[1].de < 1.3 * cand[0].de) continue;
      for (const i of gc) out[i] = cand[0].c;
    }
  }
  return out;
}

/**
 * 水印 / 杂物压在空白格上造成的“假有字格”：浅色（白）簇里的有字格，字形与簇里多数格子的字形完全不像 → 判为空格。
 * 返回要当成空格的格序号。
 */
export function outlierInkCells(hi: PixelSource, f: number, grid: GlyphGrid, reading: GridReading): number[] {
  const out: number[] = [];
  if (!reading.clusters || !reading.cellInk) return out;
  const lum = lumOf(hi);
  for (const c of reading.clusters) {
    const lab = rgbToLab(c.rgb);
    if (c.empty || lab.l < 88 || Math.hypot(lab.a, lab.b) > 8) continue;
    const cells = c.cells.filter((i) => reading.cellInk![i] && !reading.backgroundMask?.[i]);
    if (cells.length < 8) continue;
    const sigs: Float32Array[] = [], used: number[] = [];
    for (const i of cells) { const s = cellSignature(lum, grid, f, i); if (s) { sigs.push(s); used.push(i); } }
    if (sigs.length < 8) continue;
    let cen = new Float32Array(sigs[0].length);
    for (const s of sigs) for (let p = 0; p < cen.length; p += 1) cen[p] += s[p];
    let nr = Math.sqrt(dot(cen, cen)) || 1;
    cen = cen.map((v) => v / nr);
    for (let it = 0; it < 3; it += 1) {
      const m = new Float32Array(cen.length);
      for (const s of sigs) if (dot(s, cen) >= 0.5) for (let p = 0; p < m.length; p += 1) m[p] += s[p];
      nr = Math.sqrt(dot(m, m));
      if (nr < 1e-6) break;
      cen = m.map((v) => v / nr);
    }
    const cs = sigs.map((s) => dot(s, cen));
    // 多数格子字形高度一致（中位数 ≥ 0.9）、只有极少数（≤ 20%）明显不像（< 0.75）才算杂物
    if (median(cs) < 0.9) continue;
    const bad = used.filter((_, t) => cs[t] < 0.75);
    if (bad.length > 0.2 * used.length) continue;
    out.push(...bad);
  }
  return out;
}
