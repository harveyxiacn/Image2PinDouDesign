// 按库存换色的“落盘”部分：用新颜色重画预览图、写回图纸。纯逻辑在 lib/recolor.ts。
import { getHighResolutionCellSize, renderDesignToBlob } from "@engine/rendering";
import type { BeadDesign } from "@engine/types";
import { putRecords } from "../../lib/db";
import { saveImage } from "../../lib/images";
import { previewCellSize } from "../../lib/generate";
import type { Pattern } from "../../lib/model";
import { PALETTE } from "../../lib/palette";
import { applyRecolor, type RecolorMode, type RecolorPlan } from "../../lib/recolor";

/** 换色后的整条图纸（还没写入）。只要图纸存了格子，就用新颜色画一张预览图（原来没有预览图的识别图纸也画，图库缩略图才会跟着变）；
 *  画失败就保留旧图并返回 stale = true。只有用量、没有格子的图纸画不了，不算失败。 */
export async function buildRecolored(pattern: Pattern, plan: RecolorPlan, mode: RecolorMode): Promise<{ next: Pattern; stale: boolean }> {
  let preview: { previewId: string } | undefined;
  let stale = false;
  const drawable = !!plan.newMatrix && !!pattern.width && !!pattern.height;
  if (pattern.previewId || drawable) {
    try {
      if (!plan.newMatrix || !pattern.width || !pattern.height) throw new Error("no matrix");
      const design: BeadDesign = { id: pattern.id, fileName: "", boardWidth: pattern.width, boardHeight: pattern.height, matrix: plan.newMatrix, colorCounts: plan.newCounts };
      const cell = previewCellSize(design, getHighResolutionCellSize(design));
      const blob = await renderDesignToBlob(design, PALETTE, { cellSize: cell, showLabels: cell >= 13, boardLineEvery: 10 });
      const meta = await saveImage(blob, `${pattern.name}-图纸.png`, "preview");
      preview = { previewId: meta.id };
    } catch { stale = true; }
  }
  return { next: { ...pattern, ...applyRecolor(pattern, plan, mode, Date.now(), preview) } as Pattern, stale };
}

export async function saveRecolored(list: Pattern[]): Promise<void> {
  await putRecords("patterns", list);
}
