// 整体可信度的封顶规则。拆成纯函数，便于单测，也避免 assistant 里一处改动影响所有分支。
import type { AnalyzeResult } from "./types";

/** 图例 / 网格的两份数量是否在容差内（与 reconcile 的 near 同一口径：较大值的 3%，至少 2 颗）。 */
export function countsNear(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(2, Math.round(0.03 * Math.max(a, b)));
}

/** 图例和网格双方都读到数字、且不完全相等的色号数（图例漏读后由网格补上的不算）。 */
export function comparableLegendDiffCount(diff: AnalyzeResult["diff"]): number {
  return diff.filter((d) => d.legend > 0 && d.grid > 0 && d.legend !== d.grid).length;
}

/** 上述差异中有实质差异的色号数；容差内的少量读数字差不算硬问题。 */
export function materialLegendDiffCount(diff: AnalyzeResult["diff"]): number {
  return diff.filter((d) => d.legend > 0 && d.grid > 0 && d.legend !== d.grid && !countsNear(d.legend, d.grid)).length;
}

export type ConfidenceInput = {
  /** 进入封顶前的可信度 */
  confidence: number;
  capacityBad: boolean;
  headerBad: boolean;
  sizeBad: boolean;
  /** 图例与网格双方都有数、但不完全相等的色号数（含容差内） */
  comparableDiffs: number;
  /** 其中超出容差、算实质差异的色号数 */
  materialDiffs: number;
  paletteWarning?: string | null;
  cellCoverage: number;
  /** 图例条目足够多、本次确实用了图例 */
  legendUsed: boolean;
  /** 网格读数是否存在 */
  reading: boolean;
};

/**
 * 有任何实质疑点 → 最高 69%；没有实质疑点但证据不完整（格内色号覆盖 < 90% / 没有图例 / 没有网格）
 * → 最高 99%；证据完整且无实质疑点才允许 100%。容差内的少量图例/网格差不再触发 69% 封顶。
 */
export function capOverallConfidence(input: ConfidenceInput): number {
  const { confidence, capacityBad, headerBad, sizeBad, comparableDiffs, materialDiffs, paletteWarning, cellCoverage, legendUsed, reading } = input;
  let out = confidence;
  if (capacityBad || headerBad || sizeBad || materialDiffs > 0 || paletteWarning) {
    out = Math.min(out, 0.69);
  } else if (comparableDiffs > 0 || !(cellCoverage >= 0.9 && legendUsed && reading)) {
    // 容差内的差异不再是“硬问题”，但也不配 100%（100% 只留给逐颗完全一致的图纸）。
    out = Math.min(out, 0.99);
  }
  return Math.max(0, Math.min(1, out));
}
