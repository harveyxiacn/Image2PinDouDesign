import { ciede2000 } from "./color";
import type { BeadMatrix, PaletteColor } from "./types";

// 量化之后的拼豆专用清理：真实拼豆时，一颗被不同颜色包围、又和邻居几乎同色的“孤豆”
// 既看不出区别，又要多买一个色号、多找一次豆子。这里只处理这类低价值噪点，
// 眼睛高光、细线等高对比细节因为色差大而保留。

// 默认色差阈值（CIEDE2000）：大约是“并排放能看出差别、隔一臂远就分不清”的程度。
export const ISOLATED_BEAD_MAX_DELTA_E = 20;
export const RARE_COLOR_MAX_DELTA_E = 24;

const NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, -1, 1], [0, -1, 2], [1, -1, 1],
  [-1, 0, 2], [1, 0, 2],
  [-1, 1, 1], [0, 1, 2], [1, 1, 1]
];

function createDeltaE(palette: PaletteColor[]) {
  const byCode = new Map(palette.map((color) => [color.code, color]));
  const cache = new Map<string, number>();
  return (left: string, right: string): number => {
    const key = left < right ? `${left}|${right}` : `${right}|${left}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const a = byCode.get(left);
    const b = byCode.get(right);
    const value = a && b ? ciede2000(a.lab, b.lab) : Infinity;
    cache.set(key, value);
    return value;
  };
}

/**
 * 孤豆清理：8 邻域里没有同色、且周围基本被豆子填满（不在主体轮廓上）的格子，
 * 并入“邻居中票数足够、色差最小”的颜色；色差超过阈值的视为真实细节保留。
 * 只读原矩阵判断，结果与遍历顺序无关；没有改动时返回原引用。
 */
export function cleanupIsolatedBeads(
  matrix: BeadMatrix,
  palette: PaletteColor[],
  maxDeltaE = ISOLATED_BEAD_MAX_DELTA_E
): BeadMatrix {
  const height = matrix.length;
  const width = height > 0 ? matrix[0].length : 0;
  if (width < 3 || height < 3) return matrix;
  const deltaE = createDeltaE(palette);
  let output: BeadMatrix | null = null;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const code = matrix[y][x];
      if (!code) continue;
      const votes = new Map<string, number>();
      let filled = 0;
      let hasSame = false;
      for (const [dx, dy, weight] of NEIGHBORS) {
        const neighbor = matrix[y + dy]?.[x + dx];
        if (!neighbor) continue;
        filled += 1;
        if (neighbor === code) {
          hasSame = true;
          break;
        }
        votes.set(neighbor, (votes.get(neighbor) ?? 0) + weight);
      }
      // 轮廓与画布边缘的格子不足 6 个实心邻居：它们决定剪影形状，不动。
      if (hasSame || filled < 6) continue;

      let replacement: string | null = null;
      let bestDistance = maxDeltaE;
      for (const [candidate, vote] of votes) {
        // 至少一条边相邻 + 一个角，或两条边：避免被单个对角邻居“拉走”。
        if (vote < 3) continue;
        const distance = deltaE(code, candidate);
        if (distance <= bestDistance) {
          bestDistance = distance;
          replacement = candidate;
        }
      }
      if (!replacement) continue;
      output ??= matrix.map((row) => row.slice());
      output[y][x] = replacement;
    }
  }

  return output ?? matrix;
}

/**
 * 零散色合并：用量少于 minCount 的颜色，若存在色差不超过阈值的“常用色”（用量 ≥ minCount），
 * 整体替换为最接近的常用色。找不到相近常用色的稀有色（例如独特的眼睛颜色）保留。
 */
export function mergeRareColors(
  matrix: BeadMatrix,
  palette: PaletteColor[],
  minCount: number,
  maxDeltaE = RARE_COLOR_MAX_DELTA_E
): BeadMatrix {
  if (!Number.isFinite(minCount) || minCount <= 1) return matrix;
  const counts = new Map<string, number>();
  for (const row of matrix) {
    for (const code of row) {
      if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  const common = [...counts].filter(([, count]) => count >= minCount).map(([code]) => code);
  if (common.length === 0) return matrix;
  const deltaE = createDeltaE(palette);
  const mapping = new Map<string, string>();
  for (const [code, count] of counts) {
    if (count >= minCount) continue;
    let best: string | null = null;
    let bestDistance = maxDeltaE;
    for (const candidate of common) {
      const distance = deltaE(code, candidate);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    if (best) mapping.set(code, best);
  }
  if (mapping.size === 0) return matrix;
  return matrix.map((row) => row.map((code) => (code ? mapping.get(code) ?? code : code)));
}
