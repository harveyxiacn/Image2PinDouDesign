// 图库详情页“编辑格子”保存时要写回的字段（纯函数，便于单测）。
import { encodeMatrix, type Matrix } from "./matrix";
import { countsEqual, matrixDiffCount } from "./matrixEdit";
import type { Counts, Pattern } from "./model";

const EDIT_REASON = /^已手动修改 \d+ 格/;

/**
 * 编辑结果 → Pattern 补丁。没有任何改动时返回 null。
 *  - 老记录存的是 matrix（未压缩），继续写 matrix；新记录写 matrixRle；
 *  - 用量用编辑器里按格子增减后的 counts；
 *  - 手改后不再算“已核对”，置信度记 1（与识别页手改一致），颜色匹配度作废；
 *  - 自动检查的提示里保留旧原因，只替换旧的“已手动修改 N 格”。
 */
export function editedPatternPatch(
  pattern: Pick<Pattern, "matrix" | "matrixRle" | "counts" | "reviewReasons">,
  original: Matrix,
  edited: Matrix,
  counts: Counts
): Partial<Pattern> | null {
  const changed = matrixDiffCount(original, edited);
  if (!changed && countsEqual(pattern.counts, counts)) return null;
  const kept = (pattern.reviewReasons ?? []).filter((r) => !EDIT_REASON.test(r));
  const reasons = changed ? [`已手动修改 ${changed} 格`, ...kept] : kept;
  const patch: Partial<Pattern> = {
    counts,
    verifiedAt: undefined,
    confidence: 1,
    colorMatch: undefined,
    reviewReasons: reasons.length ? reasons : undefined
  };
  if (pattern.matrix?.length) patch.matrix = edited;
  else patch.matrixRle = encodeMatrix(edited);
  return patch;
}
