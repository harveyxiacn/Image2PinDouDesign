// 网格检测 + 逐格读色。全部是确定性的纯函数，不依赖 DOM，可在 vitest(node) 里直接跑。
import { ciede2000, rgbToHex, rgbToLab } from "@engine/color";
import { MARD_PALETTE } from "@engine/palette";
import type { Lab, PixelSource } from "@engine/types";
import type { CellColorStat, ColorCluster, GridDetection, GridReading, Rect } from "./types";

const MIN_PITCH = 4;
const MAX_LAG = 250;
/** 被轮廓围住的浅色区域至少多少格才算豆子（白豆 H2）；更小的是图形内部的缝隙 */
const ENCLOSED_MIN = 10;

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
  /** 由“每 5 格一条粗线”结构外推出的范围（细线看不见，trimEnds / balanceGhosts 不再适用） */
  boldExt?: boolean;
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

function findLattice(P: Float64Array, lineLen: number, hint?: number, cov?: (pos: number) => number, like?: (pos: number, pitch: number) => boolean): Lattice | null {
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
    // 小格子（< 12 px）的 JPEG 图：空白格之间的细线对比度很低，覆盖率达不到门槛，但“线位 vs 半格处”的差分仍然清楚
    if (like && p < SMALL_PITCH) for (let k = 0; k < K; k += 1) if (!strong[k] && like(phase + k * p, p)) strong[k] = true;
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
  let boldExt = false;
  let boldR = 0;
  if (cov && like && K >= 30 && (p < SMALL_PITCH || hint)) {
    let ext = boldExtend(covs, K, ka, kb, (k) => like(phase + k * p, p), p >= SMALL_PITCH);
    // 格子较大时（空白处只剩每 5 格一条的粗线）：只在粗线序列明显比已找到的强齿序列长得多时才采用
    if (ext && p >= SMALL_PITCH && ext.kb - ext.ka < 1.5 * (kb - ka)) ext = null;
    if (ext) { ka = ext.ka; kb = ext.kb; for (let kk = ka; kk <= kb; kk += 1) strong[kk] = true; strongCount = kb - ka + 1; boldExt = true; boldR = ext.r1; }
  }
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
  let regularity = strongCount / (kb - ka + 1);
  if (boldExt && cov) {
    // 细线看不见：对比度与规则性只按粗线序列算
    const bs: number[] = [], bm: number[] = [];
    for (let kk = ka; kk <= kb; kk += 1) if (((kk - boldR) % 5 + 5) % 5 === 0 && covs[kk] >= 0.3) { bs.push(covs[kk]); bm.push(cov(phase + (kk + 0.5) * p)); }
    if (bs.length >= 8) { contrast = Math.max(contrast, Math.min(1, 1 - median(bm) / Math.max(1e-6, median(bs)))); regularity = Math.max(regularity, 0.9); }
  }
  const lenFactor = Math.sqrt(Math.min(1, (kb - ka + 1) / 6));
  const score = (0.6 * contrast + 0.4 * regularity) * lenFactor;
  return { pitch: p, pts, ka, kb, score, boldExt };
}

/**
 * 低清 JPEG 图：空白格之间的细线几乎看不见，但每 5 格一条的粗线（以及外框）仍然横贯全图。
 * 找出 k ≡ r (mod 5) 的粗线序列，沿它向两端延伸（粗线位置上有线就继续），得到完整的网格范围。
 */
function boldExtend(covs: number[], K: number, ka: number, kb: number, like: (k: number) => boolean, bigPitch = false): { ka: number; kb: number; r1: number } | null {
  const meds: number[] = [];
  for (let r = 0; r < 5; r += 1) {
    const v: number[] = [];
    for (let k = r; k < K; k += 5) v.push(covs[k]);
    meds.push(median(v));
  }
  let r1 = 0;
  for (let r = 1; r < 5; r += 1) if (meds[r] > meds[r1]) r1 = r;
  const other = Math.max(...meds.filter((_, r) => r !== r1));
  if (meds[r1] < 0.4 || meds[r1] < 1.25 * other) return null;
  const isBold = (k: number) => k >= 0 && k < K && (covs[k] >= 0.5 * meds[r1] || (covs[k] >= 0.25 && like(k)));
  let c = Math.round((ka + kb) / 2);
  while ((c - r1) % 5 !== 0) c += 1;
  if (!isBold(c) && isBold(c - 5)) c -= 5;
  if (!isBold(c)) return null;
  let lo = c, hi = c;
  // JPEG 压缩后个别粗线会被冲淡：允许跳过 1 条（后面还能接上才算）
  const skipTo = (k: number, dir: 1 | -1) => { for (let m = 2; m <= 3; m += 1) if (isBold(k + 5 * m * dir)) return m; return 0; };
  for (;;) { if (isBold(lo - 5)) lo -= 5; else { const m = skipTo(lo, -1); if (!m) break; lo -= 5 * m; } }
  for (;;) { if (isBold(hi + 5)) hi += 5; else { const m = skipTo(hi, 1); if (!m) break; hi += 5 * m; } }
  if ((hi - lo) / 5 < 8) return null;
  // 右 / 下端：最后一条粗线之后到外框之间还有 0~4 格（外框线本身也是线位）
  let end = hi;
  let bestC = 0;
  for (let j = 1; j <= 4; j += 1) if (hi + j < K && covs[hi + j] >= 0.25 && (bigPitch ? covs[hi + j] > 1.15 * covs[hi] && covs[hi + j] > bestC : covs[hi + j] > bestC) && like(hi + j)) { bestC = covs[hi + j]; end = hi + j; }
  return { ka: lo, kb: end, r1 };
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
  const likeX = (a: number, b: number) => (pos: number, pitch: number) => lineLike(src, "col", pos + 1 + x0, pitch, a, b);
  const likeY = (a: number, b: number) => (pos: number, pitch: number) => lineLike(src, "row", pos + 1 + y0, pitch, a, b);
  let lx = findLattice(first.colP, H, pitchHint, covX(y0, y1), likeX(y0, y1));
  let ly = findLattice(first.rowP, W, pitchHint, covY(x0, x1), likeY(x0, x1));
  if (!lx && !ly) return null;
  if (!lx && ly) lx = findLattice(first.colP, H, ly.pitch, covX(y0, y1), likeX(y0, y1));
  if (!ly && lx) ly = findLattice(first.rowP, W, lx.pitch, covY(x0, x1), likeY(x0, x1));
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
    const nx = findLattice(colP, yb - ya, lx.pitch, covX(ya, yb), likeX(ya, yb));
    const ny = findLattice(rowP, xb - xa, ly.pitch, covY(xa, xb), likeY(xa, xb));
    // 提示模式只会微调周期；若 profile 变得更干净则采纳
    if (nx && nx.score >= lx.score * 0.9) lx = nx;
    if (ny && ny.score >= ly.score * 0.9) ly = ny;
  }

  // 两轴周期之比不是 1 但近似小整数比（如 4:5）：各轴锁在了不同倍数的粗线上，按公共的细周期 q 重找两轴
  if (!pitchHint && Math.max(lx.pitch, ly.pitch) / Math.min(lx.pitch, ly.pitch) > 1.08) {
    let q = 0, bestE = 0.03;
    for (let kx = 1; kx <= 8; kx += 1) for (let ky = 1; ky <= 8; ky += 1) {
      const a = lx.pitch / kx, b = ly.pitch / ky, e = Math.abs(a - b) / Math.max(a, b);
      if (e < bestE && Math.min(a, b) >= 8) { bestE = e; q = (a + b) / 2; }
    }
    if (q > 0) {
      const rx = findLattice(profiles(src, x0, y0, x1, y1, "col").colP, H, q, covX(y0, y1), likeX(y0, y1));
      const ry = findLattice(profiles(src, x0, y0, x1, y1, "row").rowP, W, q, covY(x0, x1), likeY(x0, x1));
      if (rx && ry && Math.abs(rx.pitch - ry.pitch) / Math.max(rx.pitch, ry.pitch) < 0.05) { lx = rx; ly = ry; }
    }
  }

  if (Math.max(lx.pitch, ly.pitch) / Math.min(lx.pitch, ly.pitch) > 1.3) {
    // 两轴周期差太大：用更可信的一轴作为提示重找另一轴
    const hint = lx.score >= ly.score ? lx.pitch : ly.pitch;
    const redo = lx.score >= ly.score
      ? findLattice(profiles(src, x0, y0, x1, y1, "row").rowP, W, hint, covY(x0, x1), likeY(x0, x1))
      : findLattice(profiles(src, x0, y0, x1, y1, "col").colP, H, hint, covX(y0, y1), likeX(y0, y1));
    if (!redo) return null;
    if (lx.score >= ly.score) ly = redo; else lx = redo;
  }

  // 端点“连续性”检查：真网格线横贯整个网格，图例色块/文字的边缘只覆盖一小段
  for (let pass = 0; pass < 3; pass += 1) {
    const ex = extentOf(lx, x0);
    const ey = extentOf(ly, y0);
    if (pass % 2 === 0) trimEnds(lx, src, "col", x0, ey[0], ey[1], edgeT, true);
    else trimEnds(ly, src, "row", y0, ex[0], ex[1], edgeT, true);
  }

  for (let pass = 0; pass < 2; pass += 1) {
    const ex = extentOf(lx, x0);
    const ey = extentOf(ly, y0);
    if (pass === 0) balanceGhosts(lx, src, "col", x0, ey[0], ey[1], edgeT);
    else balanceGhosts(ly, src, "row", y0, ex[0], ex[1], edgeT);
  }

  // 大格子的粗线序列：右 / 下外框线若在图像边缘被裁掉（线位处没有线），按“左 / 上边距 = 右 / 下边距”补回整格
  const fillToEdge = (l: Lattice, offset: number, lim: number) => {
    if (!l.boldExt || l.pitch < SMALL_PITCH) return;
    const f = regress(l);
    const m0 = f.a + offset;
    if (m0 < 0 || m0 >= l.pitch) return;
    const pos = (k: number) => f.a + (k - l.ka) * f.pitch + offset;
    for (let j = 0; j < 4 && pos(l.kb + 1) <= lim - m0 + 0.35 * l.pitch; j += 1) l.kb += 1;
  };
  fillToEdge(lx, x0, x1);
  fillToEdge(ly, y0, y1);
  if ((lx.boldExt && lx.pitch < SMALL_PITCH) || (ly.boldExt && ly.pitch < SMALL_PITCH)) {
    const bg = pageColor(src);
    if (lx.boldExt && lx.pitch < SMALL_PITCH) { const ey = extentOf(ly, y0); extendByContent(lx, src, "col", x0, ey[0], ey[1], bg); }
    if (ly.boldExt && ly.pitch < SMALL_PITCH) { const ex = extentOf(lx, x0); extendByContent(ly, src, "row", y0, ex[0], ex[1], bg); }
    else if (lx.boldExt && ly.pitch < SMALL_PITCH && ly.kb - ly.ka < 0.8 * (lx.kb - lx.ka)) { const ex = extentOf(lx, x0); extendByContent(ly, src, "row", y0, ex[0], ex[1], bg, true); }
    if (!lx.boldExt && ly.boldExt && lx.pitch < SMALL_PITCH && lx.kb - lx.ka < 0.8 * (ly.kb - ly.ka)) { const ey = extentOf(ly, y0); extendByContent(lx, src, "col", x0, ey[0], ey[1], bg, true); }
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
    score: Math.max(0, Math.min(1, score)),
    ...(lx.boldExt && ly.pitch < SMALL_PITCH ? { faint: true } : {})
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

/** 小于此格距（像素）时启用“线位 vs 半格处”差分判线（低清 JPEG 图） */
const SMALL_PITCH = typeof process !== "undefined" && process.env?.PH_NOFAINT ? 0 : 12;

/** 低阈值下，线位处的覆盖率明显高于左右半格处：低对比度的细格线（空白格间的浅线）也能认出来；标尺数字 / 色块边缘不满足 */
function lineLike(src: PixelSource, axis: "col" | "row", t: number, pitch: number, a: number, b: number): boolean {
  const T = 14;
  const ct = toothCoverage(src, axis, t, a, b, T);
  if (ct < 0.2) return false;
  const cm = (toothCoverage(src, axis, t - pitch / 2, a, b, T) + toothCoverage(src, axis, t + pitch / 2, a, b, T)) / 2;
  return ct >= 1.8 * cm + 0.05;
}

/** 页面底色：图像最外圈像素的逐通道中位数 */
function pageColor(src: PixelSource): [number, number, number] {
  const { width: w, height: h, data: d } = src;
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const add = (x: number, y: number) => { const i = (y * w + x) * 4; rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]); };
  for (let x = 0; x < w; x += 3) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y += 3) { add(0, y); add(w - 1, y); }
  return [median(rs), median(gs), median(bs)];
}

/**
 * 粗线结构外推出的范围（boldExtend）两端的补全：细线 / 外框线看不见时，按“这一格宽的条带里有没有与页面底色不同的内容”
 * 判断板子（以及外圈标尺格）延伸到哪里。左 / 上端：粗线从板子边框起算，边框在第一条粗线之前 5 格；右 / 下端：最多再补 5 格。
 */
function extendByContent(l: Lattice, src: PixelSource, axis: "col" | "row", offset: number, a: number, b: number, bg: [number, number, number], filled = false) {
  const f = regress(l);
  const ka0 = l.ka;
  const pos = (k: number) => f.a + (k - ka0) * f.pitch + offset;
  const lim = axis === "col" ? src.width : src.height;
  const lenA = Math.max(0, Math.floor(a)), lenB = Math.min(axis === "col" ? src.height : src.width, Math.ceil(b));
  if (lenB - lenA < 8) return;
  const d = src.data, W = src.width;
  const frac = (k: number): number => {
    const t0 = pos(k), t1 = pos(k + 1);
    if (t0 < 1 || t1 > lim - 1) return 0;
    const m0 = Math.ceil(t0 + 1), m1 = Math.floor(t1 - 1);
    let hit = 0, tot = 0;
    for (let u = lenA; u < lenB; u += 2) {
      for (let v = m0; v <= m1; v += 1) {
        const i = axis === "col" ? (u * W + v) * 4 : (v * W + u) * 4;
        tot += 1;
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) hit += 1;
      }
    }
    return tot > 0 ? hit / tot : 0;
  };
  const has = (k: number) => frac(k) >= 0.04;
  if (filled) {
    // 另一轴已由粗线结构确认是“细线看不见的低清板”：沿这一轴，只要条带基本被格子底色铺满就继续（填色格 / 空格底色），再补一格标尺
    let guard = 0;
    while (frac(l.ka - 1) >= 0.6 && guard++ < 400) l.ka -= 1;
    guard = 0;
    while (frac(l.kb) >= 0.6 && guard++ < 400) l.kb += 1;
    return;
  }
  // 外推的条带内容密度要与边缘内侧几格相当：只有几笔文字（图例 / 说明 / 标尺数字）的条带不算格子
  const inner = (k0: number, dir: 1 | -1) => { const v: number[] = []; for (let i = 0; i < 5; i += 1) v.push(frac(k0 + dir * i)); v.sort((x, y) => x - y); return v[2]; };
  const refA = inner(l.ka, 1), refB = inner(l.kb - 1, -1);
  const hasA = (k: number) => { const f0 = frac(k); return f0 >= 0.04 && f0 >= 0.3 * refA; };
  const hasB = (k: number) => { const f0 = frac(k); return f0 >= 0.04 && f0 >= 0.3 * refB; };
  let n = 0;
  for (let k = l.ka - 5; k < l.ka; k += 1) if (hasA(k)) n += 1;
  if (n >= 3) { l.ka -= 5; if (hasA(l.ka - 1)) l.ka -= 1; }
  let added = 0;
  while (added < 5 && hasB(l.kb)) { l.kb += 1; added += 1; }
}

/** 端齿相对中段的覆盖率低于此比例就不算真网格线（标尺外沿的“幽灵线”覆盖率约 0.45–0.55，真线约 0.95+）。 */
const END_STRONG = 0.7;

function trimEnds(l: Lattice, src: PixelSource, axis: "col" | "row", offset: number, a: number, b: number, edgeT: number, useLike = false) {
  const pos = (k: number) => { const f = regress(l); return f.a + (k - l.ka) * f.pitch + offset; };
  if (l.boldExt) return;
  const mid: number[] = [];
  const span = l.kb - l.ka;
  for (let i = 1; i <= 9; i += 1) mid.push(toothCoverage(src, axis, pos(l.ka + Math.round((span * i) / 10)), a, b, edgeT));
  const ref = [...mid].sort((x, y) => x - y)[6]; // 约 70% 分位：避开个别被文字 / 水印遮住的线
  if (ref < 0.2) return;
  const small = useLike && regress(l).pitch < SMALL_PITCH;
  const weak = (k: number) => toothCoverage(src, axis, pos(k), a, b, edgeT) < END_STRONG * ref
    && !(small && lineLike(src, axis, pos(k), regress(l).pitch, a, b));
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
  if (l.boldExt) return;
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
  // 格内的“页面底色”（最大的浅色簇，聚类后确定）：奶油 / 米白豆子（H19…）与它色相不同，不能因为“浅色低彩度”就当背景
  let gridBg: Lab | null = null;
  const isEmpty = (lab: Lab) =>
    (bgLab !== null && de76(lab, bgLab) < 6) || (gridBg !== null && de76(lab, gridBg) < 6.5) ||
    (lightRule && lab.l >= 86 && (chroma(lab) <= 3.5 || (chroma(lab) <= 10 && (gridBg === null || de76(lab, gridBg) < 7.5))));
  // 图例里存在与背景几乎同色的色号（如白色 H2）：这类格子要保留
  const protectedLabs = calibrated
    .filter((c) => legend.includes(c.code))
    .filter((c) => (bgLab !== null && de76(c.lab, bgLab) <= 9) || (c.lab.l >= 86 && chroma(c.lab) <= 10))
    .map((c) => ({ lab: c.lab, tol: isCal(c.code) ? 3 : 6, /** 与页面底色明显不同的浅色（浅蓝、浅粉…）：这种格子一定是豆子，不参与背景泛洪 */ distinct: de76(c.lab, bgLab ?? { l: 100, a: 0, b: 0 }) > 5 }));

  const { cols, rows, pitchX, pitchY } = grid;
  const cells: Array<{ lab: Lab; r: number; g: number; b: number } | null> = new Array(cols * rows).fill(null);
  const cellInk = new Uint8Array(cols * rows);
  /** 格内部“浅色低彩度”像素占比（白 / 浅灰 / 棋盘格两种浅色都算）：智能去背景用 */
  const lightFrac = new Float32Array(cols * rows);
  let flatCells = 0;
  const d = src.data;
  // 小格（≤12 px）：JPEG 在色块交界处有晕边，只取格子中心部分，避开边缘一圈
  const insetF = Math.min(pitchX, pitchY) <= 10 ? 0.3 : 0.22;
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const insX = Math.max(1, pitchX * insetF);
      const insY = Math.max(1, pitchY * insetF);
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
      let lightN = 0, allN = 0;
      for (let y = py0; y <= py1; y += 1) {
        let i = (y * src.width + px0) * 4;
        const inY = Math.abs((y + 0.5 - my) / pitchY) < 0.24;
        for (let x = px0; x <= px1; x += 1, i += 4) {
          acc.add(d[i], d[i + 1], d[i + 2]);
          const mn = Math.min(d[i], d[i + 1], d[i + 2]), mxv = Math.max(d[i], d[i + 1], d[i + 2]);
          allN += 1;
          if (mn >= 180 && mxv - mn <= 28) lightN += 1;
          // 格内印的色号文字居中：环形区域（避开中央文字带）不受文字污染
          if (!(inY && Math.abs((x + 0.5 - mx) / pitchX) < 0.38)) ring.add(d[i], d[i + 1], d[i + 2]);
        }
      }
      lightFrac[cy * cols + cx] = allN ? lightN / allN : 0;
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
  {
    let bn = 0;
    for (const c of clusters) if (c.lab.l >= 86 && chroma(c.lab) <= 10 && c.n > bn) { bn = c.n; gridBg = c.lab; }
    if (bn < 0.05 * cells.length || legend.length >= 2) gridBg = null; // 有图例时由图例色号保护浅色豆子，沿用旧规则
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

  // 色板收拢（无图例、簇很多时）：JPEG 晕边 / 噪点会产生一堆只有几格的零碎色号。
  // 用量很小的色号，若与某个大色号很接近（ΔE2000 ≤ 22），并入它；真正的小众色（离所有大色都远）保留。
  if (legend.length < 2 && !opts.cellVotes && clusters.length > 60) {
    const byCode = new Map<string, number>();
    clusters.forEach((c, j) => { if (!empty[j]) byCode.set(c.code, (byCode.get(c.code) ?? 0) + c.n); });
    const live = [...byCode.values()].reduce((x, y) => x + y, 0);
    const small = Math.max(4, 0.0035 * live), big = Math.max(24, 0.0045 * live);
    const bigs = clusters.map((c, j) => ({ c, j })).filter(({ c, j }) => !empty[j] && (byCode.get(c.code) ?? 0) >= big && c.n >= 8);
    // 混色格：夹在两个大色之间（落在两色连线附近）的中等用量色，多半是色块交界处的 JPEG 晕边，并入离得更近的那个大色
    const mid = 0.015 * live, bigB = Math.max(60, 0.03 * live);
    const bigB2 = clusters.filter((c, j) => !empty[j] && (byCode.get(c.code) ?? 0) >= bigB && c.n >= 20);
    clusters.forEach((c, j) => {
      const cc = byCode.get(c.code) ?? 0;
      if (empty[j] || cc >= mid || bigB2.includes(c)) return;
      let best = 4.5, pick: Cluster | null = null;
      for (let u = 0; u < bigB2.length; u += 1) {
        for (let v = u + 1; v < bigB2.length; v += 1) {
          const A = bigB2[u].lab, B = bigB2[v].lab;
          const ab = [B.l - A.l, B.a - A.a, B.b - A.b];
          const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
          if (len2 < 100) continue;
          const t = ((c.lab.l - A.l) * ab[0] + (c.lab.a - A.a) * ab[1] + (c.lab.b - A.b) * ab[2]) / len2;
          if (t < 0.1 || t > 0.9) continue;
          const dist = Math.hypot(c.lab.l - (A.l + t * ab[0]), c.lab.a - (A.a + t * ab[1]), c.lab.b - (A.b + t * ab[2]));
          if (dist < best) { best = dist; pick = t < 0.5 ? bigB2[u] : bigB2[v]; }
        }
      }
      if (pick) { c.code = pick.code; c.de = ciede2000(c.lab, pick.lab); }
    });
    clusters.forEach((c, j) => {
      if (empty[j] || (byCode.get(c.code) ?? 0) >= small) return;
      let bd = 45, bc: Cluster | null = null;
      for (const { c: t } of bigs) {
        const de = ciede2000(c.lab, t.lab);
        if (de < bd) { bd = de; bc = t; }
      }
      if (bc) { c.code = bc.code; c.de = bd; }
    });
  }

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
    // 背景色类的簇天然“空白格 + 带字的白豆”混在一起：不算混合簇，其中有字的格子算作有字格
    if (treatEmpty && isEmpty(c.lab) && f > 0.1 && f < 0.5) { inkedCells += inkCount[j]; return "plain"; }
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

  // ── 智能去背景：背景候选格（浅色低彩度 / 与页面底色相同 / 棋盘格）从网格边缘 4 邻接泛洪，
  // 只有与边缘相连的那一片才是背景；被轮廓围住的浅色区域（白豆 H2）仍是豆子。
  const bgMask = new Uint8Array(cols * rows);
  const cand = new Uint8Array(cols * rows);
  const distinctBead = clusters.map((c) => protectedLabs.some((pl) => pl.distinct && ciede2000(c.lab, pl.lab) <= pl.tol));
  let inkFrac = 0;
  if (treatEmpty) {
    for (let i = 0; i < cand.length; i += 1) {
      const ci = cellCluster[i];
      if (ci < 0 || distinctBead[ci]) continue;
      // “格子里大多是浅色低彩度像素”也算背景候选，但色相明显偏离页面底色的簇（奶油 / 米白豆子）除外
      const gb = gridBg as Lab | null;
      const lightOk = lightFrac[i] >= 0.7 && (gb === null || clusters[ci].n < 12 || chroma(clusters[ci].lab) <= 3.5 || de76(clusters[ci].lab, gb) < 10.2);
      if (bgLike[ci] || lightOk) cand[i] = 1;
    }
    const stack: number[] = [];
    // 带色号的图纸：边缘的浅色格大多没有字 → 字是“这是豆子”的强信号，泛洪不穿过有字的格子（图形里的白豆 H2 不会被连成背景）；
    // 若边缘浅色格本身就印着字（画像素把 H2 印在背景格里），则忽略墨迹
    let edgeLight = 0, edgeInk = 0;
    if (inkChart) {
      for (let x = 0; x < cols; x += 1) for (const i of [x, (rows - 1) * cols + x]) if (cand[i]) { edgeLight += 1; edgeInk += cellInk[i]; }
      for (let y = 0; y < rows; y += 1) for (const i of [y * cols, y * cols + cols - 1]) if (cand[i]) { edgeLight += 1; edgeInk += cellInk[i]; }
    }
    inkFrac = edgeLight >= 4 ? edgeInk / edgeLight : 0;
    const inkBlocks = inkChart && edgeLight >= 4 && edgeInk <= 0.4 * edgeLight;
    const seed = (i: number) => { if (cand[i] && !bgMask[i] && !(inkBlocks && cellInk[i])) { bgMask[i] = 1; stack.push(i); } };
    for (let x = 0; x < cols; x += 1) { seed(x); seed((rows - 1) * cols + x); }
    for (let y = 0; y < rows; y += 1) { seed(y * cols); seed(y * cols + cols - 1); }
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % cols, y = (i - x) / cols;
      if (x > 0) seed(i - 1);
      if (x < cols - 1) seed(i + 1);
      if (y > 0) seed(i - cols);
      if (y < rows - 1) seed(i + cols);
    }
  }
  // 无图例时被围住的浅色格也是豆子（有图例但没有浅色色号时，仍按旧规则当空格）
  // 零散的小空洞（图形内部的缝隙）仍是空格，只有成片（≥ ENCLOSED_MIN 格）的才当豆子
  const keepEnclosed = treatEmpty && legend.length < 2;
  const enclosedBead = new Uint8Array(cols * rows);
  if (keepEnclosed) {
    const seen = new Uint8Array(cols * rows);
    for (let s0 = 0; s0 < cand.length; s0 += 1) {
      if (!cand[s0] || bgMask[s0] || seen[s0]) continue;
      const comp = [s0];
      seen[s0] = 1;
      for (let k = 0; k < comp.length; k += 1) {
        const i = comp[k];
        const x = i % cols, y = (i - x) / cols;
        const nb = [x > 0 ? i - 1 : -1, x < cols - 1 ? i + 1 : -1, y > 0 ? i - cols : -1, y < rows - 1 ? i + cols : -1];
        for (const j of nb) if (j >= 0 && cand[j] && !bgMask[j] && !seen[j]) { seen[j] = 1; comp.push(j); }
      }
      if (comp.length >= ENCLOSED_MIN) for (const i of comp) enclosedBead[i] = 1;
    }
  }

  const matrix: Array<Array<string | null>> = [];
  const counts: Record<string, number> = {};
  const stat = new Map<string, { n: number; de: number; r: number; g: number; b: number }>();
  let emptyCells = 0;
  let backgroundCells = 0;
  for (let cy = 0; cy < rows; cy += 1) {
    const row: Array<string | null> = [];
    for (let cx = 0; cx < cols; cx += 1) {
      const idx = cy * cols + cx;
      const ci = cellCluster[idx];
      if (ci < 0) { row.push(null); emptyCells += 1; continue; }
      if (bgMask[idx]) { row.push(null); emptyCells += 1; backgroundCells += 1; continue; }
      const inkOk = !(perCellInk && bgLike[ci] && !cellInk[idx]);
      const enclosedLight = keepEnclosed && enclosedBead[idx] === 1 && inkOk && !(inkChart && !cellInk[idx]);
      if ((empty[ci] && !enclosedLight) || !inkOk) { row.push(null); emptyCells += 1; continue; }
      const c = clusters[ci];
      const cell = cells[idx]!;
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
  return { grid, matrix, counts, colors, emptyCells, backgroundHex: bgRgb ? rgbToHex(bgRgb) : null, inkChart, cellInk, cellCluster, clusters: infos, flatFrac: flatCells / Math.max(1, cols * rows), backgroundMask: bgMask, backgroundCells, backgroundInkFrac: inkFrac };
}
