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
/**
 * 批量改格（画笔 / 橡皮一笔拖动）：一次生成新图纸，便于整笔作为一步撤销。
 * 越界或颜色不变的格子忽略；没有任何变化时返回原引用。
 */
export function replaceDesignCells(
  design: BeadDesign,
  cells: ReadonlyArray<{ x: number; y: number }>,
  nextCode: string | null
): BeadDesign {
  let matrix: BeadDesign["matrix"] | null = null;
  const colorCounts = { ...design.colorCounts };
  const copiedRows = new Set<number>();
  for (const { x, y } of cells) {
    if (x < 0 || y < 0 || x >= design.boardWidth || y >= design.boardHeight) continue;
    const previousCode = (matrix ?? design.matrix)[y]?.[x] ?? null;
    if (previousCode === nextCode) continue;
    matrix ??= design.matrix.slice();
    if (!copiedRows.has(y)) {
      matrix[y] = (matrix[y] ?? new Array<string | null>(design.boardWidth).fill(null)).slice();
      copiedRows.add(y);
    }
    matrix[y][x] = nextCode;
    if (previousCode) {
      const remaining = (colorCounts[previousCode] ?? 1) - 1;
      if (remaining > 0) colorCounts[previousCode] = remaining;
      else delete colorCounts[previousCode];
    }
    if (nextCode) colorCounts[nextCode] = (colorCounts[nextCode] ?? 0) + 1;
  }
  return matrix ? { ...design, matrix, colorCounts } : design;
}

export type CellPatch = { x: number; y: number; code: string | null };

/** 一次写入多格、每格颜色可不同（粘贴、整体换色）；没有任何变化时返回原引用。 */
export function applyCellPatch(design: BeadDesign, changes: ReadonlyArray<CellPatch>): BeadDesign {
  let matrix: BeadDesign["matrix"] | null = null;
  const colorCounts = { ...design.colorCounts };
  const copiedRows = new Set<number>();
  for (const { x, y, code } of changes) {
    if (x < 0 || y < 0 || x >= design.boardWidth || y >= design.boardHeight) continue;
    const previousCode = (matrix ?? design.matrix)[y]?.[x] ?? null;
    if (previousCode === code) continue;
    matrix ??= design.matrix.slice();
    if (!copiedRows.has(y)) {
      matrix[y] = (matrix[y] ?? new Array<string | null>(design.boardWidth).fill(null)).slice();
      copiedRows.add(y);
    }
    matrix[y][x] = code;
    if (previousCode) {
      const remaining = (colorCounts[previousCode] ?? 1) - 1;
      if (remaining > 0) colorCounts[previousCode] = remaining;
      else delete colorCounts[previousCode];
    }
    if (code) colorCounts[code] = (colorCounts[code] ?? 0) + 1;
  }
  return matrix ? { ...design, matrix, colorCounts } : design;
}

/** 油漆桶：从 (x, y) 出发、上下左右相连且颜色相同（含空格）的全部格子。 */
export function floodFillRegion(
  design: Pick<BeadDesign, "boardWidth" | "boardHeight" | "matrix">,
  x: number,
  y: number
): Array<{ x: number; y: number }> {
  const { boardWidth: width, boardHeight: height } = design;
  if (x < 0 || y < 0 || x >= width || y >= height) return [];
  const target = design.matrix[y]?.[x] ?? null;
  const seen = new Uint8Array(width * height);
  const cells: Array<{ x: number; y: number }> = [];
  const stack = [y * width + x];
  seen[y * width + x] = 1;
  while (stack.length > 0) {
    const index = stack.pop()!;
    const cx = index % width;
    const cy = (index - cx) / width;
    cells.push({ x: cx, y: cy });
    const neighbours = [
      cx > 0 ? index - 1 : -1,
      cx < width - 1 ? index + 1 : -1,
      cy > 0 ? index - width : -1,
      cy < height - 1 ? index + width : -1
    ];
    for (const next of neighbours) {
      if (next < 0 || seen[next]) continue;
      const nx = next % width;
      const ny = (next - nx) / width;
      if ((design.matrix[ny]?.[nx] ?? null) !== target) continue;
      seen[next] = 1;
      stack.push(next);
    }
  }
  return cells;
}

/** 整图换色：把所有 from 色号的格子列出来（交给批量改格一次提交）。 */
export function cellsWithCode(
  design: Pick<BeadDesign, "boardWidth" | "boardHeight" | "matrix">,
  code: string | null
): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < design.boardHeight; y += 1) {
    for (let x = 0; x < design.boardWidth; x += 1) {
      if ((design.matrix[y]?.[x] ?? null) === code) cells.push({ x, y });
    }
  }
  return cells;
}

export type CellRect = { x: number; y: number; width: number; height: number };

/** 两个角点 → 规整的矩形（含两端），并裁到图纸范围内。 */
export function normalizeRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  bounds: Pick<BeadDesign, "boardWidth" | "boardHeight">
): CellRect {
  const left = Math.max(0, Math.min(a.x, b.x));
  const top = Math.max(0, Math.min(a.y, b.y));
  const right = Math.min(bounds.boardWidth - 1, Math.max(a.x, b.x));
  const bottom = Math.min(bounds.boardHeight - 1, Math.max(a.y, b.y));
  return { x: left, y: top, width: Math.max(0, right - left + 1), height: Math.max(0, bottom - top + 1) };
}

/** 复制选区：返回按行排列的色号块。 */
export function copyRect(design: Pick<BeadDesign, "matrix">, rect: CellRect): Array<Array<string | null>> {
  return Array.from({ length: rect.height }, (_, dy) =>
    Array.from({ length: rect.width }, (_, dx) => design.matrix[rect.y + dy]?.[rect.x + dx] ?? null));
}

/** 粘贴：把色号块放到 (x, y) 为左上角的位置；空格默认不覆盖原有颜色（透明粘贴）。 */
export function pastePatch(
  block: ReadonlyArray<ReadonlyArray<string | null>>,
  x: number,
  y: number,
  options: { includeEmpty?: boolean } = {}
): CellPatch[] {
  const changes: CellPatch[] = [];
  block.forEach((row, dy) => row.forEach((code, dx) => {
    if (code === null && !options.includeEmpty) return;
    changes.push({ x: x + dx, y: y + dy, code });
  }));
  return changes;
}

/** 选区内全部格子写成同一个色号（null 即清空）。 */
export function fillRectPatch(rect: CellRect, code: string | null): CellPatch[] {
  const changes: CellPatch[] = [];
  for (let dy = 0; dy < rect.height; dy += 1) {
    for (let dx = 0; dx < rect.width; dx += 1) changes.push({ x: rect.x + dx, y: rect.y + dy, code });
  }
  return changes;
}

/** 左右对称：x 关于图纸中线的镜像位置。 */
export function mirrorX(x: number, width: number): number {
  return width - 1 - x;
}

export type BoardTile = { index: number; col: number; row: number; x: number; y: number; width: number; height: number };

/** 按板（每块 pins × pins）切分图纸，返回每块在整图里的格子范围，供“按板制作”导航。 */
export function boardTiles(design: Pick<BeadDesign, "boardWidth" | "boardHeight">, pins: number): BoardTile[] {
  const size = Number.isFinite(pins) && pins > 0 ? Math.floor(pins) : 52;
  const cols = Math.max(1, Math.ceil(design.boardWidth / size));
  const rows = Math.max(1, Math.ceil(design.boardHeight / size));
  const tiles: BoardTile[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = col * size;
      const y = row * size;
      tiles.push({
        index: tiles.length, col, row, x, y,
        width: Math.min(size, design.boardWidth - x),
        height: Math.min(size, design.boardHeight - y)
      });
    }
  }
  return tiles;
}

export function mirrorDesignHorizontally(design: BeadDesign): BeadDesign {
  return {
    ...design,
    matrix: design.matrix.map((row) => row.slice().reverse()),
    colorCounts: { ...design.colorCounts },
    pixelated: design.pixelated ? mirrorPixels(design.pixelated) : undefined
  };
}

function mirrorPixels(source: NonNullable<BeadDesign["pixelated"]>): NonNullable<BeadDesign["pixelated"]> {
  const data = new Uint8ClampedArray(source.data.length);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const from = (y * source.width + x) * 4;
      const to = (y * source.width + (source.width - 1 - x)) * 4;
      data[to] = source.data[from];
      data[to + 1] = source.data[from + 1];
      data[to + 2] = source.data[from + 2];
      data[to + 3] = source.data[from + 3];
    }
  }
  return { width: source.width, height: source.height, data };
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
  colorCode: string | null,
  region?: CellRect | null
): ColorBuildProgress {
  let total = 0;
  let completed = 0;
  const yFrom = region ? region.y : 0;
  const yTo = region ? Math.min(design.matrix.length, region.y + region.height) : design.matrix.length;
  for (let y = yFrom; y < yTo; y += 1) {
    const xFrom = region ? region.x : 0;
    const xTo = region ? Math.min(design.matrix[y].length, region.x + region.width) : design.matrix[y].length;
    for (let x = xFrom; x < xTo; x += 1) {
      // colorCode 为 null 表示“全部颜色”（只统计有豆的格子）。
      const code = design.matrix[y][x];
      if (colorCode === null ? code === null : code !== colorCode) {
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
