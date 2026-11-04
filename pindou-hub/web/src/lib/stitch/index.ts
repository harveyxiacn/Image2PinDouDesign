// 多张截图拼接：同一张长图纸放大后分段截屏 → 一张高清长图。
// 纯函数（Node 测试和 Web Worker 共用），只依赖 PixelSource。
//  1. 裁掉每张截图上下的手机界面（状态栏 / 标题栏 / 底栏：整行单色，或与其他截图同一行几乎相同）
//  2. 两两找重叠：先在小图上用 FFT 互相关（归一化）找候选位移，再逐级在中图（灰度 + 边缘）和原图上精修到整像素
//  3. 取最大生成树（每张只要接上一张就行），按任意顺序 / 横向或纵向 / ±5% 缩放差异都能处理
//  4. 融合：每个像素取「离所在截图边缘最远」的那一张，不做平均，不糊
import type { PixelSource } from "@engine/types";

export type StitchPlacement = { x: number; y: number; scale: number };
export type StitchOptions = {
  /** 输出长边上限（默认 8000） */
  maxEdge?: number;
  /** 输出像素数上限（默认 2000 万，手机内存安全） */
  maxPixels?: number;
  /** 接受一对重叠的最低相关系数（默认 0.75） */
  minScore?: number;
  cropChrome?: boolean;
  onProgress?: (percent: number, label: string) => void;
};
export type StitchResult = {
  image: PixelSource;
  /** 每张「原始截图」左上角在输出图中的位置和缩放（裁掉的界面区域可能让 x / y 为负）；没拼进去的那几张是 {0,0,1} */
  placements: StitchPlacement[];
  /** 每张截图「裁掉界面后」的有效区域（输出图坐标）；included 为 false 的是 null */
  rects: Array<{ x: number; y: number; width: number; height: number } | null>;
  included: boolean[];
  /** 每张上下被裁掉的行数（原始像素） */
  crops: Array<{ top: number; bottom: number }>;
  /** 0–1：最弱一条接缝的相关系数 × 拼进去的比例 */
  confidence: number;
  warnings: string[];
  /** 被采用的相邻关系 [i, j, 相关系数] */
  links: Array<[number, number, number]>;
};

const DEFAULTS = { maxEdge: 8000, maxPixels: 20_000_000, minScore: 0.75 };

// ---------- 基础：灰度、重采样 ----------
function toGray(img: PixelSource): Float32Array {
  const { width, height, data } = img;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  return out;
}

type Taps = { start: Int32Array; count: Int32Array; off: Int32Array; w: Float32Array };
function axisTaps(n: number, m: number): Taps {
  const start = new Int32Array(m), count = new Int32Array(m), off = new Int32Array(m);
  const ws: number[] = [];
  const k = n / m;
  for (let i = 0; i < m; i += 1) {
    off[i] = ws.length;
    if (m <= n) {
      const a = i * k, b = (i + 1) * k;
      const s = Math.floor(a), e = Math.min(n, Math.ceil(b));
      start[i] = s; count[i] = e - s;
      let sum = 0;
      const tmp: number[] = [];
      for (let j = s; j < e; j += 1) { const w = Math.min(j + 1, b) - Math.max(j, a); tmp.push(w); sum += w; }
      for (const w of tmp) ws.push(w / sum);
    } else {
      const c = (i + 0.5) * k - 0.5;
      const i0 = Math.max(0, Math.min(n - 1, Math.floor(c)));
      const i1 = Math.min(n - 1, i0 + 1);
      const f = Math.max(0, Math.min(1, c - i0));
      start[i] = i0; count[i] = 2; ws.push(1 - f, f);
      if (i1 === i0) { ws[ws.length - 2] = 1; ws[ws.length - 1] = 0; }
    }
  }
  return { start, count, off, w: Float32Array.from(ws) };
}

/** 灰度重采样（缩小用面积平均，放大用双线性）。 */
function resizeGray(src: Float32Array, w: number, h: number, nw: number, nh: number): Float32Array {
  if (nw === w && nh === h) return src;
  const tx = axisTaps(w, nw), ty = axisTaps(h, nh);
  const tmp = new Float32Array(nw * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * w, o = y * nw;
    for (let x = 0; x < nw; x += 1) {
      let s = 0;
      const st = tx.start[x], c = tx.count[x], of = tx.off[x];
      for (let j = 0; j < c; j += 1) s += src[row + st + j] * tx.w[of + j];
      tmp[o + x] = s;
    }
  }
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y += 1) {
    const st = ty.start[y], c = ty.count[y], of = ty.off[y];
    for (let x = 0; x < nw; x += 1) {
      let s = 0;
      for (let j = 0; j < c; j += 1) s += tmp[(st + j) * nw + x] * ty.w[of + j];
      out[y * nw + x] = s;
    }
  }
  return out;
}

function gradient(g: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      out[i] = Math.abs(g[i + 1] - g[i - 1]) + Math.abs(g[i + w] - g[i - w]);
    }
  }
  return out;
}

// ---------- 裁掉手机界面 ----------
function rowStats(gray: Float32Array, w: number, y: number): { std: number } {
  let s = 0, s2 = 0, n = 0;
  const o = y * w;
  for (let x = 0; x < w; x += 2) { const v = gray[o + x]; s += v; s2 += v * v; n += 1; }
  const m = s / n;
  return { std: Math.sqrt(Math.max(0, s2 / n - m * m)) };
}
function rowDiff(a: Float32Array, ya: number, b: Float32Array, yb: number, w: number): number {
  let d = 0, n = 0;
  for (let x = 0; x < w; x += 3) { d += Math.abs(a[ya * w + x] - b[yb * w + x]); n += 1; }
  return d / n;
}

/** 返回每张图上 / 下要裁掉的行数。 */
export function detectChrome(images: PixelSource[], grays: Float32Array[]): Array<{ top: number; bottom: number }> {
  const maxFrac = 0.22, gap = 8;
  return images.map((img, i) => {
    const { width: w, height: h } = img;
    const limit = Math.floor(h * maxFrac);
    const others = images.map((o, k) => k).filter((k) => k !== i && images[k].width === w && images[k].height >= h * 0.5);
    const isChrome = (y: number, fromBottom: boolean): boolean => {
      if (!others.length) return false;
      const uniform = rowStats(grays[i], w, y).std < 2.5;
      let same = 0;
      for (const k of others) {
        const yo = fromBottom ? images[k].height - (h - y) : y;
        if (yo >= 0 && yo < images[k].height && rowDiff(grays[i], y, grays[k], yo, w) < 6) same += 1;
      }
      // 有内容的行：和任意一张的同一行几乎相同就是界面；纯色行：必须和所有其他张都相同，
      // 否则可能只是图纸顶部 / 底部的空白格（相邻两张同一高度时会撞上）。
      return uniform ? same === others.length : same >= 1;
    };
    const scan = (fromBottom: boolean): number => {
      let last = -1;
      for (let r = 0; r < limit; r += 1) {
        const y = fromBottom ? h - 1 - r : r;
        if (isChrome(y, fromBottom)) last = r;
        else if (r - last > gap) break;
      }
      return last + 1;
    };
    let top = scan(false), bottom = scan(true);
    if (top + bottom > h * 0.4) { top = Math.min(top, Math.floor(h * 0.2)); bottom = Math.min(bottom, Math.floor(h * 0.2)); }
    return { top, bottom };
  });
}

// ---------- FFT ----------
function fft1(re: Float64Array, im: Float64Array, n: number, inverse: boolean, cosT: Float64Array, sinT: Float64Array): void {
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0, k = 0; j < half; j += 1, k += step) {
        const wr = cosT[k], wi = inverse ? sinT[k] : -sinT[k];
        const a = i + j, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
}
const twCache = new Map<number, [Float64Array, Float64Array]>();
function twiddle(n: number): [Float64Array, Float64Array] {
  let t = twCache.get(n);
  if (!t) {
    const c = new Float64Array(n / 2), s = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k += 1) { c[k] = Math.cos((2 * Math.PI * k) / n); s[k] = Math.sin((2 * Math.PI * k) / n); }
    t = [c, s]; twCache.set(n, t);
  }
  return t;
}
/** 二维 FFT（行优先，N1 列 × N2 行），原地。 */
function fft2(re: Float64Array, im: Float64Array, N1: number, N2: number, inverse: boolean): void {
  const [c1, s1] = twiddle(N1), [c2, s2] = twiddle(N2);
  const rr = new Float64Array(N1), ri = new Float64Array(N1);
  for (let y = 0; y < N2; y += 1) {
    const o = y * N1;
    for (let x = 0; x < N1; x += 1) { rr[x] = re[o + x]; ri[x] = im[o + x]; }
    fft1(rr, ri, N1, inverse, c1, s1);
    for (let x = 0; x < N1; x += 1) { re[o + x] = rr[x]; im[o + x] = ri[x]; }
  }
  const cr = new Float64Array(N2), ci = new Float64Array(N2);
  for (let x = 0; x < N1; x += 1) {
    for (let y = 0; y < N2; y += 1) { cr[y] = re[y * N1 + x]; ci[y] = im[y * N1 + x]; }
    fft1(cr, ci, N2, inverse, c2, s2);
    for (let y = 0; y < N2; y += 1) { re[y * N1 + x] = cr[y]; im[y * N1 + x] = ci[y]; }
  }
}
const pow2 = (n: number) => { let p = 1; while (p < n) p <<= 1; return p; };

// ---------- 金字塔与归一化互相关 ----------
type Level = { g: Float32Array; w: number; h: number };
type Pyr = { l0: Level; l1: Level; e1: Level; l2: Level };
type Prepared = { w: number; h: number; pyr: Pyr };

function buildPyr(gray: Float32Array, w: number, h: number, f1: number, f2: number): Pyr {
  const mk = (f: number): Level => {
    const nw = Math.max(8, Math.round(w / f)), nh = Math.max(8, Math.round(h / f));
    return f <= 1.01 ? { g: gray, w, h } : { g: resizeGray(gray, w, h, Math.min(nw, w), Math.min(nh, h)), w: Math.min(nw, w), h: Math.min(nh, h) };
  };
  const l1 = mk(f1);
  return { l0: { g: gray, w, h }, l1, e1: { g: gradient(l1.g, l1.w, l1.h), w: l1.w, h: l1.h }, l2: mk(f2) };
}

function integral(g: Float32Array, w: number, h: number, square: boolean): Float64Array {
  const W = w + 1;
  const out = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let row = 0;
    for (let x = 0; x < w; x += 1) {
      const v = g[y * w + x];
      row += square ? v * v : v;
      out[(y + 1) * W + x + 1] = out[y * W + x + 1] + row;
    }
  }
  return out;
}
const rectSum = (I: Float64Array, w: number, x0: number, y0: number, x1: number, y1: number) => {
  const W = w + 1;
  return I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
};

type Cand = { tx: number; ty: number; score: number };
type FftEntry = { re: Float64Array; im: Float64Array };

const MIN_FRAC = 0.1; // 重叠宽 / 高至少占较小一张的 10%

/** 小图上的互相关：返回若干个候选位移（B 左上角在 A 坐标系里的位置）。 */
function coarseCandidates(a: Level, b: Level, cache: Map<string, FftEntry>, keyA: string, keyB: string, K: number): Cand[] {
  const N1 = pow2(a.w + b.w), N2 = pow2(a.h + b.h);
  const prep = (lv: Level, key: string): { f: FftEntry; zero: Float32Array } => {
    let mean = 0;
    for (let i = 0; i < lv.g.length; i += 1) mean += lv.g[i];
    mean /= lv.g.length;
    const zero = new Float32Array(lv.g.length);
    for (let i = 0; i < zero.length; i += 1) zero[i] = lv.g[i] - mean;
    const k = `${key}|${N1}x${N2}`;
    let f = cache.get(k);
    if (!f) {
      const re = new Float64Array(N1 * N2), im = new Float64Array(N1 * N2);
      for (let y = 0; y < lv.h; y += 1) for (let x = 0; x < lv.w; x += 1) re[y * N1 + x] = zero[y * lv.w + x];
      fft2(re, im, N1, N2, false);
      f = { re, im }; cache.set(k, f);
    }
    return { f, zero };
  };
  const A = prep(a, keyA), B = prep(b, keyB);
  const re = new Float64Array(N1 * N2), im = new Float64Array(N1 * N2);
  for (let i = 0; i < re.length; i += 1) {
    const ar = A.f.re[i], ai = A.f.im[i], br = B.f.re[i], bi = B.f.im[i];
    // A * conj(B)，再取共轭做逆变换
    re[i] = ar * br + ai * bi; im[i] = -(ai * br - ar * bi);
  }
  fft2(re, im, N1, N2, false); // 共轭 + 正变换 = 逆变换（实数结果只需 re / N）
  const norm = 1 / (N1 * N2);
  const Ia = integral(A.zero, a.w, a.h, false), Ia2 = integral(A.zero, a.w, a.h, true);
  const Ib = integral(B.zero, b.w, b.h, false), Ib2 = integral(B.zero, b.w, b.h, true);
  const minOW = Math.max(6, Math.floor(MIN_FRAC * Math.min(a.w, b.w))), minOH = Math.max(6, Math.floor(MIN_FRAC * Math.min(a.h, b.h)));
  const minArea = 0.05 * Math.min(a.w * a.h, b.w * b.h);
  const SW = a.w + b.w - 1, SH = a.h + b.h - 1;
  const score = new Float32Array(SW * SH).fill(-1);
  for (let ty = -(b.h - 1); ty <= a.h - 1; ty += 1) {
    const oy0 = Math.max(0, ty), oy1 = Math.min(a.h, ty + b.h);
    const oh = oy1 - oy0;
    if (oh < minOH) continue;
    for (let tx = -(b.w - 1); tx <= a.w - 1; tx += 1) {
      const ox0 = Math.max(0, tx), ox1 = Math.min(a.w, tx + b.w);
      const ow = ox1 - ox0;
      if (ow < minOW || ow * oh < minArea) continue;
      const n = ow * oh;
      const sa = rectSum(Ia, a.w, ox0, oy0, ox1, oy1), sa2 = rectSum(Ia2, a.w, ox0, oy0, ox1, oy1);
      const sb = rectSum(Ib, b.w, ox0 - tx, oy0 - ty, ox1 - tx, oy1 - ty), sb2 = rectSum(Ib2, b.w, ox0 - tx, oy0 - ty, ox1 - tx, oy1 - ty);
      const va = sa2 - (sa * sa) / n, vb = sb2 - (sb * sb) / n;
      if (va < 4 * n || vb < 4 * n) continue; // 标准差 < 2 灰阶：纯色区域没有信息
      const cx = ((tx % N1) + N1) % N1, cy = ((ty % N2) + N2) % N2;
      const num = re[cy * N1 + cx] * norm - (sa * sb) / n;
      const ncc = num / Math.sqrt(va * vb);
      score[(ty + b.h - 1) * SW + tx + b.w - 1] = ncc * Math.min(1, Math.sqrt(n / (0.15 * Math.min(a.w * a.h, b.w * b.h))));
    }
  }
  const out: Cand[] = [];
  const rad = Math.max(2, Math.round(0.03 * Math.max(a.w, a.h)));
  for (let k = 0; k < K; k += 1) {
    let best = 0, bi = -1;
    for (let i = 0; i < score.length; i += 1) if (score[i] > best) { best = score[i]; bi = i; }
    if (bi < 0) break;
    const sx = bi % SW, sy = (bi - sx) / SW;
    out.push({ tx: sx - (b.w - 1), ty: sy - (b.h - 1), score: best });
    for (let y = Math.max(0, sy - rad); y <= Math.min(SH - 1, sy + rad); y += 1) for (let x = Math.max(0, sx - rad); x <= Math.min(SW - 1, sx + rad); x += 1) score[y * SW + x] = -1;
  }
  return out;
}

/** 直接在重叠区抽样计算归一化互相关。 */
function nccAt(a: Level, b: Level, tx: number, ty: number, cap: number): number {
  const ox0 = Math.max(0, tx), ox1 = Math.min(a.w, tx + b.w), oy0 = Math.max(0, ty), oy1 = Math.min(a.h, ty + b.h);
  const ow = ox1 - ox0, oh = oy1 - oy0;
  if (ow < 6 || oh < 6) return -1;
  const step = Math.max(1, Math.ceil(Math.sqrt((ow * oh) / cap)));
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = oy0; y < oy1; y += step) {
    const ra = y * a.w, rb = (y - ty) * b.w - tx;
    for (let x = ox0; x < ox1; x += step) {
      const va = a.g[ra + x], vb = b.g[rb + x];
      n += 1; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
  }
  const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  if (va < 4 * n || vb < 4 * n) return 0;
  return (sab - (sa * sb) / n) / Math.sqrt(va * vb);
}

type Match = { tx: number; ty: number; score: number; s: number };

/** A 不动，B（已按 s 缩放）在 A 坐标系里的位置。 */
function matchPair(A: Prepared, B: Prepared, f1: number, cache: Map<string, FftEntry>, keyA: string, keyB: string, s: number, minCoarse: number): Match | null {
  const cands = coarseCandidates(A.pyr.l2, B.pyr.l2, cache, keyA, keyB, 5);
  if (!cands.length || cands[0].score < minCoarse) return null;
  const kx2 = A.pyr.l0.w / A.pyr.l2.w, ky2 = A.pyr.l0.h / A.pyr.l2.h;
  const kx1 = A.pyr.l1.w / A.pyr.l0.w, ky1 = A.pyr.l1.h / A.pyr.l0.h;
  const scored: Array<{ tx: number; ty: number; v: number }> = [];
  for (const c of cands) {
    // 在 L1 里精修（灰度 + 边缘）
    const cx = Math.round(c.tx * kx2 * kx1), cy = Math.round(c.ty * ky2 * ky1);
    const r = Math.ceil(Math.max(kx2 * kx1, ky2 * ky1)) + 1;
    let best = { tx: cx, ty: cy, v: -2 };
    for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
      const g = nccAt(A.pyr.l1, B.pyr.l1, cx + dx, cy + dy, 6000);
      if (g < 0.2) continue;
      const e = nccAt(A.pyr.e1, B.pyr.e1, cx + dx, cy + dy, 6000);
      const v = 0.5 * g + 0.5 * e;
      if (v > best.v) best = { tx: cx + dx, ty: cy + dy, v };
    }
    if (best.v > -2) scored.push(best);
  }
  scored.sort((p, q) => q.v - p.v);
  let out: Match | null = null;
  for (const c of scored.slice(0, 2)) {
    const bx = Math.round(c.tx / kx1), by = Math.round(c.ty / ky1);
    const r = Math.ceil(f1) + 1;
    for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) {
      const v = nccAt(A.pyr.l0, B.pyr.l0, bx + dx, by + dy, 40000);
      if (!out || v > out.score) out = { tx: bx + dx, ty: by + dy, score: v, s };
    }
  }
  if (!out) return null;
  // 重叠足够大才可信：最终用更多采样点复核一次
  out.score = nccAt(A.pyr.l0, B.pyr.l0, out.tx, out.ty, 120000);
  return out;
}

// ---------- 主流程 ----------
type Edge = { i: number; j: number; m: Match };
type Tf = { scale: number; x: number; y: number };

const cn = (list: number[]) => list.map((i) => i + 1).join("、");

export function stitchScreens(images: PixelSource[], opts: StitchOptions = {}): StitchResult {
  const o = { ...DEFAULTS, ...opts };
  const progress = (p: number, label: string) => o.onProgress?.(Math.round(p), label);
  const n = images.length;
  const warnings: string[] = [];
  if (!n) throw new Error("没有图片");
  if (n === 1) {
    const im = images[0];
    return { image: im, placements: [{ x: 0, y: 0, scale: 1 }], rects: [{ x: 0, y: 0, width: im.width, height: im.height }], included: [true], crops: [{ top: 0, bottom: 0 }], confidence: 1, warnings: ["只有一张图，不需要拼接"], links: [] };
  }

  progress(2, "裁掉手机界面");
  const grays = images.map(toGray);
  const crops = o.cropChrome === false ? images.map(() => ({ top: 0, bottom: 0 })) : detectChrome(images, grays);
  const croppedGray = images.map((im, i) => grays[i].subarray(crops[i].top * im.width, (im.height - crops[i].bottom) * im.width));
  const dims = images.map((im, i) => ({ w: im.width, h: im.height - crops[i].top - crops[i].bottom }));
  const longest = Math.max(...dims.map((d) => Math.max(d.w, d.h)));
  const f2 = Math.max(1, longest / 224);
  const f1 = f2 <= 1.5 ? 1 : Math.max(1, Math.round(f2 / 3.5));

  const prepCache = new Map<string, Prepared>();
  const fftCache = new Map<string, FftEntry>();
  const prepare = (i: number, s: number): Prepared => {
    const key = `${i}@${s}`;
    let p = prepCache.get(key);
    if (!p) {
      const { w, h } = dims[i];
      if (s === 1) p = { w, h, pyr: buildPyr(croppedGray[i], w, h, f1, f2) };
      else {
        const nw = Math.max(8, Math.round(w * s)), nh = Math.max(8, Math.round(h * s));
        p = { w: nw, h: nh, pyr: buildPyr(resizeGray(croppedGray[i], w, h, nw, nh), nw, nh, f1, f2) };
      }
      prepCache.set(key, p);
    }
    return p;
  };

  progress(8, "寻找重叠部分");
  const edges: Edge[] = [];
  const total = (n * (n - 1)) / 2;
  let done = 0;
  const tryPair = (i: number, j: number, s: number): Match | null => {
    const A = prepare(i, 1), B = prepare(j, s);
    return matchPair(A, B, f1, fftCache, `${i}@1`, `${j}@${s}`, s, 0.3);
  };
  for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) {
    const m = tryPair(i, j, 1);
    if (m && m.score >= o.minScore) edges.push({ i, j, m });
    done += 1; progress(8 + (done / total) * 62, "寻找重叠部分");
  }

  const components = (): number[] => {
    const parent = images.map((_, k) => k);
    const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
    for (const e of edges) parent[find(e.i)] = find(e.j);
    return images.map((_, k) => find(k));
  };
  // 有图没接上：对跨组的图对再试几个缩放比例（±5% 内）
  let comp = components();
  if (new Set(comp).size > 1) {
    progress(70, "尝试缩放差异");
    for (const s of [0.975, 1.025, 0.95, 1.05]) {
      for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) {
        if (comp[i] === comp[j]) continue;
        const m = tryPair(i, j, s);
        if (m && m.score >= Math.max(o.minScore, 0.8)) edges.push({ i, j, m });
      }
      comp = components();
      if (new Set(comp).size === 1) break;
    }
  }

  // 最大生成树
  progress(74, "排布");
  const parent = images.map((_, k) => k);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const tree: Edge[] = [];
  for (const e of [...edges].sort((p, q) => q.m.score - p.m.score)) {
    const a = find(e.i), b = find(e.j);
    if (a !== b) { parent[a] = b; tree.push(e); }
  }
  const root0 = images.map((_, k) => find(k));
  const sizeOf = new Map<number, number>();
  root0.forEach((r) => sizeOf.set(r, (sizeOf.get(r) ?? 0) + 1));
  const biggest = Math.max(...sizeOf.values());
  const mainRoot = root0.find((r) => sizeOf.get(r) === biggest)!;
  const included = root0.map((r) => r === mainRoot);
  const rootIdx = included.indexOf(true);

  const tf: Array<Tf | null> = images.map(() => null);
  tf[rootIdx] = { scale: 1, x: 0, y: 0 };
  const adj = new Map<number, Edge[]>();
  for (const e of tree) { (adj.get(e.i) ?? adj.set(e.i, []).get(e.i)!).push(e); (adj.get(e.j) ?? adj.set(e.j, []).get(e.j)!).push(e); }
  const queue = [rootIdx];
  while (queue.length) {
    const a = queue.shift()!;
    for (const e of adj.get(a) ?? []) {
      const b = e.i === a ? e.j : e.i;
      if (tf[b]) continue;
      const T = tf[a]!;
      const { tx, ty, s } = e.m;
      // 边的含义：p_i = s · p_j + t（s 缩放的是 j）
      if (e.i === a) tf[b] = { scale: T.scale * s, x: T.x + T.scale * tx, y: T.y + T.scale * ty };
      else tf[b] = { scale: T.scale / s, x: T.x - (T.scale * tx) / s, y: T.y - (T.scale * ty) / s };
      queue.push(b);
    }
  }

  // 输出范围
  const idxs = images.map((_, k) => k).filter((k) => included[k]);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const k of idxs) {
    const t = tf[k]!;
    minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + dims[k].w * t.scale); maxY = Math.max(maxY, t.y + dims[k].h * t.scale);
  }
  const W0 = maxX - minX, H0 = maxY - minY;
  const f = Math.min(1, o.maxEdge / Math.max(W0, H0), Math.sqrt(o.maxPixels / (W0 * H0)));
  const outW = Math.max(1, Math.round(W0 * f)), outH = Math.max(1, Math.round(H0 * f));
  if (f < 1) warnings.push(`拼出来的图很大，已缩小到 ${outW}×${outH}`);

  progress(78, "合成");
  const out = new Uint8ClampedArray(outW * outH * 4).fill(255);
  type Item = { k: number; sc: number; px: number; py: number; w: number; h: number; x0: number; x1: number; y0: number; y1: number; direct: boolean };
  const items: Item[] = idxs.map((k) => {
    const t = tf[k]!;
    const sc = t.scale * f, px = (t.x - minX) * f, py = (t.y - minY) * f;
    const w = dims[k].w, h = dims[k].h;
    const direct = Math.abs(sc - 1) < 1e-9 && Math.abs(px - Math.round(px)) < 1e-9 && Math.abs(py - Math.round(py)) < 1e-9;
    return { k, sc, px, py, w, h, x0: Math.max(0, Math.floor(px)), x1: Math.min(outW, Math.ceil(px + w * sc)), y0: Math.max(0, Math.floor(py)), y1: Math.min(outH, Math.ceil(py + h * sc)), direct };
  });
  for (let oy = 0; oy < outH; oy += 1) {
    const row = items.filter((it) => oy >= it.y0 && oy < it.y1);
    if (!row.length) continue;
    if (oy % 64 === 0) progress(78 + (oy / outH) * 20, "合成");
    for (let ox = 0; ox < outW; ox += 1) {
      let best = -1, bk: Item | null = null, bu = 0, bv = 0;
      for (const it of row) {
        if (ox < it.x0 || ox >= it.x1) continue;
        const u = (ox + 0.5 - it.px) / it.sc, v = (oy + 0.5 - it.py) / it.sc;
        if (u < 0 || v < 0 || u >= it.w || v >= it.h) continue;
        const wgt = Math.min(u, it.w - u, v, it.h - v) * it.sc;
        if (wgt > best) { best = wgt; bk = it; bu = u; bv = v; }
      }
      if (!bk) continue;
      const src = images[bk.k], sy0 = crops[bk.k].top;
      const o4 = (oy * outW + ox) * 4;
      if (bk.direct) {
        const si = ((sy0 + Math.floor(bv)) * src.width + Math.floor(bu)) * 4;
        out[o4] = src.data[si]; out[o4 + 1] = src.data[si + 1]; out[o4 + 2] = src.data[si + 2]; out[o4 + 3] = 255;
      } else {
        const fx = Math.max(0, Math.min(src.width - 1, bu - 0.5)), fy = Math.max(sy0, Math.min(sy0 + bk.h - 1, bv - 0.5 + sy0));
        const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(sy0 + bk.h - 1, y0 + 1);
        const ax = fx - x0, ay = fy - y0;
        for (let c = 0; c < 3; c += 1) {
          const p00 = src.data[(y0 * src.width + x0) * 4 + c], p10 = src.data[(y0 * src.width + x1) * 4 + c];
          const p01 = src.data[(y1 * src.width + x0) * 4 + c], p11 = src.data[(y1 * src.width + x1) * 4 + c];
          out[o4 + c] = (p00 * (1 - ax) + p10 * ax) * (1 - ay) + (p01 * (1 - ax) + p11 * ax) * ay;
        }
        out[o4 + 3] = 255;
      }
    }
  }

  const placements: StitchPlacement[] = images.map((_, k) => {
    if (!included[k]) return { x: 0, y: 0, scale: 1 };
    const t = tf[k]!;
    const sc = t.scale * f;
    return { x: (t.x - minX) * f, y: (t.y - minY) * f - crops[k].top * sc, scale: sc };
  });
  const rects = images.map((_, k) => {
    if (!included[k]) return null;
    const t = tf[k]!;
    return { x: (t.x - minX) * f, y: (t.y - minY) * f, width: dims[k].w * t.scale * f, height: dims[k].h * t.scale * f };
  });

  // 警告与可信度
  const excluded = included.map((v, k) => (v ? -1 : k)).filter((k) => k >= 0);
  if (excluded.length) warnings.push(`第 ${cn(excluded)} 张没有找到重叠部分，请截图时让相邻两张重叠约 1/4`);
  for (const e of tree) {
    if (e.m.score < 0.88) warnings.push(`第 ${e.i + 1}、${e.j + 1} 张的接缝不太确定（相似度 ${Math.round(e.m.score * 100)}%），请放大检查`);
    if (Math.abs(e.m.s - 1) > 0.01) warnings.push(`第 ${e.j + 1} 张和第 ${e.i + 1} 张的缩放不一样（约 ${Math.round((e.m.s - 1) * 100)}%），已自动对齐；最好每张用同样的放大倍数`);
  }
  const minScore = tree.length ? Math.min(...tree.map((e) => e.m.score)) : 0;
  const confidence = Math.max(0, Math.min(1, minScore)) * (idxs.length / n);
  progress(100, "完成");
  return { image: { width: outW, height: outH, data: out }, placements, rects, included, crops, confidence, warnings, links: tree.map((e) => [e.i, e.j, e.m.score]) };
}
