// “导出图纸 PNG”的准备工作：能不能导出、导出什么、叫什么名字。纯逻辑（不碰画布），方便单测。
import type { BeadDesign } from "@engine/types";
import type { Pattern } from "./model";
import type { Matrix } from "./matrix";
import { countMatrixColors } from "./matrixEdit";

/** 图纸上每隔多少格画一条粗线。图纸没有记录板子大小，按拼豆常见的 10 格一条。 */
export const SHEET_LINE_EVERY = 10;

/** 去掉文件名里不能用的字符（Windows / 安卓都不认），去不干净就用兜底名。 */
export function safeFileStem(name: string, fallback = "拼豆图纸"): string {
  // eslint-disable-next-line no-control-regex
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80).trim();
  return s || fallback;
}

export type SheetPlan =
  | { ok: true; design: BeadDesign; fileName: string; title: string; boardLineEvery: number }
  | { ok: false; reason: string };

/** 只有存了每一格颜色的图纸才能出图（matrix 用 matrixOf(pattern) 取，调用方通常已经解过码）；只有用量的图纸给出一句原因。 */
export function sheetPlan(pattern: Pick<Pattern, "id" | "name" | "width" | "height">, matrix: Matrix | undefined): SheetPlan {
  const w = pattern.width ?? 0, h = pattern.height ?? 0;
  if (!matrix || !w || !h || matrix.length !== h) return { ok: false, reason: "这张图纸只记了用量，没有每格的颜色，画不出图纸" };
  const stem = safeFileStem(pattern.name);
  const design: BeadDesign = {
    id: pattern.id,
    // 引擎把标题画在图头，并去掉最后一个“.xxx”扩展名：补一个 .png，名字里自带的点就不会被当成扩展名误删
    fileName: `${pattern.name.trim() || stem}.png`,
    boardWidth: w,
    boardHeight: h,
    matrix,
    // 底部色号统计按格子重数，保证图和统计一致（手动改过用量时也不会对不上）
    colorCounts: countMatrixColors(matrix)
  };
  return { ok: true, design, fileName: `${stem}-图纸.png`, title: pattern.name, boardLineEvery: SHEET_LINE_EVERY };
}
