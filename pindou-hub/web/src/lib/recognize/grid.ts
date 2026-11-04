// 网格检测 + 逐格读色。全部是确定性的纯函数，不依赖 DOM，可在 vitest(node) 里直接跑。
import { ciede2000, rgbToHex, rgbToLab } from "@engine/color";
import { MARD_PALETTE } from "@engine/palette";
import type { Lab, PixelSource } from "@engine/types";
import type { CellColorStat, ColorCluster, GridDetection, GridReading, Rect } from "./types";

const MIN_PITCH = 4;
const MAX_LAG = 250;

// ───────────────────────── 边缘投影 ─────────────────────────

/** colP[x]：第 x 与 x+1 列之间的颜色差之和；rowP[y] 同理。索引 i 对应边界坐标 i+1。 */
function profiles(src: PixelSource, x0: number, y0: number, x1: number, y1: number, want: "col" | "row" | "both" = "both") {
  const needCol = want !== "row";
  const needRow = want !== "col";
  const w = x1 - x0;
  const h = y1 - y0;
  const colP = new Float64Array(Math.max(0, w - 1));
  const rowP = new Float64Array(Math.max(0, h - 1));
  const d = src.data;
  const stride = src.width * 4;
  for (let y = y0; y < y1; y += 1) {
    let i = (y * src.width + x0) * 4;
    const down = y < y1 - 1;
    let acc = 0;
    for (let x = 0; x < w; x += 1, i += 4) {
      if (needCol && x < w - 1) {
        colP[x] += Math.abs(d[i] - d[i + 4]) + Math.abs(d[i + 1] - d[i + 5]) + Math.abs(d[i + 2] - d[i + 6]);
      }
      if (needRow && down) {
        const j = i + stride;
        acc += Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]);
      }
    }
    if (needRow && down) rowP[y - y0] = acc;
  }
  return { colP, rowP };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function max3(P: Float64Array): Float64Array {
  const out = new Float64Array(P.length);
  for (let i = 0; i < P.length; i += 1) {
    out[i] = Math.max(P[i], i > 0 ? P[i - 1] : 0, i + 1 < P.length ? P[i + 1] : 0);
  }
  return out;
}

// ───────────────────────── 周期（梳齿）搜索 ─────────────────────────

type Lattice = {
  pitch: number;
  /** [齿序号 k, 实测位置]，仅强齿；位置为 profile 坐标（边界坐标） */
  pts: Array<[number, number]>;
  ka: number;
  kb: number;
  score: number;
};

type CombFit = { pitch: number; phase: number; score: number };

/** 在 [lo,hi] 内找使“齿位置处 P 的平均值（去均值）”最大的 (pitch, phase)。 */
function combSearch(
  Pm: Float64Array, mean: number, lo: number, hi: number, step: number,
  phaseLo?: number, phaseHi?: number, phaseStep = 0.25
): CombFit {
  const n = Pm.length;
  let best: CombFit = { pitch: (lo + hi) / 2, phase: 0, score: -Infinity };
  for (let p = lo; p <= hi + 1e-9; p += step) {
    const a = phaseLo ?? 0;
    const b = phaseHi ?? p;
    for (let ph = a; ph < b; ph += phaseStep) {
      let sum = 0;
      let cnt = 0;
      for (let pos = ph; pos < n - 1; pos += p) {
        const idx = Math.round(pos);
        if (idx < 0) continue;
        sum += Pm[idx] - mean;
        cnt += 1;
      }
      if (cnt < 3) continue;
      const s = sum / cnt;
      if (s > best.score) best = { pitch: p, phase: ph, score: s };
    }
  }
  return best;
}

function smooth121(P: Float64Array): Float64Array {
  const out = new Float64Array(P.length);
  for (let i = 0; i < P.length; i += 1) {
    out[i] = (2 * P[i] + (i > 0 ? P[i - 1] : P[i]) + (i + 1 < P.length ? P[i + 1] : P[i])) / 4;
  }
  return out;
}

/** 自相关粗估周期：取“≥0.8×最大值的局部峰”中最小的滞后。 */
function coarsePitch(P: Float64Array): number | null {
  const n = P.length;
  const S = smooth121(P);
  const maxLag = Math.min(MAX_LAG, Math.floor(n / 4));
  if (maxLag < MIN_PITCH + 1) return null;
  // 去趋势：减去 ~15px 滑动平均
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) pre[i + 1] = pre[i] + S[i];
  const dt = new Float64Array(n);
  let v0 = 0;
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - 7);
    const b = Math.min(n, i + 8);
    dt[i] = S[i] - (pre[b] - pre[a]) / (b - a);
    v0 += dt[i] * dt[i];
  }
  if (v0 < 1e-9) return null;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = MIN_PITCH - 1; lag <= maxLag + 1; lag += 1) {
    let s = 0;
    for (let i = 0; i + lag < n; i += 1) s += dt[i] * dt[i + lag];
    ac[lag] = (s / (n - lag)) / (v0 / n);
  }
  let best = 0;
  for (let lag = MIN_PITCH; lag <= maxLag; lag += 1) best = Math.max(best, ac[lag]);
  if (best < 0.1) return null;
  for (let lag = MIN_PITCH; lag <= maxLag; lag += 1) {
    if (ac[lag] >= 0.8 * best && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) return lag;
  }
  return null;
}

/**
 * 在 profile 上找规则网格线。lineLen 是该 profile 每个点累加的垂直像素数（用于绝对强度门槛）。
 * hint：已知另一轴的周期时，跳过自相关，只在其附近细搜。
 */
/** 同一周期下会有多组“假网格”（格内文字上下沿、色块边缘）；真网格线横贯整行，覆盖率最高。 */
function choosePhase(Pm: Float64Array, mean: number, p: number, cov: (pos: number) => number): number {
  const n = Pm.length;
  const steps = Math.max(4, Math.round(p / 0.25));
  const sc: number[] = [];
  for (let i = 0; i < steps; i += 1) {
    const ph = (i * p) / steps;
    let sum = 0, cnt = 0;
    for (let pos = ph; pos < n - 1; pos += p) { sum += Pm[Math.round(pos)] - mean; cnt += 1; }
    sc.push(cnt ? sum / cnt : -Infinity);
  }
  const best = Math.max(...sc);
  const cands: number[] = [];
  for (let i = 0; i < steps; i += 1) {
    if (sc[i] >= 0.5 * best && sc[i] >= sc[(i + steps - 1) % steps] && sc[i] >= sc[(i + 1) % steps]) cands.push(i);
  }
  cands.sort((a, b) => sc[b] - sc[a]);
  let bestPh = (cands[0] * p) / steps;
  let bestCov = -1;
  for (const i of cands.slice(0, 4)) {
    const ph = (i * p) / steps;
    const vals: number[] = [];
    for (let pos = ph; pos < n - 2; pos += p) vals.push(cov(pos));
    vals.sort((a, b) => a - b);
    const q75 = vals[Math.floor(vals.length * 0.75)] ?? 0;
    if (q75 > bestCov * 1.05) { bestCov = q75; bestPh = ph; }
  }
  return bestPh;
}

/** 用高强度齿的实测质心做线性回归，修正梳齿搜索的步长量化误差（否则远端齿会偏 1px 以上）。 */
function refineFit(P: Float64Array, Pm: Float64Array, fit: CombFit): CombFit {
  const n = P.length;
  let { pitch, phase } = fit;
  for (let iter = 0; iter < 3; iter += 1) {
    const ks: number[] = [];
    const vals: number[] = [];
    for (let k = 0; phase + k * pitch < n - 1; k += 1) {
      ks.push(k);
      vals.push(Pm[Math.round(phase + k * pitch)]);
    }
    if (ks.length < 6) break;
    const thr = [...vals].sort((a, b) => a - b)[Math.floor(vals.length * 0.5)];
    const half = Math.max(1, Math.min(2, Math.floor(pitch / 2.5)));
    const pts: Array<[number, number]> = [];
    ks.forEach((k, j) => {
      if (vals[j] < thr) return;
      const c = Math.round(phase + k * pitch);
      let lo = Infinity;
      for (let i = Math.max(0, c - half - 1); i <= Math.min(n - 1, c + half + 1); i += 1) lo = Math.min(lo, P[i]);
      let sw = 0, sx = 0;
      for (let i = Math.max(0, c - half); i <= Math.min(n - 1, c + half); i += 1) { const w = P[i] - lo; sw += w; sx += w * i; }
      if (sw > 0) pts.push([k, sx / sw]);
    });
    if (pts.length < 6) break;
    let fitted = linearFit(pts);
    const resid = pts.filter(([k, x]) => Math.abs(x - (fitted.a + k * fitted.b)) < 1.5);
    if (resid.length >= 6 && resid.length < pts.length) fitted = linearFit(resid);
    if (Math.abs(fitted.b - pitch) / pitch > 0.02) break; // 拟合偏离过大，不可信
    pitch = fitted.b;
    phase = fitted.a;
    if (phase < 0) { /* 保持首齿在 0 之后 */ phase += pitch; }
  }
  return { ...fit, pitch, phase };
}

function linearFit(pts: Array<[number, number]>): { a: number; b: number } {
  const n = pts.length;
  let sk = 0, sx = 0, skk = 0, skx = 0;
  for (const [k, x] of pts) { sk += k; sx += x; skk += k * k; skx += k * x; }
  const den = n * skk - sk * sk;
  const b = den ? (n * skx - sk * sx) / den : 0;
  return { a: (sx - b * sk) / n, b };
}

function findLattice(P: Float64Array, lineLen: number, hint?: number, cov?: (pos: number) => number): Lattice | null {
  const n = P.length;
  if (n < 24 || lineLen < 8) return null;
  const Pm = max3(P);
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += Pm[i];
  mean /= n;
  const base = median(Array.from(Pm));

  let fit: CombFit;
  if (hint) {
    fit = combSearch(Pm, mean, hint * 0.94, hint * 1.06, 0.02);
    if (cov) fit = { ...fit, phase: choosePhase(Pm, mean, fit.pitch, cov) };
    fit = refineFit(P, Pm, fit);
  } else {
    const L = coarsePitch(P);
    if (!L) return null;
    fit = combSearch(Pm, mean, L - 1, L + 1, L < 40 ? 0.02 : 0.04);
    if (cov) fit = { ...fit, phase: choosePhase(Pm, mean, fit.pitch, cov) };
    fit = refineFit(P, Pm, fit);
    // 粗周期可能是真周期的整数倍（每 5/10 格的粗线）：检查子格位置是否也有线
    let kBest = 1;
    const teeth: number[] = [];
    for (let pos = fit.phase; pos < n - 1; pos += fit.pitch) teeth.push(pos);
    const tv = teeth.map((t) => Pm[Math.round(t)] - base);
    const sorted = [...tv].sort((a, b) => a - b);
    const q90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    const sel: number[] = [];
    tv.forEach((v, j) => { if (q90 > 0 && v >= 0.5 * q90) sel.push(j); });
    if (sel.length >= 3) {
      // 用“尖峰突出度”而不是绝对强度判断子格：格内的文字/色块边缘也会给子格位置带来强度，
      // 但它们不像真正的网格线那样是孤立的窄尖峰
      const prom = (idx: number, d: number) => {
        const lo = idx - d >= 0 ? Pm[idx - d] : 0;
        const hi = idx + d < n ? Pm[idx + d] : 0;
        return Math.max(0, Pm[Math.min(n - 1, Math.max(0, idx))] - Math.max(lo, hi));
      };
      const lineCov = cov ? median(sel.map((j) => cov(fit.phase + j * fit.pitch))) : 0;
      for (let k = 2; k <= 16; k += 1) {
        const pk = fit.pitch / k;
        if (pk < MIN_PITCH) break;
        let ok = true;
        if (cov) {
          // 子格位置也必须有“横贯整行”的线（而不只是文字 / 棋盘格空格的边缘），且是孤立的窄尖峰
          if (lineCov < 0.1) break;
          for (let m = 1; m < k && ok; m += 1) {
            const vals = sel.map((j) => cov(fit.phase + (j + m / k) * fit.pitch));
            if (median(vals) < 0.75 * lineCov) ok = false;
          }
        } else {
          const d = Math.max(3, Math.round(pk / 2));
          const strongProm = median(sel.map((j) => prom(Math.round(fit.phase + j * fit.pitch), d)));
          if (strongProm <= 0) continue;
          for (let m = 1; m < k && ok; m += 1) {
            const vals: number[] = [];
            for (const j of sel) vals.push(prom(Math.round(fit.phase + (j + m / k) * fit.pitch), d));
            if (median(vals) < 0.3 * strongProm) ok = false;
          }
        }
        if (ok) kBest = k;
      }
    }
    if (kBest > 1) {
      const pk = fit.pitch / kBest;
      const ph0 = fit.phase - Math.floor(fit.phase / pk) * pk;
      fit = combSearch(Pm, mean, pk - 0.15, pk + 0.15, 0.01, Math.max(0, ph0 - 1), ph0 + 1, 0.1);
      fit = refineFit(P, Pm, fit);
    }
  }

  const p = fit.pitch;
  const phase = fit.phase;
  const K = Math.floor((n - 1 - phase) / p) + 1;
  if (K < 4) return null;
  const s: number[] = [];
  const mids: number[] = [];
  for (let k = 0; k < K; k += 1) {
    s.push(Pm[Math.min(n - 1, Math.round(phase + k * p))]);
    const mi = Math.round(phase + (k + 0.5) * p);
    if (mi < n) mids.push(Pm[mi]);
  }
  const baseMid = median(mids);
  const sp = s.map((v) => Math.max(0, v - baseMid));
  const sortedS = [...sp].sort((a, b) => b - a);
  const q = sortedS[Math.floor(K * 0.1)] ?? 0;
  if (q <= 0) return null;
  const ref = median(sp.filter((v) => v >= 0.2 * q));
  const thr = 0.45 * ref; // 太低会把图例色块的边缘当成网格线延伸出去
  let strong = sp.map((v) => v >= thr);
  // 有覆盖率函数时，以“边缘是否横贯整行”判定强齿（不受格内文字边缘的能量干扰）
  const covs: number[] = [];
  let refCov = 0;
  if (cov) {
    for (let k = 0; k < K; k += 1) covs.push(cov(phase + k * p));
    refCov = [...covs].sort((a, b) => a - b)[Math.floor((K - 1) * 0.75)];
    if (refCov < 0.15) return null;
    strong = covs.map((c) => c >= 0.5 * refCov);
  }

  // 最长的强齿序列，允许中间最多 3 个弱齿
  let bestRun: [number, number, number] | null = null; // [start,end,strongCount]
  let k = 0;
  while (k < K) {
    if (!strong[k]) { k += 1; continue; }
    let start = k;
    let last = k;
    let cnt = 1;
    let j = k + 1;
    while (j < K && j - last <= 4) {
      if (strong[j]) { last = j; cnt += 1; }
      j += 1;
    }
    if (!bestRun || cnt > bestRun[2]) bestRun = [start, last, cnt];
    k = last + 1;
  }
  if (!bestRun || bestRun[1] - bestRun[0] < 3) return null;
  let [ka, kb, strongCount] = bestRun;
  // 实测每个强齿的质心，后面做线性回归得到亚像素周期
  const half = Math.max(1, Math.min(2, Math.floor(p / 2.5)));
  const pts: Array<[number, number]> = [];
  for (let kk = ka; kk <= kb; kk += 1) {
    if (!strong[kk]) continue;
    const c = Math.round(phase + kk * p);
    let sw = 0;
    let sx = 0;
    for (let i = Math.max(0, c - half); i <= Math.min(n - 1, c + half); i += 1) {
      const w = Math.max(0, P[i] - baseMid);
      sw += w;
      sx += w * (i + 1);
    }
    pts.push([kk, sw > 0 ? sx / sw : c + 1]);
  }

  let meanStrong = 0;
  for (let kk = ka; kk <= kb; kk += 1) if (strong[kk]) meanStrong += s[kk];
  meanStrong /= strongCount;
  if (meanStrong / lineLen < 5) return null; // 绝对强度太低：平滑渐变 / 空白
  let contrast = Math.max(0, Math.min(1, 1 - baseMid / meanStrong));
  if (cov) {
    const cs: number[] = [];
    const cm: number[] = [];
    for (let kk = ka; kk <= kb; kk += 1) {
      if (strong[kk]) cs.push(covs[kk]);
      cm.push(cov(phase + (kk + 0.5) * p));
    }
    contrast = Math.max(0, Math.min(1, 1 - median(cm) / Math.max(1e-6, median(cs))));
  }
  const regularity = strongCount / (kb - ka + 1);
  const lenFactor = Math.sqrt(Math.min(1, (kb - ka + 1) / 6));
  const score = (0.6 * contrast + 0.4 * regularity) * lenFactor;
  return { pitch: p, pts, ka, kb, score };
}

/** 对 pts 做线性回归 pos = a + (k-ka)*pitch；fixedPitch 时只拟合截距。 */
function regress(l: Lattice, fixedPitch?: number): { a: number; pitch: number } {
  const pts = l.pts;
  if (pts.length < 3) {
    const first = pts[0];
    return { a: first ? first[1] - (first[0] - l.ka) * (fixedPitch ?? l.pitch) : 0, pitch: fixedPitch ?? l.pitch };
  }
  if (fixedPitch) {
    let s = 0;
    for (const [k, pos] of pts) s += pos - (k - l.ka) * fixedPitch;
    return { a: s / pts.length, pitch: fixedPitch };
  }
  const n = pts.length;
  let sk = 0, sp = 0, skk = 0, skp = 0;
  for (const [k, pos] of pts) {
    const kk = k - l.ka;
    sk += kk; sp += pos; skk += kk * kk; skp += kk * pos;
  }
  const den = n * skk - sk * sk;
  if (Math.abs(den) < 1e-9) return { a: pts[0][1], pitch: l.pitch };
  const pitch = (n * skp - sk * sp) / den;
  const a = (sp - pitch * sk) / n;
  // 回归结果与梳齿结果偏差过大时不信回归
  if (Math.abs(pitch - l.pitch) / l.pitch > 0.03) return { a: sp / n - l.pitch * (sk / n), pitch: l.pitch };
  return { a, pitch };
}

// ───────────────────────── 对外：detectGrid ─────────────────────────

function regionBounds(src: PixelSource, region?: Rect | null) {
  const x0 = Math.max(0, Math.floor(region?.x ?? 0));
  const y0 = Math.max(0, Math.floor(region?.y ?? 0));
  const x1 = Math.min(src.width, Math.ceil((region ? region.x + region.width : src.width)));
  const y1 = Math.min(src.height, Math.ceil((region ? region.y + region.height : src.height)));
  return { x0, y0, x1, y1 };
}

export type GridHint = { cols?: number | null; rows?: number | null };

/**
 * 检测网格。hint 给出已知的列数 / 行数（图纸抬头“尺寸:55x61”、用户手动指定）时作为强先验：
 * 自动检测对不上就按“格距 ≈ 宽度/(列数+k)”逐个试，取尺寸最接近的，再把多出 / 缺少的整格（标尺行列）补齐。
 */
export function detectGrid(src: PixelSource, region?: Rect | null, hint?: GridHint | null): GridDetection | null {
  const base = detectCore(src, region);
  const hc = hint?.cols && hint.cols > 0 ? Math.round(hint.cols) : 0;
  const hr = hint?.rows && hint.rows > 0 ? Math.round(hint.rows) : 0;
  if (!hc && !hr) return base;
  const ok = (g: GridDetection | null) => !!g && (!hc || g.cols === hc) && (!hr || g.rows === hr);
  if (ok(base)) return base;
  if (base) {
    const fitted = fitToSize(src, base, region, hc, hr);
    if (ok(fitted)) return fitted;
  }
  const { x0, y0, x1, y1 } = regionBounds(src, region);
  let best: { g: GridDetection; err: number } | null = null;
  for (let k = 0; k <= 6; k += 1) {
    const p = hc ? (x1 - x0) / (hc + k) : (y1 - y0) / (hr + k);
    if (p < 4) break;
    const g = detectCore(src, region, p);
    if (!g) continue;
    const err = (hc ? Math.abs(g.cols - hc) : 0) + (hr ? Math.abs(g.rows - hr) : 0);
    if (!best || err < best.err || (err === best.err && g.score > best.g.score)) best = { g, err };
    if (err === 0) break;
  }
  const baseErr = base ? (hc ? Math.abs(base.cols - hc) : 0) + (hr ? Math.abs(base.rows - hr) : 0) : Infinity;
  const pick = best && best.err <= baseErr ? best : base ? { g: base, err: baseErr } : null;
  if (!pick || pick.err > 6) return pick?.g ?? null;
  // 补齐 / 去掉多出来的整格（多半是标尺行列），两侧对称
  const g = { ...pick.g };
  if (hc && g.cols !== hc) {
    const d = hc - g.cols;
    g.x0 -= Math.ceil(d / 2) * g.pitchX;
    g.cols = hc;
  }
  if (hr && g.rows !== hr) {
    const d = hr - g.rows;
    g.y0 -= Math.ceil(d / 2) * g.pitchY;
    g.rows = hr;
  }
  return g;
}


/**
 * 已知列数 / 行数（抬头写着）时：沿用检测到的格距与相位，把格网整体延伸（或收缩）到该尺寸。
 * 空白处的细线检测不到（只有有豆子的地方才有强线），所以检测结果常常只是一小段；这里在候选起点中，
 * 挑“首尾两条线有线、再往外一格没有线”的那一个（低阈值覆盖率，图外 / 页面空白处覆盖率为 0）。
 */
export function fitToSize(src: PixelSource, g: GridDetection, region: Rect | null | undefined, hc: number, hr: number): GridDetection | null {
  const { x0, y0, x1, y1 } = regionBounds(src, region);
  const noise = noiseLevel(src, x0, y0, x1, y1);
  const T = Math.min(Math.max(45, 5 * noise), Math.max(14, 2.5 * noise));
  const gx1 = g.x0 + g.cols * g.pitchX, gy1 = g.y0 + g.rows * g.pitchY;
  const one = (axis: "col" | "row", n: number, h: number): number | null => {
    if (!h || h === n) return 0;
    const p = axis === "col" ? g.pitchX : g.pitchY;
    const o0 = axis === "col" ? g.x0 : g.y0;
    const a = axis === "col" ? g.y0 : g.x0, b = axis === "col" ? gy1 : gx1;
    const lim = axis === "col" ? src.width : src.height;
    const cache = new Map<number, number>();
    const cov = (k: number) => {
      let v = cache.get(k);
      if (v === undefined) {
        const t = o0 + k * p;
        v = t < 2 || t > lim - 2 ? -1 : toothCoverage(src, axis, t, a, b, T);
        cache.set(k, v);
      }
      return v;
    };
    const lo = h >= n ? -(h - n) : 0, hi = h >= n ? 0 : n - h;
    let best: { s: number; score: number; B: number } | null = null;
    for (let s = lo; s <= hi; s += 1) {
      let inner = 0;
      let bad = false;
      for (let k = s; k <= s + h; k += 1) { const c = cov(k); if (c < 0) { bad = true; break; } inner += c; }
      if (bad) continue;
      const B = cov(s) + cov(s + h) - Math.max(0, cov(s - 1)) - Math.max(0, cov(s + h + 1));
      const score = inner / (h + 1) + B;
      if (!best || score > best.score) best = { s, score, B };
    }
    return best && best.B >= 0.6 ? best.s : null;
  };
  const sx = one("col", g.cols, hc);
  const sy = one("row", g.rows, hr);
  if (sx === null && sy === null) return null;
  const out = { ...g };
  if (sx !== null && hc) { out.x0 = g.x0 + sx * g.pitchX; out.cols = hc; }
  if (sy !== null && hr) { out.y0 = g.y0 + sy * g.pitchY; out.rows = hr; }
  return out;
}

function detectCore(src: PixelSource, region?: Rect | null, pitchHint?: number): GridDetection | null {
  const { x0, y0, x1, y1 } = regionBounds(src, region);
  const W = x1 - x0;
  const H = y1 - y0;
  if (W < 24 || H < 24) return null;

  const edgeT = Math.max(45, 5 * noiseLevel(src, x0, y0, x1, y1));
  const first = profiles(src, x0, y0, x1, y1);
  const covX = (a: number, b: number) => (pos: number) => toothCoverage(src, "col", pos + 1 + x0, a, b, edgeT);
  const covY = (a: number, b: number) => (pos: number) => toothCoverage(src, "row", pos + 1 + y0, a, b, edgeT);
  let lx = findLattice(first.colP, H, pitchHint, covX(y0, y1));
  let ly = findLattice(first.rowP, W, pitchHint, covY(x0, x1));
  if (!lx && !ly) return null;
  if (!lx && ly) lx = findLattice(first.colP, H, ly.pitch, covX(y0, y1));
  if (!ly && lx) ly = findLattice(first.rowP, W, lx.pitch, covY(x0, x1));
  if (!lx || !ly) return null;

  // 交替：只在对方找到的范围内重算投影，去掉标题/图例带来的干扰
  for (let iter = 0; iter < 2; iter += 1) {
    const ex = extentOf(lx, x0);
    const ey = extentOf(ly, y0);
    const xa = Math.max(x0, Math.floor(ex[0])), xb = Math.min(x1, Math.ceil(ex[1]));
    const ya = Math.max(y0, Math.floor(ey[0])), yb = Math.min(y1, Math.ceil(ey[1]));
    if (xb - xa < 24 || yb - ya < 24) break;
    const colP = profiles(src, x0, ya, x1, yb, "col").colP;
    const rowP = profiles(src, xa, y0, xb, y1, "row").rowP;
    const nx = findLattice(colP, yb - ya, lx.pitch, covX(ya, yb));
    const ny = findLattice(rowP, xb - xa, ly.pitch, covY(xa, xb));
    // 提示模式只会微调周期；若 profile 变得更干净则采纳
    if (nx && nx.score >= lx.score * 0.9) lx = nx;
    if (ny && ny.score >= ly.score * 0.9) ly = ny;
  }

  if (Math.max(lx.pitch, ly.pitch) / Math.min(lx.pitch, ly.pitch) > 1.3) {
    // 两轴周期差太大：用更可信的一轴作为提示重找另一轴
    const hint = lx.score >= ly.score ? lx.pitch : ly.pitch;
    const redo = lx.score >= ly.score
      ? findLattice(profiles(src, x0, y0, x1, y1, "row").rowP, W, hint, covY(x0, x1))
      : findLattice(profiles(src, x0, y0, x1, y1, "col").colP, H, hint, covX(y0, y1));
    if (!redo) return null;
    if (lx.score >= ly.score) ly = redo; else lx = redo;
  }

  // 端点“连续性”检查：真网格线横贯整个网格，图例色块/文字的边缘只覆盖一小段
  for (let pass = 0; pass < 3; pass += 1) {
    const ex = extentOf(lx, x0);
    const ey = extentOf(ly, y0);
    if (pass % 2 === 0) trimEnds(lx, src, "col", x0, ey[0], ey[1], edgeT);
    else trimEnds(ly, src, "row", y0, ex[0], ex[1], edgeT);
  }

  for (let pass = 0; pass < 2; pass += 1) {
    const ex = extentOf(lx, x0);
    const ey = extentOf(ly, y0);
    if (pass === 0) balanceGhosts(lx, src, "col", x0, ey[0], ey[1], edgeT);
    else balanceGhosts(ly, src, "row", y0, ex[0], ex[1], edgeT);
  }

  const score = (lx.score + ly.score) / 2;
  if (score < 0.3) return null;
  const cols = lx.kb - lx.ka;
  const rows = ly.kb - ly.ka;
  if (cols < 3 || rows < 3) return null;

  let fx = regress(lx);
  let fy = regress(ly);
  if (Math.abs(fx.pitch - fy.pitch) / Math.max(fx.pitch, fy.pitch) < 0.05) {
    // 格子是正方形：两轴取加权平均
    const p = (fx.pitch * cols + fy.pitch * rows) / (cols + rows);
    fx = regress(lx, p);
    fy = regress(ly, p);
  }
  if (fx.pitch < MIN_PITCH || fy.pitch < MIN_PITCH) return null;
  return {
    x0: fx.a + x0,
    y0: fy.a + y0,
    pitchX: fx.pitch,
    pitchY: fy.pitch,
    cols,
    rows,
    score: Math.max(0, Math.min(1, score))
  };
}

/** 某一齿（边界坐标 t）在垂直方向 [a,b] 上有多大比例的位置存在明显边缘。 */
function toothCoverage(src: PixelSource, axis: "col" | "row", t: number, a: number, b: number, edgeT = 45): number {
  const d = src.data;
  const W = src.width;
  const c = Math.round(t) - 1; // 边界 t 对应 profile 索引 t-1
  const lo = Math.max(0, Math.floor(a));
  const hi = Math.min(axis === "col" ? src.height : src.width, Math.ceil(b));
  if (hi - lo < 4) return 0;
  // 沿线最多取 ~400 个位置：黄金比例低差异序列，避免与网格周期同频（规则步长会恰好踩在格线上）
  const len = hi - lo;
  const samples = Math.min(len, 400);
  let hit = 0;
  for (let n = 0; n < samples; n += 1) {
    const u = samples === len ? lo + n : lo + Math.floor(((n * 0.6180339887498949) % 1) * len);
    // 缩小后的细线会被拆到相邻两个像素上，所以把相邻 3 个台阶的差累加再比较
    let sum = 0;
    for (let o = -1; o <= 1; o += 1) {
      const v = c + o;
      if (v < 0) continue;
      let i: number, j: number;
      if (axis === "col") { if (v + 1 >= W) continue; i = (u * W + v) * 4; j = i + 4; }
      else { if (v + 1 >= src.height) continue; i = (v * W + u) * 4; j = i + W * 4; }
      sum += Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]);
    }
    if (sum > edgeT) hit += 1;
  }
  return hit / samples;
}

/** 相邻像素差的中位数 ≈ 噪点水平；用来抬高“边缘”判定门槛。 */
function noiseLevel(src: PixelSource, x0: number, y0: number, x1: number, y1: number): number {
  // 伪随机取样（固定种子）：规则步长会恰好踩在周期性网格线上
  const vals: number[] = [];
  const d = src.data;
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  for (let n = 0; n < 6000; n += 1) {
    const x = x0 + Math.floor(rnd() * (x1 - x0 - 1));
    const y = y0 + Math.floor(rnd() * (y1 - y0));
    const i = (y * src.width + x) * 4;
    vals.push(Math.abs(d[i] - d[i + 4]) + Math.abs(d[i + 1] - d[i + 5]) + Math.abs(d[i + 2] - d[i + 6]));
  }
  return median(vals);
}

/** 端齿相对中段的覆盖率低于此比例就不算真网格线（标尺外沿的“幽灵线”覆盖率约 0.45–0.55，真线约 0.95+）。 */
const END_STRONG = 0.7;

function trimEnds(l: Lattice, src: PixelSource, axis: "col" | "row", offset: number, a: number, b: number, edgeT: number) {
  const pos = (k: number) => { const f = regress(l); return f.a + (k - l.ka) * f.pitch + offset; };
  const mid: number[] = [];
  const span = l.kb - l.ka;
  for (let i = 1; i <= 9; i += 1) mid.push(toothCoverage(src, axis, pos(l.ka + Math.round((span * i) / 10)), a, b, edgeT));
  const ref = [...mid].sort((x, y) => x - y)[6]; // 约 70% 分位：避开个别被文字 / 水印遮住的线
  if (ref < 0.2) return;
  const weak = (k: number) => toothCoverage(src, axis, pos(k), a, b, edgeT) < END_STRONG * ref;
  // 末端 / 起点附近“弱齿 + 1~2 条强齿”：强齿是图例色块 / 标尺的边缘，弱齿之外的都不属于网格
  // 孤立的强齿（紧挨着一条弱齿）多半是图例色块 / 标尺的边缘，连同弱齿一起去掉
  while (l.kb - l.ka > 8 && (weak(l.kb) || weak(l.kb - 1))) {
    l.kb -= weak(l.kb) ? 1 : 2;
    l.pts = l.pts.filter(([k]) => k <= l.kb);
  }
  while (l.kb - l.ka > 8 && (weak(l.ka) || weak(l.ka + 1))) {
    l.ka += weak(l.ka) ? 1 : 2;
    l.pts = l.pts.filter(([k]) => k >= l.ka);
  }
  while (l.kb - l.ka > 3 && weak(l.kb)) {
    l.kb -= 1;
    l.pts = l.pts.filter(([k]) => k <= l.kb);
  }
  while (l.kb - l.ka > 3 && weak(l.ka)) {
    // 起点前移后 regress 以新的 ka 为参考，pts 里的 k 保持绝对序号，所以不用改
    l.ka += 1;
    l.pts = l.pts.filter(([k]) => k >= l.ka);
  }
}

/**
 * 标尺总是四边对称：若一端在最后一条强线之外还有更多“弱边线”（被标尺盖住 / 缩小后看不见的外框线），
 * 就把多出来的那一格补回来。任一侧的探测位置碰到图像边缘（无法判断）时不补，避免把标尺外沿当成格子。
 */
function balanceGhosts(l: Lattice, src: PixelSource, axis: "col" | "row", offset: number, a: number, b: number, edgeT: number) {
  const f = regress(l);
  const pos = (k: number) => f.a + (k - l.ka) * f.pitch + offset;
  const low = Math.max(20, edgeT * 0.5);
  const ref = median(Array.from({ length: 9 }, (_, i) => toothCoverage(src, axis, pos(l.ka + Math.round(((l.kb - l.ka) * (i + 1)) / 10)), a, b, edgeT)));
  if (ref < 0.2) return;
  const lim = axis === "col" ? src.width : src.height;
  if (pos(l.ka - 1) < 2 || pos(l.kb + 1) > lim - 2) return;
  const ghosts = (dir: -1 | 1) => {
    let g = 0;
    for (let i = 1; i <= 3; i += 1) {
      const k = dir < 0 ? l.ka - i : l.kb + i;
      const t = pos(k);
      if (t < 2 || t > lim - 2) break;
      if (toothCoverage(src, axis, t, a, b, low) >= 0.7 * ref) g += 1; else break;
    }
    return g;
  };
  const gl = ghosts(-1), gr = ghosts(1);
  if (gl === gr + 1) l.ka -= 1;
  else if (gr === gl + 1) l.kb += 1;
}

function extentOf(l: Lattice, offset: number): [number, number] {
  const f = regress(l);
  return [f.a + offset, f.a + (l.kb - l.ka) * f.pitch + offset];
}

// ───────────────────────── 读色 ─────────────────────────

/** 收集一块区域的像素，返回“主导色”：4bit 量化后最多的桶，再对近邻像素取均值（忽略文字与线条）。 */
class DominantColor {
  private rs = new Uint8Array(256);
  private gs = new Uint8Array(256);
  private bs = new Uint8Array(256);
  private n = 0;
  private counts = new Int32Array(4096);
  private seen = new Int32Array(4096);
  private stamp = 0;

  reset() { this.n = 0; }

  add(r: number, g: number, b: number) {
    if (this.n >= this.rs.length) {
      const grow = (a: Uint8Array) => { const o = new Uint8Array(a.length * 2); o.set(a); return o; };
      this.rs = grow(this.rs); this.gs = grow(this.gs); this.bs = grow(this.bs);
    }
    this.rs[this.n] = r; this.gs[this.n] = g; this.bs[this.n] = b;
    this.n += 1;
  }

  get size() { return this.n; }

  result(): { r: number; g: number; b: number; frac: number } | null {
    const { n, rs, gs, bs, counts } = this;
    if (!n) return null;
    for (let i = 0; i < n; i += 1) counts[((rs[i] >> 4) << 8) | ((gs[i] >> 4) << 4) | (bs[i] >> 4)] += 1;
    // 噪点会把同一块纯色拆进相邻的几个桶：按 3×3×3 邻域累计得分，避免被一小块集中的文字色抢票
    let bestKey = 0;
    let bestCnt = -1;
    this.stamp += 1;
    for (let i = 0; i < n; i += 1) {
      const r4 = rs[i] >> 4, g4 = gs[i] >> 4, b4 = bs[i] >> 4;
      const key = (r4 << 8) | (g4 << 4) | b4;
      if (this.seen[key] === this.stamp) continue;
      this.seen[key] = this.stamp;
      let score = 0;
      for (let dr = -1; dr <= 1; dr += 1) {
        const rr = r4 + dr;
        if (rr < 0 || rr > 15) continue;
        for (let dg = -1; dg <= 1; dg += 1) {
          const gg = g4 + dg;
          if (gg < 0 || gg > 15) continue;
          for (let db = -1; db <= 1; db += 1) {
            const bb = b4 + db;
            if (bb < 0 || bb > 15) continue;
            score += counts[(rr << 8) | (gg << 4) | bb];
          }
        }
      }
      if (score > bestCnt) { bestCnt = score; bestKey = key; }
    }
    for (let i = 0; i < n; i += 1) counts[((rs[i] >> 4) << 8) | ((gs[i] >> 4) << 4) | (bs[i] >> 4)] = 0;
    let cr = ((bestKey >> 8) << 4) + 8, cg = (((bestKey >> 4) & 15) << 4) + 8, cb = ((bestKey & 15) << 4) + 8;
    let frac = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      let sr = 0, sg = 0, sb = 0, c = 0;
      // 先宽后窄：第一轮定位主色，之后收紧，避免文字抗锯齿的混色把深色格子均值抬亮
      const tol = pass === 0 ? 48 : 24;
      for (let i = 0; i < n; i += 1) {
        if (Math.abs(rs[i] - cr) + Math.abs(gs[i] - cg) + Math.abs(bs[i] - cb) <= tol) {
          sr += rs[i]; sg += gs[i]; sb += bs[i]; c += 1;
        }
      }
      if (!c) break;
      cr = sr / c; cg = sg / c; cb = sb / c;
      frac = c / n;
    }
    return { r: cr, g: cg, b: cb, frac };
  }
}

type Cluster = { lab: Lab; r: number; g: number; b: number; n: number; code: string; de: number };

function chroma(l: Lab) { return Math.hypot(l.a, l.b); }
function de76(a: Lab, b: Lab) { return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b); }

/** 网格外像素的主导色（背景）；外圈像素太少时返回 null。 */
function estimateBackground(src: PixelSource, grid: GridDetection, acc: DominantColor) {
  const gx0 = grid.x0, gy0 = grid.y0;
  const gx1 = grid.x0 + grid.cols * grid.pitchX, gy1 = grid.y0 + grid.rows * grid.pitchY;
  const step = Math.max(1, Math.floor(Math.sqrt((src.width * src.height) / 60000)));
  acc.reset();
  const d = src.data;
  for (let y = 0; y < src.height; y += step) {
    for (let x = 0; x < src.width; x += step) {
      if (x >= gx0 - 2 && x <= gx1 + 2 && y >= gy0 - 2 && y <= gy1 + 2) continue;
      const i = (y * src.width + x) * 4;
      acc.add(d[i], d[i + 1], d[i + 2]);
    }
  }
  return acc.size >= 300 ? acc.result() : null;
}

export function readGrid(
  src: PixelSource,
  grid: GridDetection,
  opts: {
    allowedCodes?: string[] | null;
    treatBackgroundAsEmpty?: boolean;
    legendCodes?: string[] | null;
    /** 图例色块实际渲染色（色号 → RGB）：有则作为该色号的匹配目标，没有再用色卡色 */
    legendColors?: Record<string, { r: number; g: number; b: number }> | null;
    /** 格内色号投票（颜色簇编号 → 色号）：覆盖该簇的颜色匹配结果 */
    cellVotes?: Record<number, string> | null;
    /** 图纸格内印有色号时，按“有无文字”判定空格 / 豆子（默认 true） */
    useInk?: boolean;
    /** 闭集色板：图例色块已找全，格子只在 legendCodes 里匹配；图例之外的色号只有“很大一簇且与所有色块都差很远”才允许 */
    closedPalette?: boolean;
  } = {}
): GridReading {
  const treatEmpty = opts.treatBackgroundAsEmpty !== false;
  const legend = (opts.legendCodes ?? []).map((c) => c.toUpperCase());
  const allowed = (opts.allowedCodes ?? []).map((c) => c.toUpperCase());
  const wanted = new Set(legend.length >= 2 ? legend : allowed);
  const sampled = opts.legendColors ?? {};
  // 校准：图例色块的实际颜色优先于色卡（旧版导出 / 其他软件的色值与现在的 MARD 不同）
  const calibrated = MARD_PALETTE.map((c) => (sampled[c.code] ? { ...c, lab: rgbToLab(sampled[c.code]) } : c));
  const isCal = (code: string) => !!sampled[code];
  let candidates = calibrated.filter((c) => wanted.has(c.code));
  if (!candidates.length) candidates = calibrated;
  // 图例可能没读全（OCR 漏读几个色号）：图例之外的色卡色作为“备选”，只有明显更接近时才采用
  const restPool = legend.length >= 2 && !allowed.length ? calibrated.filter((c) => !wanted.has(c.code)) : [];

  const acc = new DominantColor();
  const ring = new DominantColor();
  const bgRgb = estimateBackground(src, grid, acc);
  const bgLab = bgRgb ? rgbToLab(bgRgb) : null;
  // 背景是浅色中性（或未知）时，浅灰/白棋盘格也视为空格
  const lightRule = !bgLab || (bgLab.l >= 85 && chroma(bgLab) <= 8);
  const isEmpty = (lab: Lab) =>
    (bgLab !== null && de76(lab, bgLab) < 6) || (lightRule && lab.l >= 86 && chroma(lab) <= 10);
  // 图例里存在与背景几乎同色的色号（如白色 H2）：这类格子要保留
  const protectedLabs = calibrated
    .filter((c) => legend.includes(c.code))
    .filter((c) => (bgLab !== null && de76(c.lab, bgLab) <= 9) || (c.lab.l >= 86 && chroma(c.lab) <= 10))
    .map((c) => ({ lab: c.lab, tol: isCal(c.code) ? 3 : 6 }));

  const { cols, rows, pitchX, pitchY } = grid;
  const cells: Array<{ lab: Lab; r: number; g: number; b: number } | null> = new Array(cols * rows).fill(null);
  const cellInk = new Uint8Array(cols * rows);
  let flatCells = 0;
  const d = src.data;
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const insX = Math.max(1, pitchX * 0.22);
      const insY = Math.max(1, pitchY * 0.22);
      const ax = grid.x0 + cx * pitchX + insX, bx = grid.x0 + (cx + 1) * pitchX - insX;
      const ay = grid.y0 + cy * pitchY + insY, by = grid.y0 + (cy + 1) * pitchY - insY;
      let px0 = Math.ceil(ax - 0.5), px1 = Math.floor(bx - 0.5);
      let py0 = Math.ceil(ay - 0.5), py1 = Math.floor(by - 0.5);
      if (px1 < px0) px0 = px1 = Math.round((ax + bx) / 2 - 0.5);
      if (py1 < py0) py0 = py1 = Math.round((ay + by) / 2 - 0.5);
      px0 = Math.max(0, px0); py0 = Math.max(0, py0);
      px1 = Math.min(src.width - 1, px1); py1 = Math.min(src.height - 1, py1);
      acc.reset();
      ring.reset();
      const mx = grid.x0 + (cx + 0.5) * pitchX, my = grid.y0 + (cy + 0.5) * pitchY;
      for (let y = py0; y <= py1; y += 1) {
        let i = (y * src.width + px0) * 4;
        const inY = Math.abs((y + 0.5 - my) / pitchY) < 0.24;
        for (let x = px0; x <= px1; x += 1, i += 4) {
          acc.add(d[i], d[i + 1], d[i + 2]);
          // 格内印的色号文字居中：环形区域（避开中央文字带）不受文字污染
          if (!(inY && Math.abs((x + 0.5 - mx) / pitchX) < 0.38)) ring.add(d[i], d[i + 1], d[i + 2]);
        }
      }
      let c = acc.result();
      // 整块内部颜色不纯（有文字）且环形区像素够多时，改用环形区的主色
      if (c && c.frac < 0.85 && ring.size >= 12) c = ring.result() ?? c;
      if (c && c.frac >= 0.75) flatCells += 1;
      if (c) {
        cells[cy * cols + cx] = { ...c, lab: rgbToLab(c) };
        // 文字墨迹：中央文字带内与格子底色差异明显的像素
        let band = 0, ink = 0;
        for (let y = py0; y <= py1; y += 1) {
          if (Math.abs((y + 0.5 - my) / pitchY) >= 0.24) continue;
          let i = (y * src.width + px0) * 4;
          for (let x = px0; x <= px1; x += 1, i += 4) {
            band += 1;
            if (Math.abs(d[i] - c.r) + Math.abs(d[i + 1] - c.g) + Math.abs(d[i + 2] - c.b) > 90) ink += 1;
          }
        }
        if (band >= 6 && ink >= Math.max(3, 0.05 * band)) cellInk[cy * cols + cx] = 1;
      }
    }
  }

  // 聚类（ΔE76<3），再把每个聚类映射到最近的色号
  const clusters: Cluster[] = [];
  const cellCluster = new Int32Array(cols * rows).fill(-1);
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (!cell) continue;
    let bi = -1, bd = 9;
    for (let j = 0; j < clusters.length; j += 1) {
      const c = clusters[j];
      const dl = c.lab.l - cell.lab.l, da = c.lab.a - cell.lab.a, db = c.lab.b - cell.lab.b;
      const dd = dl * dl + da * da + db * db;
      if (dd < bd) { bd = dd; bi = j; }
    }
    if (bi < 0) {
      clusters.push({ lab: { ...cell.lab }, r: cell.r, g: cell.g, b: cell.b, n: 1, code: "", de: 0 });
      cellCluster[i] = clusters.length - 1;
    } else {
      const c = clusters[bi];
      const m = c.n + 1;
      c.lab = { l: (c.lab.l * c.n + cell.lab.l) / m, a: (c.lab.a * c.n + cell.lab.a) / m, b: (c.lab.b * c.n + cell.lab.b) / m };
      c.r = (c.r * c.n + cell.r) / m; c.g = (c.g * c.n + cell.g) / m; c.b = (c.b * c.n + cell.b) / m;
      c.n = m;
      cellCluster[i] = bi;
    }
  }
  const empty: boolean[] = clusters.map(() => false);
  const colorCode: string[] = [];
  clusters.forEach((c, j) => {
    let best = Infinity;
    for (const p of candidates) {
      const de = ciede2000(c.lab, p.lab);
      if (de < best) { best = de; c.code = p.code; }
    }
    // 闭集：只有“占比够大（≥0.5% 格子）且与所有色块都差很远（ΔE>8）”的簇才允许用图例之外的色号
    const restOk = restPool.length > 0 && (!opts.closedPalette || (c.n >= Math.max(6, 0.005 * cells.length) && best > 8));
    if (restOk) {
      let rb = Infinity, rc = "";
      for (const p of restPool) {
        const de = ciede2000(c.lab, p.lab);
        if (de < rb) { rb = de; rc = p.code; }
      }
      // 近白色：H1/H2/T1/P1 几乎分不开，统一记 H2（有格内色号时会被投票改写）
      if (rb <= 4 && c.lab.l >= 93 && chroma(c.lab) <= 6) rc = "H2";
      if (rb <= 4 && rb + 1.5 < best) { best = rb; c.code = rc; }
    }
    c.de = best;
    colorCode[j] = c.code;
    if (treatEmpty && isEmpty(c.lab)) {
      const keep = protectedLabs.some((pl) => ciede2000(c.lab, pl.lab) <= pl.tol);
      empty[j] = !keep;
    }
  });

  // 格内色号：按簇统计“有墨迹的格子”比例。≥50% 为有字簇，≤10% 为无字簇，其余为混合簇（照片 / 噪点）。
  const members: number[][] = clusters.map(() => []);
  const inkCount: number[] = clusters.map(() => 0);
  for (let i = 0; i < cellCluster.length; i += 1) {
    const ci = cellCluster[i];
    if (ci < 0) continue;
    members[ci].push(i);
    if (cellInk[i]) inkCount[ci] += 1;
  }
  let inkedCells = 0, mixedCells = 0;
  const kind = clusters.map((c, j) => {
    const f = inkCount[j] / Math.max(1, c.n);
    if (f >= 0.5) { inkedCells += c.n; return "ink"; }
    if (f > 0.1) { mixedCells += c.n; return "mixed"; }
    return "plain";
  });
  const inkChart = inkedCells >= 10 && inkedCells >= 3 * mixedCells;
  // 背景色类（颜色上像空白）的簇：图纸格内有色号时，逐格按“有没有字”判断——图形内部的白豆（H2）带着色号文字，图外空白没有
  const bgLike: boolean[] = clusters.map((c) => !!treatEmpty && isEmpty(c.lab));
  const perCellInk = inkChart && treatEmpty && opts.useInk !== false;
  if (perCellInk) {
    clusters.forEach((_, j) => {
      if (bgLike[j]) empty[j] = false; // 逐格判断，见下方 matrix 构建
      else if (kind[j] === "plain") empty[j] = true;
      else empty[j] = false;
    });
  }
  // 投票覆盖颜色匹配
  const votes = opts.cellVotes ?? {};
  const overridden: boolean[] = clusters.map(() => false);
  clusters.forEach((c, j) => {
    const v = votes[j]?.toUpperCase();
    if (!v) return;
    if (v !== c.code) overridden[j] = true;
    c.code = v;
    const pal = calibrated.find((x) => x.code === v);
    if (pal) c.de = ciede2000(c.lab, pal.lab);
  });

  const matrix: Array<Array<string | null>> = [];
  const counts: Record<string, number> = {};
  const stat = new Map<string, { n: number; de: number; r: number; g: number; b: number }>();
  let emptyCells = 0;
  for (let cy = 0; cy < rows; cy += 1) {
    const row: Array<string | null> = [];
    for (let cx = 0; cx < cols; cx += 1) {
      const ci = cellCluster[cy * cols + cx];
      if (ci < 0 || empty[ci] || (perCellInk && bgLike[ci] && !cellInk[cy * cols + cx])) { row.push(null); emptyCells += 1; continue; }
      const c = clusters[ci];
      const cell = cells[cy * cols + cx]!;
      row.push(c.code);
      counts[c.code] = (counts[c.code] ?? 0) + 1;
      const s = stat.get(c.code) ?? { n: 0, de: 0, r: 0, g: 0, b: 0 };
      s.n += 1; s.de += c.de; s.r += cell.r; s.g += cell.g; s.b += cell.b;
      stat.set(c.code, s);
    }
    matrix.push(row);
  }
  const colors: CellColorStat[] = [...stat.entries()]
    .map(([code, s]) => ({
      code,
      count: s.n,
      deltaE: Math.round((s.de / s.n) * 100) / 100,
      sampleHex: rgbToHex({ r: s.r / s.n, g: s.g / s.n, b: s.b / s.n })
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  const infos: ColorCluster[] = clusters.map((c, j) => ({
    id: j,
    count: c.n,
    rgb: { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) },
    colorCode: colorCode[j],
    code: empty[j] ? null : c.code,
    empty: empty[j],
    inkCells: inkCount[j],
    cells: members[j],
    overridden: overridden[j]
  }));
  return { grid, matrix, counts, colors, emptyCells, backgroundHex: bgRgb ? rgbToHex(bgRgb) : null, inkChart, cellInk, cellCluster, clusters: infos, flatFrac: flatCells / Math.max(1, cols * rows) };
}
