// 拼豆图格子里的色号文字：什么时候画、多大、黑还是白。纯函数，方便单测。

/** 格子小于这个屏幕像素就不画色号（太小看不清，还会拖慢重绘）。 */
export const LABEL_MIN_CELL = 14;

export function labelsFit(cellPx: number): boolean {
  return cellPx >= LABEL_MIN_CELL;
}

/** 按格子大小与色号长度（A1 / A12 / ZG1）算字号，宽度不超过格子。 */
export function labelFontPx(cellPx: number, textLength: number): number {
  const len = Math.max(2, textLength);
  const byHeight = cellPx * 0.5;
  const byWidth = (cellPx - 2) / (len * 0.62);
  return Math.max(7, Math.min(24, Math.floor(Math.min(byHeight, byWidth))));
}

/** 按底色亮度选黑 / 白字，保证对比度。 */
export function labelTextColor(hex: string | undefined): "#111827" | "#ffffff" {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return "#111827";
  const n = parseInt(m[1], 16);
  const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // 与白字的对比度 (1.05)/(L+0.05) 对比黑字的 (L+0.05)/0.05：白字更清楚时用白字
  return 1.05 / (L + 0.05) > (L + 0.05) / 0.05 ? "#ffffff" : "#111827";
}
