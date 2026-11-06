// 图纸矩阵的纯编辑逻辑：归一化、指针→格子、画笔/橡皮一笔、整色替换、用量增减。
// 这里不依赖 React / DOM，方便在 node 环境直接单测；Canvas 手势在 MatrixView 里调用。
import type { Matrix } from "./matrix";
import type { Counts } from "./model";

export type MatrixCell = { r: number; c: number };
export type MatrixChange = MatrixCell & { from: string | null; to: string | null };
export type BrushSize = 1 | 2 | 3;

export function blankMatrix(width: number, height: number): Matrix {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  return Array.from({ length: h }, () => new Array<string | null>(w).fill(null));
}

/** 把矩阵裁/补成严格的 height × width，避免 OCR 结果行长度不一致导致画笔写错格。 */
export function normalizeMatrix(matrix: Matrix | undefined, width: number, height: number): Matrix {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  return Array.from({ length: h }, (_, r) => {
    const source = matrix?.[r];
    return Array.from({ length: w }, (_, c) => source?.[c] ?? null);
  });
}

export function matrixEqual(a: Matrix | null | undefined, b: Matrix | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let r = 0; r < a.length; r += 1) {
    if (a[r].length !== b[r].length) return false;
    for (let c = 0; c < a[r].length; c += 1) if (a[r][c] !== b[r][c]) return false;
  }
  return true;
}

/** 两版矩阵不同的格子数（用于保存时写“已手动修改 N 格”）。 */
export function matrixDiffCount(a: Matrix, b: Matrix): number {
  const height = Math.max(a.length, b.length);
  let count = 0;
  for (let r = 0; r < height; r += 1) {
    const rowA = a[r] ?? [];
    const rowB = b[r] ?? [];
    const width = Math.max(rowA.length, rowB.length);
    for (let c = 0; c < width; c += 1) if ((rowA[c] ?? null) !== (rowB[c] ?? null)) count += 1;
  }
  return count;
}

export function countsEqual(a: Counts, b: Counts): boolean {
  const codes = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const code of codes) if ((a[code] ?? 0) !== (b[code] ?? 0)) return false;
  return true;
}

/**
 * 指针位置 → 格子。使用 canvas 的实际位图尺寸与 CSS 尺寸换算，
 * 并扣除渲染器可能留下的坐标尺 gutter（当前 MatrixView 不显示坐标，gutter=0）。
 */
export function matrixCellAtPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  canvasWidth: number,
  canvasHeight: number,
  width: number,
  height: number,
  cellSize: number
): MatrixCell | null {
  if (rect.width <= 0 || rect.height <= 0 || canvasWidth <= 0 || canvasHeight <= 0 || cellSize <= 0) return null;
  const x = (clientX - rect.left) * (canvasWidth / rect.width) - (canvasWidth - width * cellSize);
  const y = (clientY - rect.top) * (canvasHeight / rect.height) - (canvasHeight - height * cellSize);
  const c = Math.floor(x / cellSize);
  const r = Math.floor(y / cellSize);
  return r >= 0 && r < height && c >= 0 && c < width ? { r, c } : null;
}

/** 以中心格扩展成 1×1 / 2×2 / 3×3；2×2 向右下扩展，3×3 向四周各扩 1 格。 */
export function brushCells(center: MatrixCell, size: BrushSize, width: number, height: number): MatrixCell[] {
  const n = size === 3 ? 3 : size === 2 ? 2 : 1;
  const startR = center.r - Math.floor((n - 1) / 2);
  const startC = center.c - Math.floor((n - 1) / 2);
  const cells: MatrixCell[] = [];
  for (let r = startR; r < startR + n; r += 1) {
    for (let c = startC; c < startC + n; c += 1) {
      if (r >= 0 && r < height && c >= 0 && c < width) cells.push({ r, c });
    }
  }
  return cells;
}

/** 两个中心点之间的直线补格（Bresenham），再套上笔刷大小；快速拖动不会漏格。 */
export function strokeCells(from: MatrixCell, to: MatrixCell, size: BrushSize, width: number, height: number): MatrixCell[] {
  let x0 = from.c;
  let y0 = from.r;
  const x1 = to.c;
  const y1 = to.r;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const seen = new Set<string>();
  const out: MatrixCell[] = [];
  for (;;) {
    for (const cell of brushCells({ r: y0, c: x0 }, size, width, height)) {
      const key = `${cell.r},${cell.c}`;
      if (!seen.has(key)) { seen.add(key); out.push(cell); }
    }
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return out;
}

export function cellsOfCode(matrix: Matrix, code: string, width: number, height: number): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) if ((matrix[r]?.[c] ?? null) === code) cells.push({ r, c });
  }
  return cells;
}

/** 同一批格子中只保留真正会变化的格；重复坐标自动去重。 */
export function changesFor(matrix: Matrix, cells: ReadonlyArray<MatrixCell>, code: string | null, width: number, height: number): MatrixChange[] {
  const seen = new Set<string>();
  const changes: MatrixChange[] = [];
  for (const cell of cells) {
    if (cell.r < 0 || cell.r >= height || cell.c < 0 || cell.c >= width) continue;
    const key = `${cell.r},${cell.c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const from = matrix[cell.r]?.[cell.c] ?? null;
    if (from !== code) changes.push({ ...cell, from, to: code });
  }
  return changes;
}

/** 应用逐格改动，返回新矩阵；没有改动时保持原引用。 */
export function applyChanges(matrix: Matrix, changes: ReadonlyArray<MatrixChange>): Matrix {
  if (!changes.length) return matrix;
  const next = matrix.slice();
  const copied = new Set<number>();
  for (const { r, c, to } of changes) {
    if (!copied.has(r)) {
      next[r] = (next[r] ?? []).slice();
      copied.add(r);
    }
    next[r][c] = to;
  }
  return next;
}

/**
 * 按“改前 → 改后”的差值调整用量，而不是重算整张图。
 * 这样图例多读出的色号、用户之前手改的数量都会保留；想要完全对齐矩阵时用 countMatrixColors。
 */
export function applyCountDelta(counts: Counts, changes: ReadonlyArray<MatrixChange>): Counts {
  if (!changes.length) return counts;
  const next = { ...counts };
  for (const { from, to } of changes) {
    if (from) {
      const remaining = (next[from] ?? 0) - 1;
      if (remaining > 0) next[from] = remaining;
      else delete next[from];
    }
    if (to) next[to] = (next[to] ?? 0) + 1;
  }
  return next;
}

export function paintCells(
  matrix: Matrix,
  counts: Counts,
  cells: ReadonlyArray<MatrixCell>,
  code: string | null,
  width: number,
  height: number
): { matrix: Matrix; counts: Counts; changes: MatrixChange[] } {
  const changes = changesFor(matrix, cells, code, width, height);
  if (!changes.length) return { matrix, counts, changes };
  return { matrix: applyChanges(matrix, changes), counts: applyCountDelta(counts, changes), changes };
}

export function replaceCode(
  matrix: Matrix,
  counts: Counts,
  from: string,
  to: string | null,
  width: number,
  height: number
): { matrix: Matrix; counts: Counts; changes: MatrixChange[] } {
  return paintCells(matrix, counts, cellsOfCode(matrix, from, width, height), to, width, height);
}

export function countMatrixColors(matrix: Matrix): Counts {
  const out: Counts = {};
  for (const row of matrix) {
    for (const code of row) if (code) out[code] = (out[code] ?? 0) + 1;
  }
  return out;
}
