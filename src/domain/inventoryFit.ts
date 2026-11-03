import { ciede2000 } from "./color";
import { countMatrixColors } from "./conversion";
import type { BeadDesign, PaletteColor } from "./types";

// 按库存调整：某色需要的颗数超过手上库存时，把多出的格子换成“手上有余量、且几乎看不出差别”的颜色。
// 只换色差在阈值内的颜色，保证成品观感基本不变；换不了的部分如实列为“仍需购买”。

// CIEDE2000 ≤ 8：并排细看才能分辨，隔开半米基本一致。
export const INVENTORY_SWAP_MAX_DELTA_E = 8;

export type InventorySubstitution = { from: string; to: string; count: number; deltaE: number };

export type InventoryFitResult = {
  design: BeadDesign;
  substitutions: InventorySubstitution[];
  // 调整后仍然不够的颜色与缺口颗数。
  remaining: Record<string, number>;
};

export function fitDesignToInventory(
  design: BeadDesign,
  owned: Record<string, number>,
  palette: PaletteColor[],
  maxDeltaE = INVENTORY_SWAP_MAX_DELTA_E
): InventoryFitResult {
  const byCode = new Map(palette.map((color) => [color.code, color]));
  const needed = countMatrixColors(design.matrix);
  // 每种颜色还能拿出多少颗（库存 - 本图已用）。
  const spare = new Map<string, number>();
  for (const color of palette) {
    const available = (owned[color.code] ?? 0) - (needed[color.code] ?? 0);
    if (available > 0) spare.set(color.code, available);
  }

  const matrix = design.matrix.map((row) => row.slice());
  const substitutions: InventorySubstitution[] = [];
  const remaining: Record<string, number> = {};
  // 缺口大的颜色优先分配替代色。
  const shortages = Object.entries(needed)
    .map(([code, count]) => ({ code, missing: count - (owned[code] ?? 0) }))
    .filter((entry) => entry.missing > 0)
    .sort((left, right) => right.missing - left.missing);

  for (const { code, missing } of shortages) {
    const source = byCode.get(code);
    let left = missing;
    if (source) {
      const candidates = [...spare.keys()]
        .map((candidate) => ({ code: candidate, deltaE: ciede2000(source.lab, byCode.get(candidate)!.lab) }))
        .filter((candidate) => candidate.code !== code && candidate.deltaE <= maxDeltaE)
        .sort((a, b) => a.deltaE - b.deltaE);
      for (const candidate of candidates) {
        if (left <= 0) break;
        const take = Math.min(left, spare.get(candidate.code) ?? 0);
        if (take <= 0) continue;
        const replaced = replaceCells(matrix, code, candidate.code, take);
        if (replaced <= 0) continue;
        spare.set(candidate.code, (spare.get(candidate.code) ?? 0) - replaced);
        substitutions.push({ from: code, to: candidate.code, count: replaced, deltaE: Math.round(candidate.deltaE * 10) / 10 });
        left -= replaced;
      }
    }
    if (left > 0) remaining[code] = left;
  }

  if (substitutions.length === 0) {
    return { design, substitutions, remaining };
  }
  return {
    design: { ...design, matrix, colorCounts: countMatrixColors(matrix) },
    substitutions,
    remaining
  };
}

// 优先替换“邻居里已有替代色”的格子（换完更像自然过渡），再按扫描顺序补足。
function replaceCells(matrix: Array<Array<string | null>>, from: string, to: string, limit: number): number {
  const positions: Array<{ x: number; y: number; score: number }> = [];
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix[y].length; x += 1) {
      if (matrix[y][x] !== from) continue;
      let score = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (matrix[y + dy]?.[x + dx] === to) score += 1;
      }
      positions.push({ x, y, score });
    }
  }
  positions.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  const chosen = positions.slice(0, limit);
  for (const { x, y } of chosen) matrix[y][x] = to;
  return chosen.length;
}
