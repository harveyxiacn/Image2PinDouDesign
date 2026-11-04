// 粗网格 → 细网格：低清图里细格线糊没了，检测器会锁定“每 5 / 10 格一条”的粗线（得到 19×19 这样的假网格）。
// 判据：真格子的边缘能量只落在格线上、格线之间（半格处）几乎为 0；比真格子更粗时半格处也有能量，更细时一半的格线上没有能量。
// 在放大后的图上，对候选的细分倍数 k 计算 “格线上 / 半格处” 能量比，取最大者；再沿两端补回粗线之外的那几格。
import type { PixelSource } from "@engine/types";
import type { GridDetection } from "./types";

type Profile = { e: Float64Array; mean: number };

function profiles(img: PixelSource, g: GridDetection): { px: Profile; py: Profile } {
  const { width: w, height: h, data: d } = img;
  const x1 = Math.min(w, Math.round(g.x0 + g.cols * g.pitchX)), y1 = Math.min(h, Math.round(g.y0 + g.rows * g.pitchY));
  const xa = Math.max(0, Math.floor(g.x0)), ya = Math.max(0, Math.floor(g.y0));
  const L = (x: number, y: number) => { const p = (y * w + x) * 4; return (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8; };
  const ex = new Float64Array(w + 1), ey = new Float64Array(h + 1);
  // 横向能量只统计网格所在的行带、纵向能量只统计网格所在的列带，但沿轴向铺满整幅图（后面要往外补格）
  for (let y = ya; y < y1; y++) for (let x = 1; x < w; x++) ex[x] += Math.abs(L(x, y) - L(x - 1, y));
  for (let y = 1; y < h; y++) for (let x = Math.max(0, xa); x < x1; x++) ey[y] += Math.abs(L(x, y) - L(x, y - 1));
  const mean = (a: Float64Array) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  return { px: { e: ex, mean: mean(ex) }, py: { e: ey, mean: mean(ey) } };
}

const at = (p: Profile, pos: number) => {
  const r = Math.round(pos), n = p.e.length;
  let m = 0;
  for (let t = -1; t <= 1; t++) { const i = r + t; if (i >= 1 && i < n) m = Math.max(m, p.e[i]); }
  return m;
};

function lineStats(p: Profile, x0: number, pitch: number, n: number) {
  let on = 0, off = 0;
  for (let i = 0; i <= n; i++) { on += at(p, x0 + i * pitch); if (i < n) off += at(p, x0 + (i + 0.5) * pitch); }
  return { on: on / (n + 1), off: off / Math.max(1, n) };
}

/** 返回细分后的网格（坐标同 img）；不需要 / 不可信时返回 null */
export function refineLattice(img: PixelSource, g: GridDetection, dbg?: string[]): GridDetection | null {
  const { px, py } = profiles(img, g);
  const eps = 0.02 * (px.mean + py.mean);
  const rs: Array<{ k: number; r: number }> = [];
  for (const k of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const pX = g.pitchX / k, pY = g.pitchY / k;
    if (pX < 6 || pY < 6) break;
    const a = lineStats(px, g.x0, pX, g.cols * k), b = lineStats(py, g.y0, pY, g.rows * k);
    const r = (a.on + b.on) / (a.off + b.off + eps);
    dbg?.push(`k=${k} r=${r.toFixed(2)}`);
    rs.push({ k, r });
  }
  // 真细分倍数处 r 是局部峰值（k=1 的粗线本身 r 很大，但 k 稍大一点就掉下来；到真倍数又回升）；取最大的显著峰
  let best: { k: number; r: number } | null = null;
  for (let i = 1; i < rs.length; i++) {
    const prev = rs[i - 1].r, next = i + 1 < rs.length ? rs[i + 1].r : 0;
    if (rs[i].k >= 4 && rs[i].r >= 1.9 && rs[i].r >= 1.15 * prev && rs[i].r >= 1.15 * next) best = rs[i];
  }
  if (!best) return null;
  const k = best.k;
  const pX = g.pitchX / k, pY = g.pitchY / k;
  let cols = g.cols * k, rows = g.rows * k;
  let x0 = g.x0, y0 = g.y0;
  // 沿两端补回粗线之外的细格：外沿那条线上有边缘（与外面的背景色之间）就算有格
  const sx = lineStats(px, x0, pX, cols), sy = lineStats(py, y0, pY, rows);
  const thrX = Math.max(2 * sx.off, 0.04 * sx.on), thrY = Math.max(2 * sy.off, 0.04 * sy.on);
  for (let j = 0; j < k - 1 && x0 - pX >= 0 && at(px, x0 - pX) >= thrX; j++) { x0 -= pX; cols++; }
  for (let j = 0; j < k - 1 && x0 + (cols + 1) * pX < img.width && at(px, x0 + (cols + 1) * pX) >= thrX; j++) cols++;
  for (let j = 0; j < k - 1 && y0 - pY >= 0 && at(py, y0 - pY) >= thrY; j++) { y0 -= pY; rows++; }
  for (let j = 0; j < k - 1 && y0 + (rows + 1) * pY < img.height && at(py, y0 + (rows + 1) * pY) >= thrY; j++) rows++;
  return { x0, y0, pitchX: pX, pitchY: pY, cols, rows, score: Math.min(g.score, 0.7) };
}
