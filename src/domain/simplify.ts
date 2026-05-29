import type { SampledCell, SampledGrid } from "./types";

// 参与中值的邻居最低 alpha：低于此值视为背景/抠图边缘，不计入，避免半透明暗边把主体边缘染黑。
const NEIGHBOR_ALPHA_MIN = 32;

// 边缘保持的中值滤波：把孤立碎噪点合并掉，同时保住色块边界（比高斯模糊更适合像素图）。
// passes = 应用 3x3 中值的遍数（1=弱，2=强）。比单次大窗口更能在降噪的同时保留特征。
// 透明/空格不参与、也不被填充，主体轮廓保持不变。
export function medianSmoothGrid(grid: SampledGrid, passes: number): SampledGrid {
  const count = Math.max(0, Math.floor(passes));
  let current = grid;
  for (let i = 0; i < count; i += 1) {
    current = medianPass(current);
  }
  return current;
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
