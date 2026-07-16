import type { BeadDesign } from "./types";

export function replaceDesignCell(
  design: BeadDesign,
  x: number,
  y: number,
  nextCode: string | null
): BeadDesign {
  if (x < 0 || y < 0 || x >= design.boardWidth || y >= design.boardHeight) {
    return design;
  }

  const previousCode = design.matrix[y]?.[x] ?? null;
  if (previousCode === nextCode) {
    return design;
  }

  const matrix = design.matrix.slice();
  const row = (matrix[y] ?? new Array<string | null>(design.boardWidth).fill(null)).slice();
  row[x] = nextCode;
  matrix[y] = row;

  const colorCounts = { ...design.colorCounts };
  if (previousCode) {
    const remaining = (colorCounts[previousCode] ?? 1) - 1;
    if (remaining > 0) {
      colorCounts[previousCode] = remaining;
    } else {
      delete colorCounts[previousCode];
    }
  }
  if (nextCode) {
    colorCounts[nextCode] = (colorCounts[nextCode] ?? 0) + 1;
  }

  return { ...design, matrix, colorCounts };
}
export function mirrorDesignHorizontally(design: BeadDesign): BeadDesign {
  return {
    ...design,
    matrix: design.matrix.map((row) => row.slice().reverse()),
    colorCounts: { ...design.colorCounts }
  };
}

export function designFingerprint(design: Pick<BeadDesign, "boardWidth" | "boardHeight" | "matrix">): string {
  // 32-bit FNV-1a：足够区分本机制作进度，不把完整大矩阵塞进 localStorage key。
  let hash = 0x811c9dc5;
  const feed = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  feed(`${design.boardWidth}x${design.boardHeight}|`);
  for (const row of design.matrix) {
    for (const code of row) {
      feed(code ?? "_");
      feed(",");
    }
    feed(";");
  }
  return (hash >>> 0).toString(36);
}

export type ColorBuildProgress = {
  total: number;
  completed: number;
  remaining: number;
};

export function getColorBuildProgress(
  design: Pick<BeadDesign, "boardWidth" | "matrix">,
  completedCells: ReadonlySet<number>,
  colorCode: string
): ColorBuildProgress {
  let total = 0;
  let completed = 0;
  for (let y = 0; y < design.matrix.length; y += 1) {
    for (let x = 0; x < design.matrix[y].length; x += 1) {
      if (design.matrix[y][x] !== colorCode) {
        continue;
      }
      total += 1;
      if (completedCells.has(y * design.boardWidth + x)) {
        completed += 1;
      }
    }
  }
  return { total, completed, remaining: Math.max(0, total - completed) };
}
