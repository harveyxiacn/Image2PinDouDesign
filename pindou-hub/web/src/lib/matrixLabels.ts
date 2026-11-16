// 拼豆图格子里的色号文字：什么时候画、多大、黑还是白。纯函数，方便单测。

/** 能看清的最小字号（屏幕像素）。 */
export const LABEL_MIN_FONT = 9;

/** 按格子大小与色号长度（A1 / A12 / ZG1）算字号，宽度不超过格子。 */
export function labelFontPx(cellPx: number, textLength: number): number {
  const len = Math.max(2, textLength);
  const byHeight = cellPx * 0.6;
  const byWidth = (cellPx - 2) / (len * 0.62);
  return Math.max(7, Math.min(24, Math.floor(Math.min(byHeight, byWidth))));
}

/** 色号有 textLength 个字符时，能把字号做到 LABEL_MIN_FONT 以上的最小格子（屏幕像素）：2 字 15、3 字 19、4 字 23。 */
export function labelMinCell(textLength = 2): number {
  for (let c = 6; c < 200; c += 1) if (labelFontPx(c, textLength) >= LABEL_MIN_FONT) return c;
  return 200;
}

/** 两个字符的色号（A1）所需的最小格子；H17 这样三个字符的用 labelMinCell(3)。 */
export const LABEL_MIN_CELL = labelMinCell(2);

/** 格子够不够大，画得下 textLength 个字符的色号（不传按 2 个字符）。太小就不画（看不清，还拖慢重绘）。 */
export function labelsFit(cellPx: number, textLength = 2): boolean {
  return cellPx >= labelMinCell(textLength);
}

/** 图里最长的色号长度（至少 2）；用来决定“放大到能看清色号”要放大到多少。 */
export function longestCodeLength(matrix: ReadonlyArray<ReadonlyArray<string | null | undefined>>): number {
  let n = 2;
  for (const row of matrix) for (const code of row) if (code && code.length > n) n = code.length;
  return n;
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
