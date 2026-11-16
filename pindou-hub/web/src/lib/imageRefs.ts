// 图库里的图片是按内容哈希存的：同一张图可能被几处引用（图纸原图、预览、成品照片，甚至两张图纸共用）。
// 清理前必须确认没有任何地方还在用它。纯逻辑，不碰存储。
import type { ImageMeta, Pattern } from "./model";

/** 所有图纸（包括已删除、可能被撤销恢复的）引用到的图片 id。 */
export function referencedImageIds(patterns: Array<Pick<Pattern, "imageId" | "previewId" | "works">>): Set<string> {
  const out = new Set<string>();
  for (const p of patterns) {
    if (p.imageId) out.add(p.imageId);
    if (p.previewId) out.add(p.previewId);
    for (const w of p.works ?? []) if (w && typeof w.photoId === "string" && w.photoId) out.add(w.photoId);
  }
  return out;
}

/**
 * 候选里可以安全清理的图片：没人引用，且图库里确实有这条记录（没有就无从清理）。
 * 只清成品照片这类 role=source 的图：预览图由图纸生成流程管理，不在这里动。
 */
export function unusedImageIds(candidates: Array<string | undefined>, patterns: Array<Pick<Pattern, "imageId" | "previewId" | "works">>, images: Array<Pick<ImageMeta, "id" | "role" | "deleted">>): string[] {
  const refs = referencedImageIds(patterns);
  const meta = new Map(images.filter((m) => !m.deleted).map((m) => [m.id, m]));
  const out = new Set<string>();
  for (const id of candidates) {
    if (!id || refs.has(id)) continue;
    const m = meta.get(id);
    if (m && m.role === "source") out.add(id);
  }
  return [...out];
}
