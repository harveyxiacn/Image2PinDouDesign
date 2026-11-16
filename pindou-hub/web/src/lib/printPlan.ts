// 分板打印的纯逻辑：页面清单、每板用量、范围选择、镜像坐标、纸张排版、字色与符号。
// 不依赖 React / DOM，方便单测。分板直接复用 lib/build.ts 的 splitBoards（只读），板号 = board.index + 1。
import { boardColors, compareCodes, splitBoards, type Board, type ColorCount } from "./build";
import type { Matrix } from "./matrix";
import { labelTextColor } from "./matrixLabels";

export type PrintStyle = "fill" | "code" | "symbol";
export type PaperSize = "a4" | "letter";
export type Orientation = "portrait" | "landscape";
export type PrintScope = "all" | "range";

export type PrintOptions = {
  boardSize: number; // 0 = 整张图一块板
  scope: PrintScope;
  rangeText: string;
  overview: boolean;
  style: PrintStyle;
  paper: PaperSize;
  orientation: Orientation;
  mirror: boolean;
};

export const PRINT_BOARD_SIZES = [15, 20, 29, 36, 52, 58, 0] as const;

export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  boardSize: 29, scope: "all", rangeText: "", overview: true, style: "fill", paper: "a4", orientation: "portrait", mirror: false
};

export type PlanBoard = {
  board: Board;
  /** 板号，从 1 起，与拼装模式一致（按行优先）。 */
  number: number;
  /** 行-列，如 “2-3”。 */
  label: string;
  counts: ColorCount[];
  total: number;
};

export type PrintPlan = {
  allBoards: Board[];
  /** 要打印的非空板（已按范围筛选）。 */
  boards: PlanBoard[];
  /** 被跳过的空板板号。 */
  skippedEmpty: number[];
  /** 整张图的用量（颗数多的在前）。 */
  totals: ColorCount[];
  total: number;
  boardCols: number;
  boardRows: number;
  rangeError?: string;
};

export function boardLabel(board: Board): string {
  return `${board.row + 1}-${board.col + 1}`;
}

/** “2-5, 8,10-” → 板号集合（1 起，最大 max）。写错的片段会被忽略并返回 error。 */
export function parseRange(text: string, max: number): { numbers: number[]; error?: string } {
  const set = new Set<number>();
  let bad = false;
  const parts = text.normalize("NFKC").replace(/[，、;；\s]+/g, ",").replace(/[~～—–－]/g, "-").split(",").filter(Boolean);
  for (const part of parts) {
    const m = /^(\d*)-(\d*)$/.exec(part) ?? /^(\d+)$/.exec(part);
    if (!m) { bad = true; continue; }
    let a: number; let b: number;
    if (m.length === 2) { a = b = Number(m[1]); } else {
      if (!m[1] && !m[2]) { bad = true; continue; }
      a = m[1] ? Number(m[1]) : 1;
      b = m[2] ? Number(m[2]) : max;
    }
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > max) bad = true;
    for (let n = Math.max(1, a); n <= Math.min(max, b); n += 1) set.add(n);
  }
  const numbers = [...set].sort((x, y) => x - y);
  return { numbers, error: bad ? "范围里有无法识别或超出板数的部分，已忽略" : undefined };
}

/** 生成打印页面清单。rangeText 为 undefined 表示全部板；空板不出页。 */
export function planPrint(matrix: Matrix, width: number, height: number, boardSize: number, rangeText?: string): PrintPlan {
  const allBoards = splitBoards(width, height, boardSize);
  const boardCols = allBoards.length ? Math.max(...allBoards.map((b) => b.col)) + 1 : 0;
  const boardRows = allBoards.length ? Math.max(...allBoards.map((b) => b.row)) + 1 : 0;
  let wanted: Set<number> | null = null;
  let rangeError: string | undefined;
  if (rangeText !== undefined) {
    const r = parseRange(rangeText, allBoards.length);
    wanted = new Set(r.numbers);
    rangeError = r.error;
  }
  const boards: PlanBoard[] = [];
  const skippedEmpty: number[] = [];
  const totalMap = new Map<string, number>();
  for (const board of allBoards) {
    const counts = boardColors(matrix, board);
    const total = counts.reduce((s, c) => s + c.count, 0);
    for (const c of counts) totalMap.set(c.code, (totalMap.get(c.code) ?? 0) + c.count);
    const number = board.index + 1;
    if (wanted && !wanted.has(number)) continue;
    if (!total) { skippedEmpty.push(number); continue; }
    boards.push({ board, number, label: boardLabel(board), counts, total });
  }
  const totals = [...totalMap].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || compareCodes(a.code, b.code));
  return { allBoards, boards, skippedEmpty, totals, total: totals.reduce((s, c) => s + c.count, 0), boardCols, boardRows, rangeError };
}

/** 纸面第 i 列显示的是板内第几列（镜像时左右反过来）。 */
export function displayColumns(w: number, mirror: boolean): number[] {
  const out = Array.from({ length: w }, (_, i) => i);
  return mirror ? out.reverse() : out;
}

/** 边上的列号（板内 1 起；镜像时从大到小）。 */
export function axisLabels(w: number, mirror: boolean): number[] {
  return displayColumns(w, mirror).map((x) => x + 1);
}

/** 纸面上第 d 条竖线（0..w）是否是“每 5 格”的粗线：按板内从左数的格数算，镜像后仍对应真实板的 5 的倍数。 */
export function heavyBoundaries(w: number, mirror: boolean): boolean[] {
  return Array.from({ length: w + 1 }, (_, d) => { const b = mirror ? w - d : d; return b > 0 && b < w && b % 5 === 0; });
}
export function heavyRows(h: number): boolean[] {
  return Array.from({ length: h + 1 }, (_, b) => b > 0 && b < h && b % 5 === 0);
}

/** 整图上板的纸面列位置（镜像时板的列也左右反过来）。 */
export function displayBoardCol(col: number, boardCols: number, mirror: boolean): number {
  return mirror ? boardCols - 1 - col : col;
}

export function textColorFor(hex: string | undefined, style: PrintStyle): string {
  // 只印色号 / 符号的样式没有底色，一律黑字；有底色按亮度选黑白
  return style === "fill" ? labelTextColor(hex) : "#111111";
}

// ---------- 符号：形状 × 填充 × 角标，一个色号一个，不会重复 ----------
// 用矢量图形而不是字体符号：黑白打印、小格子里也清楚，不依赖字体。图形都画在 10×10 的格子里，格子里留边。
export type SymbolFill = "solid" | "hollow" | "dot" | "slash";
export type SymbolSpec = { shape: number; fill: SymbolFill; mark: number };

function starPath(): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? 4.6 : 1.9;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${i ? "L" : "M"}${(5 + r * Math.cos(a)).toFixed(2)} ${(5.4 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `${pts.join("")}Z`;
}

/** 10 种外形：圆、方、四个方向的三角、菱形、加号、叉、星。 */
export const SYMBOL_SHAPES: readonly string[] = [
  "M1.4 5A3.6 3.6 0 1 1 8.6 5A3.6 3.6 0 1 1 1.4 5Z",
  "M1.6 1.6H8.4V8.4H1.6Z",
  "M5 1.4L8.9 8.4H1.1Z",
  "M1.1 1.6H8.9L5 8.6Z",
  "M1.4 5L8.4 1.1V8.9Z",
  "M8.6 5L1.6 1.1V8.9Z",
  "M5 1L9 5L5 9L1 5Z",
  "M3.9 1.4H6.1V3.9H8.6V6.1H6.1V8.6H3.9V6.1H1.4V3.9H3.9Z",
  "M2.3 1.2L5 3.9L7.7 1.2L8.8 2.3L6.1 5L8.8 7.7L7.7 8.8L5 6.1L2.3 8.8L1.2 7.7L3.9 5L1.2 2.3Z",
  starPath()
];
export const SYMBOL_FILLS: readonly SymbolFill[] = ["solid", "hollow", "dot", "slash"];
/** 角标：格子角上的小黑点（0 = 没有）。形状×填充用完（颗数最少的那些色）才会用到。 */
export const SYMBOL_MARKS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [], [[0.7, 0.7]], [[9.3, 0.7]], [[0.7, 9.3]], [[9.3, 9.3]], [[0.7, 0.7], [9.3, 9.3]], [[9.3, 0.7], [0.7, 9.3]], [[0.7, 0.7], [9.3, 0.7]], [[0.7, 9.3], [9.3, 9.3]]
];
export const SYMBOL_CAPACITY = SYMBOL_SHAPES.length * SYMBOL_FILLS.length * SYMBOL_MARKS.length;

/** 第 i 个符号：先把“实心 / 空心 / 带点 / 带斜线”的 10 种外形用完，再加角标。超出容量返回 undefined（几乎不会发生）。 */
export function symbolSpec(i: number): SymbolSpec | undefined {
  if (!Number.isInteger(i) || i < 0 || i >= SYMBOL_CAPACITY) return undefined;
  const per = SYMBOL_SHAPES.length * SYMBOL_FILLS.length;
  const j = i % per;
  return { mark: Math.floor(i / per), fill: SYMBOL_FILLS[Math.floor(j / SYMBOL_SHAPES.length)], shape: j % SYMBOL_SHAPES.length };
}

/** 符号表：按整图颗数从多到少依次分配（totals 已排好序），每个色号一个、互不相同；值是符号序号，用 symbolSpec 取图形。同一张图纸每次结果一样。 */
export function symbolMap(totals: ColorCount[]): Map<string, string> {
  const map = new Map<string, string>();
  totals.forEach((c, i) => { if (i < SYMBOL_CAPACITY) map.set(c.code, String(i)); });
  return map;
}

const PAPER_MM: Record<PaperSize, [number, number]> = { a4: [210, 297], letter: [215.9, 279.4] };
export const PAGE_MARGIN_MM = 10;
const HEADER_MM = 16;
const AXIS_MM = 6;
const MAX_CELL_MM = 10;

export type Layout = {
  pageW: number; pageH: number; margin: number;
  cellMm: number; gridW: number; gridH: number;
  /** 横向纸张时右侧放小地图与用量，纵向放在图下面。 */
  side: boolean;
};

export function pageMm(paper: PaperSize, orientation: Orientation): { w: number; h: number } {
  const [w, h] = PAPER_MM[paper];
  return orientation === "landscape" ? { w: h, h: w } : { w, h };
}

/** 一块板在一页里的格子大小（毫米）：纵向图在上、信息在下；横向图在左、信息在右。 */
export function boardLayout(paper: PaperSize, orientation: Orientation, w: number, h: number): Layout {
  const { w: pageW, h: pageH } = pageMm(paper, orientation);
  const side = orientation === "landscape";
  const innerW = pageW - 2 * PAGE_MARGIN_MM - AXIS_MM;
  const innerH = pageH - 2 * PAGE_MARGIN_MM - HEADER_MM - AXIS_MM;
  const availW = side ? innerW - 72 : innerW;
  const availH = side ? innerH : innerH - 62;
  const cellMm = Math.max(1, Math.min(MAX_CELL_MM, availW / Math.max(1, w), availH / Math.max(1, h)));
  return { pageW, pageH, margin: PAGE_MARGIN_MM, cellMm, gridW: cellMm * w, gridH: cellMm * h, side };
}

/** 总览页里整张图的格子大小（毫米），给图例留出下半页。 */
export function overviewLayout(paper: PaperSize, orientation: Orientation, w: number, h: number): Layout {
  const { w: pageW, h: pageH } = pageMm(paper, orientation);
  const availW = pageW - 2 * PAGE_MARGIN_MM;
  const availH = (pageH - 2 * PAGE_MARGIN_MM - HEADER_MM) * (orientation === "landscape" ? 0.62 : 0.6);
  const cellMm = Math.max(0.5, Math.min(MAX_CELL_MM, availW / Math.max(1, w), availH / Math.max(1, h)));
  return { pageW, pageH, margin: PAGE_MARGIN_MM, cellMm, gridW: cellMm * w, gridH: cellMm * h, side: false };
}

/** 页数（总览 + 图例续页 + 每块非空板），供界面显示。 */
export function pageCount(plan: PrintPlan, overview: boolean, legendExtraPages = 0): number {
  return plan.boards.length + (overview ? 1 + legendExtraPages : 0);
}

// ---------- 图例分页 ----------
// 总览页上半是整张图，下半放图例；颜色多了放不下就接到后面的“图例（续）”页，不让它溢出到第二张纸上。
const LEGEND_COL_MM = 44;
const LEGEND_GAP_MM = 3;
const LEGEND_ROW_MM = 5.4; // 一行：4mm 色块 + 行距，留足余量
const LEGEND_HEAD_MM = 20; // 页眉（标题 + 最多两行说明）
const LEGEND_TITLE_MM = 6;

export type LegendCapacity = { cols: number; firstRows: number; restRows: number; first: number; rest: number };

/** 总览页（图占 gridH 毫米高）和续页各能放多少条图例。 */
export function legendCapacity(paper: PaperSize, orientation: Orientation, gridH: number): LegendCapacity {
  const { w, h } = pageMm(paper, orientation);
  const contentW = w - 2 * PAGE_MARGIN_MM;
  const contentH = h - 2 * PAGE_MARGIN_MM - 1;
  const cols = Math.max(1, Math.floor((contentW + LEGEND_GAP_MM) / (LEGEND_COL_MM + LEGEND_GAP_MM)));
  const firstRows = Math.max(0, Math.floor((contentH - LEGEND_HEAD_MM - gridH - 2 * 3 - LEGEND_TITLE_MM) / LEGEND_ROW_MM));
  const restRows = Math.max(1, Math.floor((contentH - LEGEND_HEAD_MM - LEGEND_TITLE_MM) / LEGEND_ROW_MM));
  return { cols, firstRows, restRows, first: firstRows * cols, rest: restRows * cols };
}

/** 图例按页切开：第一段在总览页（可能是空的），其余是续页。 */
export function paginateLegend<T>(items: T[], cap: LegendCapacity): T[][] {
  const pages: T[][] = [items.slice(0, cap.first)];
  for (let i = cap.first; i < items.length; i += cap.rest) pages.push(items.slice(i, i + cap.rest));
  return pages;
}

// ---------- 格子太小时换小一点的板 ----------
/** 格子小于这个尺寸，色号印出来看不清。 */
export const MIN_CODE_CELL_MM = 3.2;
/** 符号比文字能缩得更小。 */
export const MIN_SYMBOL_CELL_MM = 2.2;

/** 按这个板大小，一页上一格是多少毫米。 */
export function cellMmFor(paper: PaperSize, orientation: Orientation, width: number, height: number, boardSize: number): number {
  const w = boardSize > 0 ? Math.min(boardSize, width) : width;
  const h = boardSize > 0 ? Math.min(boardSize, height) : height;
  return boardLayout(paper, orientation, w, h).cellMm;
}

/** 当前板大小下格子偏小时，挑能让格子不小于 minMm 的最大板；都不行就用最小的。不偏小返回 null。 */
export function suggestBoardSize(paper: PaperSize, orientation: Orientation, width: number, height: number, boardSize: number, minMm = MIN_CODE_CELL_MM): { size: number; cellMm: number; fromMm: number } | null {
  const fromMm = cellMmFor(paper, orientation, width, height, boardSize);
  if (fromMm >= minMm) return null;
  const sizes = PRINT_BOARD_SIZES.filter((s) => s > 0).sort((a, b) => b - a);
  const pick = sizes.find((s) => cellMmFor(paper, orientation, width, height, s) >= minMm) ?? sizes[sizes.length - 1];
  const cellMm = cellMmFor(paper, orientation, width, height, pick);
  if (cellMm <= fromMm) return null; // 已经是最小的板了，再换也没用
  return { size: pick, cellMm, fromMm };
}
