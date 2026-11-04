// 缩放平移的纯函数（可单测）。视图 = { s: 相对“适应宽度”的倍数, x/y: 相对容器中心的平移（像素） }。
export type View = { s: number; x: number; y: number };

/** 一个图像像素最多放大到这么多屏幕像素（够看清格内印的色号） */
export const PX_TARGET = 24;
export const ABS_MAX = 96;
export const MIN_MAX = 8;

/** 缩放范围：min 不高于 1（图比容器小时允许缩到 1:1 以下不必要，这里保持适应=1）；max 由图片自然宽度决定 */
export function limits(boxW: number, natW?: number): { min: number; max: number; actual: number } {
  const actual = natW && boxW ? natW / boxW : 1; // 1:1（实际像素）对应的倍数
  const max = natW && boxW ? Math.max(MIN_MAX, Math.min(ABS_MAX, (PX_TARGET * natW) / boxW)) : MIN_MAX;
  return { min: Math.min(1, actual), max: Math.max(max, actual), actual };
}

export function clampView(v: View, boxW: number, boxH: number, lim: { min: number; max: number }): View {
  const s = Math.max(lim.min, Math.min(lim.max, v.s));
  if (s <= 1) return { s, x: 0, y: 0 };
  const mx = ((s - 1) * boxW) / 2, my = ((s - 1) * boxH) / 2;
  return { s, x: Math.max(-mx, Math.min(mx, v.x)), y: Math.max(-my, Math.min(my, v.y)) };
}

/** 围绕容器内某点（相对容器中心）缩放到 ns；该点下的图像内容保持不动 */
export function zoomAt(from: View, ns: number, cx: number, cy: number, boxW: number, boxH: number, lim: { min: number; max: number }): View {
  const s = Math.max(lim.min, Math.min(lim.max, ns));
  const k = s / from.s;
  return clampView({ s, x: cx - (cx - from.x) * k, y: cy - (cy - from.y) * k }, boxW, boxH, lim);
}

/** 当前屏幕上每个图像像素占多少屏幕像素 */
export function pxPerImagePx(s: number, boxW: number, natW?: number): number {
  return natW ? (s * boxW) / natW : s;
}

/** 屏幕点（相对容器中心）→ 内容比例坐标 0–1 */
export function toFraction(v: View, px: number, py: number, boxW: number, boxH: number): { fx: number; fy: number } {
  return { fx: (px - v.x) / (boxW * v.s) + 0.5, fy: (py - v.y) / (boxH * v.s) + 0.5 };
}

/** 双击：已放大则回到适应；否则以该点放大到 target 倍（受上限约束） */
export function doubleTapTarget(cur: View, target: number): number {
  return cur.s > 1.15 ? 1 : target;
}

/** 缩略图里当前可视区域（0–1 比例） */
export function viewportRect(v: View, boxW: number, boxH: number): { l: number; t: number; w: number; h: number } {
  const ws = boxW * v.s, hs = boxH * v.s;
  const w = Math.min(1, boxW / ws), h = Math.min(1, boxH / hs);
  const l = Math.max(0, Math.min(1 - w, (ws / 2 - boxW / 2 - v.x) / ws));
  const t = Math.max(0, Math.min(1 - h, (hs / 2 - boxH / 2 - v.y) / hs));
  return { l, t, w, h };
}
