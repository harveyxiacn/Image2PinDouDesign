import type { SampledCell, SampledGrid } from "./types";

const WHITE_MIN = 240;

function isWhite(cell: SampledCell, threshold: number): cell is NonNullable<SampledCell> {
  return Boolean(cell && cell.r >= threshold && cell.g >= threshold && cell.b >= threshold);
}

// 从四边做 flood-fill，把"与边缘相连的近白色"格子清成空格（null）：
// 这样主体外的白底不计入用豆、也不渲染色号，而主体内部的白（眼睛/高光，
// 不与边缘相连）会被保留。null 的透明/留白格可穿过传播，不阻断。
export function dropBorderWhite(grid: SampledGrid, threshold = WHITE_MIN): SampledGrid {
  const { width, height, cells } = grid;
  if (width === 0 || height === 0) {
    return grid;
  }

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
