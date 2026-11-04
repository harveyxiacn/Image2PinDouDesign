// 标尺（坐标数字带）剥离：标尺行 / 列常带着网格线（蓝紫色底 + 白字，或白底 + 灰字），会被当成格子。
// 判据只看最外圈一行 / 一列：整条同色底 + 几乎每格有字 + 这个底色在图内几乎不出现（或图内同色格基本无字）。
import type { GridDetection, PixelSource } from "./types";

type Fill = { r: number; g: number; b: number; frac: number; ink: boolean };
export type Side = "t" | "b" | "l" | "r";

const l1 = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) =>
  Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

/** 一格（取内缩后的矩形）的主色 + 中央文字带里有没有“墨迹”。 */
export function cellFill(src: PixelSource, grid: GridDetection, cx: number, cy: number, hist: Int32Array): Fill | null {
  const { pitchX, pitchY } = grid;
  const insX = Math.max(1, pitchX * 0.2), insY = Math.max(1, pitchY * 0.2);
  const ax = grid.x0 + cx * pitchX + insX, bx = grid.x0 + (cx + 1) * pitchX - insX;
  const ay = grid.y0 + cy * pitchY + insY, by = grid.y0 + (cy + 1) * pitchY - insY;
  const x0 = Math.max(0, Math.ceil(ax)), x1 = Math.min(src.width - 1, Math.floor(bx));
  const y0 = Math.max(0, Math.ceil(ay)), y1 = Math.min(src.height - 1, Math.floor(by));
  if (x1 < x0 || y1 < y0) return null;
  const d = src.data;
  const keys: number[] = [];
  for (let y = y0; y <= y1; y += 1) {
    let i = (y * src.width + x0) * 4;
    for (let x = x0; x <= x1; x += 1, i += 4) {
      const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      hist[k] += 1;
      keys.push(k);
    }
  }
  let bestK = 0, bestC = -1;
  for (const k of keys) { if (hist[k] > bestC) { bestC = hist[k]; bestK = k; } }
  for (const k of keys) hist[k] = 0;
  const cr = ((bestK >> 8) << 4) + 8, cg = (((bestK >> 4) & 15) << 4) + 8, cb = ((bestK & 15) << 4) + 8;
  let sr = 0, sg = 0, sb = 0, n = 0, tot = 0, ink = 0, band = 0;
  const my = grid.y0 + (cy + 0.5) * pitchY;
  for (let y = y0; y <= y1; y += 1) {
    let i = (y * src.width + x0) * 4;
    const inBand = Math.abs((y + 0.5 - my) / pitchY) < 0.26;
    for (let x = x0; x <= x1; x += 1, i += 4) {
      tot += 1;
      const near = Math.abs(d[i] - cr) + Math.abs(d[i + 1] - cg) + Math.abs(d[i + 2] - cb) <= 48;
      if (near) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n += 1; }
    }
  }
  if (!n) return null;
  const r = sr / n, g = sg / n, b = sb / n;
  for (let y = y0; y <= y1; y += 1) {
    if (Math.abs((y + 0.5 - my) / pitchY) >= 0.26) continue;
    let i = (y * src.width + x0) * 4;
    for (let x = x0; x <= x1; x += 1, i += 4) {
      band += 1;
      if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) > 90) ink += 1;
    }
  }
  return { r, g, b, frac: n / tot, ink: band >= 6 && ink >= Math.max(3, 0.05 * band) };
}


type RGB = { r: number; g: number; b: number };

function boxOf(src: PixelSource, grid: GridDetection, cx: number, cy: number) {
  const insX = Math.max(1, grid.pitchX * 0.2), insY = Math.max(1, grid.pitchY * 0.2);
  return {
    x0: Math.max(0, Math.ceil(grid.x0 + cx * grid.pitchX + insX)), x1: Math.min(src.width - 1, Math.floor(grid.x0 + (cx + 1) * grid.pitchX - insX)),
    y0: Math.max(0, Math.ceil(grid.y0 + cy * grid.pitchY + insY)), y1: Math.min(src.height - 1, Math.floor(grid.y0 + (cy + 1) * grid.pitchY - insY))
  };
}

/** 一串格子里占比最高的“有彩色”颜色（饱和度够高；白 / 灰 / 黑不算）及其像素占比。 */
function chromaticMode(src: PixelSource, grid: GridDetection, cells: Array<[number, number]>, hist: Int32Array): { color: RGB; share: number } | null {
  const d = src.data;
  let total = 0;
  const keys: number[] = [];
  for (const [cx, cy] of cells) {
    const b = boxOf(src, grid, cx, cy);
    for (let y = b.y0; y <= b.y1; y += 1) {
      let i = (y * src.width + b.x0) * 4;
      for (let x = b.x0; x <= b.x1; x += 1, i += 4) {
        total += 1;
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        if (mx - mn < 40) continue;
        const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
        hist[k] += 1;
        keys.push(k);
      }
    }
  }
  if (!total) return null;
  let bestK = -1, bestS = 0;
  const seen = new Set<number>();
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    const r4 = k >> 8, g4 = (k >> 4) & 15, b4 = k & 15;
    let sc = 0;
    for (let dr = -1; dr <= 1; dr += 1) for (let dg = -1; dg <= 1; dg += 1) for (let db = -1; db <= 1; db += 1) {
      const rr = r4 + dr, gg = g4 + dg, bb = b4 + db;
      if (rr < 0 || gg < 0 || bb < 0 || rr > 15 || gg > 15 || bb > 15) continue;
      sc += hist[(rr << 8) | (gg << 4) | bb];
    }
    if (sc > bestS) { bestS = sc; bestK = k; }
  }
  for (const k of keys) hist[k] = 0;
  if (bestK < 0) return null;
  const color = { r: ((bestK >> 8) << 4) + 8, g: (((bestK >> 4) & 15) << 4) + 8, b: ((bestK & 15) << 4) + 8 };
  return { color, share: bestS / total };
}

function pixelShare(src: PixelSource, grid: GridDetection, cells: Array<[number, number]>, c: RGB, tol: number): number {
  const d = src.data;
  let hit = 0, total = 0;
  for (const [cx, cy] of cells) {
    const b = boxOf(src, grid, cx, cy);
    for (let y = b.y0; y <= b.y1; y += 1) {
      let i = (y * src.width + b.x0) * 4;
      for (let x = b.x0; x <= b.x1; x += 1, i += 4) {
        total += 1;
        if (Math.abs(d[i] - c.r) + Math.abs(d[i + 1] - c.g) + Math.abs(d[i + 2] - c.b) <= tol) hit += 1;
      }
    }
  }
  return total ? hit / total : 0;
}

/** 判断最外圈哪几边是标尺。 */
export function rulerSides(src: PixelSource, grid: GridDetection): Side[] {
  const { cols, rows } = grid;
  if (cols < 10 || rows < 10) return [];
  const hist = new Int32Array(4096);
  const strip = (side: Side) => {
    const out: Array<Fill | null> = [];
    if (side === "t" || side === "b") {
      const y = side === "t" ? 0 : rows - 1;
      for (let x = 1; x < cols - 1; x += 1) out.push(cellFill(src, grid, x, y, hist));
    } else {
      const x = side === "l" ? 0 : cols - 1;
      for (let y = 1; y < rows - 1; y += 1) out.push(cellFill(src, grid, x, y, hist));
    }
    return out.filter((f): f is Fill => !!f);
  };
  // 图内参照：均匀取样内部格（至少离边 2 格）
  const inner: Fill[] = [];
  const total = (cols - 4) * (rows - 4);
  if (total <= 0) return [];
  const stride = Math.max(1, Math.floor(total / 500));
  const innerCells: Array<[number, number]> = [];
  for (let i = 0; i < total; i += stride) {
    const x = 2 + (i % (cols - 4)), y = 2 + Math.floor(i / (cols - 4));
    innerCells.push([x, y]);
    const f = cellFill(src, grid, x, y, hist);
    if (f) inner.push(f);
  }
  if (inner.length < 20) return [];
  const sides: Side[] = [];
  for (const side of ["t", "b", "l", "r"] as Side[]) {
    const s = strip(side);
    if (s.length < 8) continue;
    const inkRate = s.filter((f) => f.ink).length / s.length;
    if (inkRate < 0.6) continue;
    if (inkRate >= 0.6 && s.length >= 8) {
      // 蓝 / 紫色底 + 白字的标尺：像素层面主导“有彩色”颜色占一大半，且这种颜色在图内几乎不出现
      const cells: Array<[number, number]> = side === "t" || side === "b"
        ? Array.from({ length: cols - 2 }, (_, i) => [i + 1, side === "t" ? 0 : rows - 1] as [number, number])
        : Array.from({ length: rows - 2 }, (_, i) => [side === "l" ? 0 : cols - 1, i + 1] as [number, number]);
      const cm = chromaticMode(src, grid, cells, hist);
      if (cm && cm.share >= 0.3 && pixelShare(src, grid, innerCells, cm.color, 60) < 0.02) { sides.push(side); continue; }
    }
    // 浅色底 + 数字的标尺：底色（各格里偏亮的主色）与图内空格同色，但图内这种格子基本没有字
    const light = s.filter((f) => f.r + f.g + f.b >= 600);
    if (light.length < 0.3 * s.length || inkRate < 0.7) continue;
    const med = (k: "r" | "g" | "b") => [...light].map((f) => f[k]).sort((a, b) => a - b)[light.length >> 1];
    const fill = { r: med("r"), g: med("g"), b: med("b") };
    const same = inner.filter((f) => l1(f, fill) <= 36);
    const sameInk = same.length ? same.filter((f) => f.ink).length / same.length : 0;
    if (same.length >= 0.05 * inner.length ? sameInk < 0.45 && inkRate >= 0.8 : light.length >= 0.6 * s.length) sides.push(side);
  }
  return sides;
}

export function trimRulerBands(src: PixelSource, grid0: GridDetection): { grid: GridDetection; trimmed: number } {
  let grid = grid0;
  let trimmed = 0;
  for (let iter = 0; iter < 5; iter += 1) {
    const sides = rulerSides(src, grid);
    if (!sides.length) break;
    const g = { ...grid };
    if (sides.includes("t")) { g.y0 += g.pitchY; g.rows -= 1; trimmed += 1; }
    if (sides.includes("b")) { g.rows -= 1; trimmed += 1; }
    if (sides.includes("l")) { g.x0 += g.pitchX; g.cols -= 1; trimmed += 1; }
    if (sides.includes("r")) { g.cols -= 1; trimmed += 1; }
    grid = g;
  }
  return { grid, trimmed };
}
