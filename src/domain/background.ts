import { ciede2000, rgbToLab } from "./color";
import type { Rgb, SampledCell, SampledGrid } from "./types";

const WHITE_MIN = 240;

function isWhite(cell: SampledCell, threshold: number): cell is NonNullable<SampledCell> {
  return Boolean(cell && cell.r >= threshold && cell.g >= threshold && cell.b >= threshold);
}

export type DropBorderWhiteOptions = {
  // 背景容差（ΔE00）：不传时按边缘颜色方差自适应估算。
  tolerance?: number;
  // false 时完全走旧的"固定阈值判白"逻辑；默认（undefined/true）走自适应背景估计。
  adaptive?: boolean;
};

// 从四边做 flood-fill，把"与边缘相连的背景色"格子清成空格（null）：
// 这样主体外的背景不计入用豆、也不渲染色号，而主体内部同色格（眼睛/高光，
// 不与边缘相连）会被保留。null 的透明/留白格可穿过传播，不阻断。
//
// 默认（adaptive）先估计边缘主色再以 ΔE 容差泛洪，能处理浅灰、米黄、浅蓝等
// 非纯白背景；只有边缘主色明显偏亮时才启用自适应，否则退回旧阈值逻辑，
// 避免把彩色主体边缘误判成背景。
export function dropBorderWhite(
  grid: SampledGrid,
  threshold = WHITE_MIN,
  options: DropBorderWhiteOptions = {}
): SampledGrid {
  const { width, height, cells } = grid;
  if (width === 0 || height === 0) {
    return grid;
  }

  if (options.adaptive === false) {
    return legacyDropBorderWhite(grid, threshold);
  }

  const estimate = estimateBorderColor(grid);
  if (!estimate || !isLightBackground(estimate.color)) {
    // 边缘颜色不稳定或不是浅色背景（如彩色主体贴边）：退回旧的固定阈值逻辑，
    // 与历史行为保持一致。
    return legacyDropBorderWhite(grid, threshold);
  }

  const tolerance = options.tolerance ?? autoTolerance(estimate);
  return floodRemoveBackground(grid, estimate.color, tolerance);
}

// 旧逻辑：只清与边缘连通、且 RGB 都 >= threshold 的近白格。
function legacyDropBorderWhite(grid: SampledGrid, threshold: number): SampledGrid {
  const { width, height, cells } = grid;
  const out: SampledCell[] = cells.slice();
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  let removed = 0;

  const seed = (x: number, y: number) => {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      stack.push(y * width + x);
    }
  };
  for (let x = 0; x < width; x += 1) {
    seed(x, 0);
    seed(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    seed(0, y);
    seed(width - 1, y);
  }

  while (stack.length > 0) {
    const idx = stack.pop()!;
    if (visited[idx]) {
      continue;
    }
    visited[idx] = 1;

    const cell = out[idx];
    if (cell && !isWhite(cell, threshold)) {
      // 撞到有色主体，停止扩散
      continue;
    }
    if (isWhite(cell, threshold)) {
      out[idx] = null;
      removed += 1;
    }
    // null（留白）或刚被清掉的白，继续向四邻扩散
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) stack.push(idx - 1);
    if (x < width - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - width);
    if (y < height - 1) stack.push(idx + width);
  }

  return removed > 0 ? { width, height, cells: out } : grid;
}

// 从四边采样，用直方图找占主导的边缘色（与 backgroundRemoval 的思路一致，
// 但直接作用在采样网格上，不要求整幅图来自同一张位图）。
function estimateBorderColor(grid: SampledGrid): { color: Rgb; p95Distance: number; sampleCount: number } | null {
  const { width, height, cells } = grid;
  if (width < 2 || height < 2) {
    return null;
  }

  const samples: Rgb[] = [];
  const histogram = new Map<number, number>();
  const sample = (x: number, y: number) => {
    const cell = cells[y * width + x];
    if (!cell || cell.a < 224) {
      return;
    }
    const rgb = { r: cell.r, g: cell.g, b: cell.b };
    samples.push(rgb);
    const bucket = (rgb.r >> 4) << 8 | (rgb.g >> 4) << 4 | (rgb.b >> 4);
    histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
  };

  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    if (height > 1) sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(0, y);
    if (width > 1) sample(width - 1, y);
  }

  if (samples.length < Math.max(4, (width + height) * 0.5)) {
    return null;
  }

  let dominantBucket = -1;
  let dominantCount = 0;
  for (const [bucket, count] of histogram) {
    if (count > dominantCount) {
      dominantBucket = bucket;
      dominantCount = count;
    }
  }

  const bucketSamples = samples.filter((sample) => {
    const bucket = (sample.r >> 4) << 8 | (sample.g >> 4) << 4 | (sample.b >> 4);
    return bucket === dominantBucket;
  });
  if (bucketSamples.length === 0) {
    return null;
  }

  const color = bucketSamples.reduce<Rgb>((sum, sample) => ({
    r: sum.r + sample.r,
    g: sum.g + sample.g,
    b: sum.b + sample.b
  }), { r: 0, g: 0, b: 0 });
  color.r /= bucketSamples.length;
  color.g /= bucketSamples.length;
  color.b /= bucketSamples.length;

  const distances = samples
    .map((sample) => Math.hypot(sample.r - color.r, sample.g - color.g, sample.b - color.b))
    .sort((a, b) => a - b);
  const p95 = distances[Math.min(distances.length - 1, Math.floor(distances.length * 0.95))] ?? 0;
  return { color, p95Distance: p95, sampleCount: samples.length };
}

// 浅色背景判定：亮度足够高才做自适应去除，避免把饱和彩色主体贴边误删。
function isLightBackground(color: Rgb): boolean {
  return (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) >= 200;
}

// 背景容差：按边缘色方差自适应；方差小（均匀背景）用小容差，方差大（渐变/抗锯齿）放宽。
function autoTolerance(estimate: { p95Distance: number }): number {
  return clamp(estimate.p95Distance * 1.5 + 4, 4, 14);
}

// ΔE 容差泛洪：只清与边缘连通、且与背景色色差 <= tolerance 的格子。
// 近透明（alpha < 16）格视为留白穿过，不阻断也不清除。
function floodRemoveBackground(grid: SampledGrid, background: Rgb, tolerance: number): SampledGrid {
  const { width, height, cells } = grid;
  const out: SampledCell[] = cells.slice();
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  let removed = 0;
  const backgroundLab = rgbToLab(background);

  const seed = (x: number, y: number) => {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      stack.push(y * width + x);
    }
  };
  for (let x = 0; x < width; x += 1) {
    seed(x, 0);
    seed(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    seed(0, y);
    seed(width - 1, y);
  }

  while (stack.length > 0) {
    const idx = stack.pop()!;
    if (visited[idx]) {
      continue;
    }
    visited[idx] = 1;

    const cell = out[idx];
    if (!cell) {
      // null 留白格：穿过，不阻断
      pushNeighbors(idx, width, height, stack);
      continue;
    }
    if (cell.a < 16) {
      // 近透明格：穿过，不清除（保留原 RGB，后续由 alpha 阈值决定是否入豆）
      pushNeighbors(idx, width, height, stack);
      continue;
    }
    if (ciede2000(rgbToLab(cell), backgroundLab) <= tolerance) {
      out[idx] = null;
      removed += 1;
      pushNeighbors(idx, width, height, stack);
    }
    // 其余为有色主体，停止扩散
  }

  return removed > 0 ? { width, height, cells: out } : grid;
}

function pushNeighbors(idx: number, width: number, height: number, stack: number[]): void {
  const x = idx % width;
  const y = (idx - x) / width;
  if (x > 0) stack.push(idx - 1);
  if (x < width - 1) stack.push(idx + 1);
  if (y > 0) stack.push(idx - width);
  if (y < height - 1) stack.push(idx + width);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
