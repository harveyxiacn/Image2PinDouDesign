import { findNearestPaletteIndexByLab, rgbToLab } from "./color";
import type { PaletteColor, SampledCell, SampledGrid } from "./types";

// 参与中值的邻居最低 alpha：低于此值视为背景/抠图边缘，不计入，避免半透明暗边把主体边缘染黑。
const NEIGHBOR_ALPHA_MIN = 32;

// 边缘保持的中值滤波：把孤立碎噪点合并掉，同时保住色块边界（比高斯模糊更适合像素图）。
// passes = 应用 3x3 中值的遍数（1=弱，2=强）。比单次大窗口更能在降噪的同时保留特征。
// 透明/空格不参与、也不被填充，主体轮廓保持不变。
// 传入 palette 时先量化到色板再取中值：每个格子先映射到最近的色号，
// 再对邻居的"色号序号"取中值，保证输出颜色永远来自色板，不会合成色板外的颜色；
// 不传 palette 时保持旧的逐通道中值行为（兼容直接调用方）。
export function medianSmoothGrid(grid: SampledGrid, passes: number, palette?: PaletteColor[]): SampledGrid {
  const count = Math.max(0, Math.floor(passes));
  let current = grid;
  for (let i = 0; i < count; i += 1) {
    current = palette && palette.length > 0 ? medianPassOnPalette(current, palette) : medianPass(current);
  }
  return current;
}

// 色板中值遍：先把每个格子量化成色板序号，再取邻居序号的中值并回填该色板的 RGB。
function medianPassOnPalette(grid: SampledGrid, palette: PaletteColor[]): SampledGrid {
  const r = 1;
  const { width, height, cells } = grid;
  const out: SampledCell[] = new Array(width * height);
  const nearestIndex = new Int32Array(width * height);

  for (let index = 0; index < width * height; index += 1) {
    const cell = cells[index];
    if (!cell || cell.a < NEIGHBOR_ALPHA_MIN) {
      nearestIndex[index] = -1;
      continue;
    }
    nearestIndex[index] = findNearestPaletteIndexByLab(rgbToLab(cell), palette);
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const centerIndex = y * width + x;
      const center = cells[centerIndex];
      if (!center) {
        out[centerIndex] = null;
        continue;
      }

      const neighborIndices: number[] = [];
      let alphaSum = 0;
      let alphaCount = 0;
      for (let dy = -r; dy <= r; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          continue;
        }
        for (let dx = -r; dx <= r; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) {
            continue;
          }
          const neighborIndex = ny * width + nx;
          const nearest = nearestIndex[neighborIndex];
          if (nearest < 0) {
            continue;
          }
          const neighbor = cells[neighborIndex];
          if (!neighbor) {
            continue;
          }
          neighborIndices.push(nearest);
          alphaSum += neighbor.a;
          alphaCount += 1;
        }
      }

      if (neighborIndices.length === 0) {
        out[centerIndex] = center;
        continue;
      }
      const pickedIndex = modeIndex(neighborIndices, nearestIndex[centerIndex], center, palette);
      const picked = palette[pickedIndex];
      out[centerIndex] = {
        r: picked.rgb.r,
        g: picked.rgb.g,
        b: picked.rgb.b,
        a: alphaSum / alphaCount
      };
    }
  }

  return { width, height, cells: out };
}

// 多数票：色板序号按色号排序、不代表明暗，取中值会选出"夹在中间"的怪色，所以改为取出现最多的色。
// 平票时若中心格的色在其中则保留中心色，否则取与中心色 RGB 距离最近者；返回值永远是合法的色板下标。
function modeIndex(values: number[], centerIdx: number, center: SampledCell, palette: PaletteColor[]): number {
  const votes = new Map<number, number>();
  for (const value of values) votes.set(value, (votes.get(value) ?? 0) + 1);
  const best = Math.max(...votes.values());
  const tied = [...votes.entries()].filter(([, n]) => n === best).map(([index]) => index).sort((a, b) => a - b);
  if (tied.length === 1) return tied[0];
  if (tied.includes(centerIdx)) return centerIdx;
  if (!center) return tied[0];
  let pick = tied[0];
  let pickDist = Infinity;
  for (const index of tied) {
    const rgb = palette[index].rgb;
    const dist = (rgb.r - center.r) ** 2 + (rgb.g - center.g) ** 2 + (rgb.b - center.b) ** 2;
    if (dist < pickDist) {
      pick = index;
      pickDist = dist;
    }
  }
  return pick;
}

function medianPass(grid: SampledGrid): SampledGrid {
  const r = 1;
  const { width, height, cells } = grid;
  const out: SampledCell[] = new Array(width * height);

  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const center = cells[y * width + x];
      if (!center) {
        out[y * width + x] = null;
        continue;
      }

      reds.length = 0;
      greens.length = 0;
      blues.length = 0;
      let alphaSum = 0;
      let alphaCount = 0;

      for (let dy = -r; dy <= r; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          continue;
        }
        for (let dx = -r; dx <= r; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) {
            continue;
          }
          const neighbor = cells[ny * width + nx];
          if (!neighbor || neighbor.a < NEIGHBOR_ALPHA_MIN) {
            continue;
          }
          reds.push(neighbor.r);
          greens.push(neighbor.g);
          blues.push(neighbor.b);
          alphaSum += neighbor.a;
          alphaCount += 1;
        }
      }

      if (alphaCount === 0) {
        out[y * width + x] = center;
        continue;
      }
      out[y * width + x] = {
        r: median(reds),
        g: median(greens),
        b: median(blues),
        a: alphaSum / alphaCount
      };
    }
  }

  return { width, height, cells: out };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

