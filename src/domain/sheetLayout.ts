// 图纸（预览与导出长图）的纯布局计算：不依赖 Canvas，便于单测。

/** 画布内绘制色号的最小格宽（像素）；更小的格子里字太挤，直接不画。 */
export const MIN_LABEL_CELL = 13;
/** 屏幕上（CSS 像素）格子至少这么宽，色号才算看得清。 */
export const MIN_READABLE_SCREEN_CELL = 18;

const MONO_CHAR_RATIO = 0.62;

export function shouldDrawLabels(cell: number): boolean {
  return cell >= MIN_LABEL_CELL;
}

/** 格内色号字号：优先 0.5 倍格宽，3 位及以上的色号收窄到刚好放进格子（留 7% 边距）。 */
export function labelFontSize(cell: number, codeLength: number): number {
  const length = Math.max(1, codeLength);
  const fit = (cell * 0.86) / (length * MONO_CHAR_RATIO);
  return Math.max(8, Math.floor(Math.min(cell * 0.5, fit)));
}

/** 屏幕上的格宽 = 画布内格宽 × 显示倍率。 */
export function labelsReadableOnScreen(cell: number, displayScale: number): boolean {
  return cell * displayScale >= MIN_READABLE_SCREEN_CELL;
}

/** 让格子在屏幕上达到可读宽度所需的缩放倍率（0.05 为步长向上取整，至少 1）。 */
export function zoomForReadableLabels(cell: number): number {
  if (!(cell > 0)) return 1;
  return Math.max(1, Math.ceil((MIN_READABLE_SCREEN_CELL / cell) * 20) / 20);
}

export type GridLineKind = "thin" | "five" | "ten" | "board" | "frame";

/** 第 index 条竖/横线（0..total，0 和 total 为外框）属于哪一类。 */
export function gridLineKind(index: number, total: number, boardEvery: number): GridLineKind {
  if (index <= 0 || index >= total) return "frame";
  if (boardEvery >= 1 && index % boardEvery === 0) return "board";
  if (index % 10 === 0) return "ten";
  if (index % 5 === 0) return "five";
  return "thin";
}

export type LineStyle = { width: number; color: string };

/** 各类线的宽度（整数像素，随格宽缩放）与颜色。 */
export function gridLineStyle(kind: GridLineKind, cell: number): LineStyle {
  const five = Math.max(2, Math.round(cell / 16));
  switch (kind) {
    case "thin": return { width: 1, color: "#d5dbe3" };
    case "five": return { width: five, color: "#000000" };
    case "ten": return { width: five + 1, color: "#000000" };
    default: return { width: five + 2, color: "#000000" };
  }
}

/** 线条居中于格线位置，宽度取整后起点取整，保证清晰不发虚。 */
export function lineStart(position: number, width: number): number {
  return Math.round(position - width / 2);
}

/** 坐标尺数字是否加粗强调：第 1 个以及每 5 的倍数。 */
export function isEmphasisedIndex(oneBased: number): boolean {
  return oneBased === 1 || oneBased % 5 === 0;
}

/** 按色号排序：先字母系列，再数字大小（A2 < A10 < B1）。 */
export function compareColorCodes(a: string, b: string): number {
  const pa = /^([A-Za-z]*)(\d*)(.*)$/.exec(a) ?? [];
  const pb = /^([A-Za-z]*)(\d*)(.*)$/.exec(b) ?? [];
  const letters = (pa[1] ?? "").localeCompare(pb[1] ?? "");
  if (letters !== 0) return letters;
  const na = Number(pa[2] || -1);
  const nb = Number(pb[2] || -1);
  if (na !== nb) return na - nb;
  return a.localeCompare(b);
}

export type SheetLayoutInput = {
  boardWidth: number;
  boardHeight: number;
  cell: number;
  colorCount: number;
  /** 图例里最长的计数位数，默认 5。 */
  maxCountDigits?: number;
};

export type SheetLayout = {
  width: number;
  height: number;
  margin: number;
  ruler: number;
  titleFont: number;
  subtitleFont: number;
  header: number;
  gridLeft: number;
  gridTop: number;
  gridWidth: number;
  gridHeight: number;
  rulerFont: number;
  legend: {
    top: number;
    titleFont: number;
    font: number;
    swatch: number;
    entryWidth: number;
    entryHeight: number;
    columns: number;
    rows: number;
    entriesTop: number;
    totalTop: number;
  };
};

export const MIN_SHEET_WIDTH = 520;

/** 导出长图的整体布局：标题 → 四边坐标尺的网格 → 图例（色号 × 颗数）→ 合计行。 */
export function computeSheetLayout(input: SheetLayoutInput): SheetLayout {
  const { boardWidth, boardHeight, cell } = input;
  const colorCount = Math.max(0, input.colorCount);
  const margin = cell;
  const ruler = cell;
  const titleFont = Math.max(18, Math.round(cell * 0.75));
  const subtitleFont = Math.max(13, Math.round(cell * 0.48));
  const header = Math.round(Math.max(cell * 3, titleFont + subtitleFont + margin * 1.2));
  const gridWidth = boardWidth * cell;
  const gridHeight = boardHeight * cell;
  const width = Math.max(MIN_SHEET_WIDTH, gridWidth + (margin + ruler) * 2);
  const gridLeft = margin + ruler;
  const gridTop = header + ruler;

  const font = Math.max(13, Math.round(cell * 0.55));
  const legendTitleFont = Math.round(font * 1.05);
  const swatch = Math.round(font * 1.5);
  const entryHeight = Math.round(font * 2.1);
  const textChars = 4 + 3 + (input.maxCountDigits ?? 5);
  const entryWidth = Math.ceil(swatch + font * 0.6 + textChars * font * MONO_CHAR_RATIO + font);
  const columns = Math.max(1, Math.floor((width - margin * 2) / entryWidth));
  const rows = colorCount === 0 ? 0 : Math.ceil(colorCount / columns);
  const legendTop = gridTop + gridHeight + ruler + margin;
  const entriesTop = legendTop + Math.round(legendTitleFont * 2);
  const totalTop = entriesTop + rows * entryHeight + Math.round(font * 0.8);
  const height = totalTop + Math.round(font * 2) + margin;

  return {
    width, height, margin, ruler, titleFont, subtitleFont, header,
    gridLeft, gridTop, gridWidth, gridHeight,
    rulerFont: Math.max(10, Math.floor(cell * 0.4)),
    legend: { top: legendTop, titleFont: legendTitleFont, font, swatch, entryWidth, entryHeight, columns, rows, entriesTop, totalTop }
  };
}

export function sheetPixels(input: SheetLayoutInput): number {
  const layout = computeSheetLayout(input);
  return layout.width * layout.height;
}
